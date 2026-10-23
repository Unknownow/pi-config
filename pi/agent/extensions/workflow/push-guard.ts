/**
 * Execute phase: refuses git commands that publish or skip the hooks. Pushing is the
 * workflow's job, after the judge passes; the executor may not push, force-push, push
 * to a protected branch, or commit (committing is the workflow's job too, and --no-verify never). Checked on the command text, so it
 * is a guardrail against a drifting executor, not a sandbox. Git commands that create a commit on their own
 * (merge, cherry-pick, revert, pull, rebase, am) are refused too unless they are told not to commit,
 * so no commit exists that the judge has not seen. It also refuses `gh` commands that
 * open or merge pull requests unless the flow's delivery allows them, and `gh pr merge --admin`
 * / `--auto` and `gh pr review --approve` always.
 */
import { gitSubcommand, KEYWORDS, parseCommands, WRAPPERS } from "./readonly-bash.ts";
import { fallbackTexts, repoTexts } from "./repos.ts";

export interface PushContext {
	/** The current branch; "HEAD" or "" on a detached HEAD. */
	branch: string;
	protectedBranches: string[];
	/** True only while the workflow's own commit-and-push instruction is running. */
	pushAllowed: boolean;
	/** True only while the workflow's commit step runs with a pull-request delivery (pr or merge). */
	prAllowed: boolean;
	/** True only while the workflow's commit step runs with the merge delivery. */
	mergeAllowed: boolean;
	/** True only while the workflow's commit step runs. */
	commitAllowed: boolean;
}

/** `a` is the long option `full` or an abbreviation of it, which git accepts. */
const isLong = (a: string, full: string) => {
	const opt = a.split("=")[0];
	return opt.length > 2 && full.startsWith(opt);
};
const shortHas = (a: string, letters: string) => /^-[a-zA-Z]+$/.test(a) && [...a.slice(1)].some((c) => letters.includes(c));

const FORCE_LONG = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune", "--no-verify"];

/** Why this shell text may not run in the execute phase, or null. */
export function pushProblem(command: string, o: PushContext): string | null {
	// GIT_CONFIG_* can switch hooks off without -c, however it is set (inline, env, export, $env:).
	if (/GIT_CONFIG/i.test(command) && /\bgit\b/i.test(command)) return "sets GIT_CONFIG_*, which can switch hooks off";
	for (const cmd of parseCommands(command)) {
		const problem = wordsProblem(cmd.words, o);
		if (problem) return problem;
	}
	return null;
}

export interface ShellGuard {
	/** The flow's repos; undefined means a single repo. */
	roots?: string[];
	cwd: string;
	protectedBranches: string[];
	branchOf(dir: string): Promise<string>;
	/** The delivery mode in force for a repo (undefined root: the working folder). */
	modeOf(root: string | undefined): string | undefined;
}

/** Why this shell text may not run, checking each command against the repo it runs in, or null. */
export async function shellProblem(text: string, powershell: boolean, g: ShellGuard): Promise<string | null> {
	// The config-env rule spans commands, so such a text is checked whole; otherwise each command against the repo it runs in.
	const groups = g.roots && !/GIT_CONFIG/i.test(text) ? repoTexts(text, g.roots, g.cwd, process.platform, { powershell }) : fallbackTexts(text, powershell).map((t) => ({ root: undefined, text: t }));
	for (const group of groups) {
		const branch = await g.branchOf(group.root ?? g.cwd);
		const mode = g.modeOf(group.root);
		const problem = pushProblem(group.text, {
			branch,
			protectedBranches: g.protectedBranches,
			pushAllowed: mode === "push" || mode === "pr" || mode === "merge",
			prAllowed: mode === "pr" || mode === "merge",
			mergeAllowed: mode === "merge",
			commitAllowed: mode !== undefined,
		});
		if (problem) return problem;
	}
	return null;
}

function commandName(word: string): string {
	return word.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
}

function wordsProblem(input: string[], o: PushContext): string | null {
	let words = input;
	while (words.length) {
		if (KEYWORDS.has(words[0]) || /^[A-Za-z_]\w*=/.test(words[0])) {
			words = words.slice(1);
			continue;
		}
		const name = commandName(words[0]);
		if (name in WRAPPERS) {
			const valued = WRAPPERS[name];
			let i = 1;
			while (i < words.length && (words[i].startsWith("-") || (name === "env" && /^[A-Za-z_]\w*=/.test(words[i])))) {
				i += valued.includes(words[i]) ? 2 : 1;
			}
			if (name === "timeout") i++;
			words = words.slice(i);
			continue;
		}
		break;
	}
	if (!words.length) return null;
	const name = commandName(words[0]);
	const args = words.slice(1);
	if (["bash", "sh", "zsh", "dash", "ksh"].includes(name) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[0] ?? "") && args[1] !== undefined) return pushProblem(args[1], o);
	if (name === "gh") return ghOnly(args, o);
	if (name !== "git") return null;
	const g = gitSubcommand(args);
	if (!g) return null;
	if (/^@|[$`]/.test(g.sub)) return "runs a git subcommand built at runtime";
	if (g.sub === "config" && g.rest.some((a) => /hookspath|include(if)?\./i.test(a))) return "changes where git looks for hooks";
	if (g.sub in COMMIT_CREATING) return commitCreatingOnly(g.sub, g.rest, o);
	if (g.sub !== "push" && g.sub !== "commit") return null;
	// Only the options before the subcommand: a commit message may mention hooksPath.
	if (args.slice(0, args.length - g.rest.length - 1).some((a) => /hookspath/i.test(a))) return "changes where git looks for hooks";
	return g.sub === "push" ? pushOnly(g.rest, o) : commitOnly(g.rest, o);
}

/** The subcommands that can create a commit without `git commit`, and the flag hint the refusal gives. */
const COMMIT_CREATING: Record<string, string> = {
	merge: "use --no-commit",
	"cherry-pick": "use -n",
	revert: "use -n",
	pull: "use --ff-only",
	rebase: "none is allowed during execution; ask for it in the plan",
	am: "none is allowed during execution; ask for it in the plan",
};

function commitCreatingOnly(sub: string, rest: string[], o: PushContext): string | null {
	if (rest.some((a) => isLong(a, "--no-verify"))) return `git ${sub} --no-verify skips the hooks`;
	if (o.commitAllowed) return null;
	const has = (full: string) => rest.some((a) => isLong(a, full));
	const stop = has("--abort") || has("--quit");
	let safe = false;
	if (sub === "merge") safe = stop || has("--no-commit") || has("--squash");
	else if (sub === "cherry-pick" || sub === "revert") safe = stop || has("--skip") || has("--no-commit") || rest.some((a) => shortHas(a, "n"));
	else if (sub === "pull") safe = has("--ff-only") || (has("--no-commit") && has("--no-rebase"));
	else safe = stop;
	if (safe && !has("--continue")) return null;
	return commitCreatingText(sub);
}

/** The refusal for a git subcommand that creates a commit no judge has seen. */
export function commitCreatingText(sub: string): string {
	return `git ${sub} creates a commit no judge has seen; ${COMMIT_CREATING[sub]}, and the workflow's commit step concludes it after the judge passes`;
}

function commitOnly(rest: string[], o: PushContext): string | null {
	if (rest.some((a) => isLong(a, "--no-verify") || shortHas(a, "n"))) return "git commit skips the hooks (--no-verify)";
	if (!o.commitAllowed) return "committing is the workflow's job; it commits after the judge passes";
	return null;
}

function pushOnly(rest: string[], o: PushContext): string | null {
	for (const a of rest) {
		if (a === "--") break;
		if (a.startsWith("--") && FORCE_LONG.some((f) => isLong(a, f))) return `git push ${a.split("=")[0]} is never allowed (force, delete, mirror, or skipping hooks)`;
		if (shortHas(a, "fd")) return "git push -f / -d is never allowed (force or delete)";
		if (isLong(a, "--all") || isLong(a, "--branches")) return "git push --all publishes every branch, including protected ones";
	}
	const positional = rest.filter((a) => !a.startsWith("-"));
	const refspecs = positional.slice(1);
	for (const spec of refspecs) {
		if (spec.startsWith("+")) return "git push with a +refspec forces the update";
		if (spec.startsWith(":")) return "git push with a :refspec deletes a remote branch";
		const dest = (spec.includes(":") ? spec.split(":")[1] : spec).replace(/^refs\/heads\//, "");
		if (o.protectedBranches.includes(dest)) return `git push to protected branch ${dest}`;
		if ((dest === "HEAD" || dest === "@") && o.protectedBranches.includes(o.branch)) return `git push HEAD while on protected branch ${o.branch}`;
	}
	if (refspecs.length === 0 && (!o.branch || o.branch === "HEAD" || o.protectedBranches.includes(o.branch))) {
		return `git push from ${o.branch || "a detached HEAD"} (protected or no branch)`;
	}
	if (!o.pushAllowed) return "pushing is the workflow's job; it pushes after the judge passes";
	return null;
}

/** gh: opening and merging pull requests is the workflow's job; --admin and approving are never allowed. */
function ghOnly(args: string[], o: PushContext): string | null {
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-R" || a === "--repo") i++;
		else if (!a.startsWith("-")) positional.push(a);
	}
	const [group, sub] = positional;
	if (group === "api") return ghApi(args.slice(args.indexOf("api") + 1), o);
	if (group !== "pr") return null;
	if (sub === "review" && args.some((a) => isLong(a, "--approve") || shortHas(a, "a"))) return "approving a pull request is never allowed";
	if (sub === "merge") {
		if (args.some((a) => isLong(a, "--admin"))) return "gh pr merge --admin bypasses the repo's branch rules";
		if (args.some((a) => isLong(a, "--auto"))) return "gh pr merge --auto is never used; the workflow merges after the checks pass";
		if (!o.mergeAllowed) return "merging a pull request is the workflow's job, when this flow's delivery includes merge";
	}
	if (sub === "create" && !o.prAllowed) return "opening a pull request is the workflow's job, when this flow's delivery includes one";
	return null;
}

function ghApi(rest: string[], o: PushContext): string | null {
	let method = "";
	let fields = false;
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a === "-X" || a === "--method") method = (rest[i + 1] ?? "").toUpperCase();
		else if (a.startsWith("--method=")) method = a.slice(9).toUpperCase();
		else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
		else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(field|raw-field|input)=/.test(a) || /^-[fF]./.test(a)) fields = true;
	}
	const text = rest.join(" ");
	if (/mergePullRequest|enablePullRequestAutoMerge/.test(text) && !o.mergeAllowed) return "merging a pull request through gh api is the workflow's job";
	if (/createPullRequest/.test(text) && !o.prAllowed) return "opening a pull request through gh api is the workflow's job";
	const effective = method || (fields ? "POST" : "GET");
	if (effective === "GET") return null;
	if (/(^|\/)pulls\/[^/\s]+\/merge\b/.test(text) && !o.mergeAllowed) return "merging a pull request through gh api is the workflow's job";
	if (/(^|\/)pulls\/?(?=\s|\?|$)/.test(text) && effective === "POST" && !o.prAllowed) return "opening a pull request through gh api is the workflow's job";
	return null;
}

const SEP = "[\\s,\"'`\\[\\]()]+";
const CODE_GIT = new RegExp("\\bgit\\b" + SEP + "(?:-[Cc]" + SEP + "[^\\s,\"'`\\[\\]()]+" + SEP + ")*(merge|cherry-pick|revert|rebase|pull|am)\\b(?!-)", "g");

/** Why non-shell code (a script run through run_code) may not run, or null: it spawns a git subcommand that creates a commit, without a flag that stops that. */
export function codeCommitProblem(code: string): string | null {
	for (const m of code.matchAll(CODE_GIT)) {
		const tail = code.slice(m.index + m[0].length, m.index + m[0].length + 200);
		const cut = tail.search(/[);\n&|]|\bgit\b/);
		const rest = (cut < 0 ? tail : tail.slice(0, cut)).split(/[\s,"'`\[\]();]+/).filter(Boolean);
		if (commitCreatingOnly(m[1], rest, { branch: "", protectedBranches: [], pushAllowed: false, prAllowed: false, mergeAllowed: false, commitAllowed: false })) return commitCreatingText(m[1]);
	}
	return null;
}

/** Why JavaScript run through run_code may not run in execute phase (it publishes, skips hooks or opens a PR), or null. */
export function codePublishProblem(code: string): string | null {
	if (/\bgit\b/.test(code) && /\bpush\b|(?<!-)\bcommit\b|--no-verify|hooksPath|GIT_CONFIG/i.test(code)) return "code that runs git push, skips hooks or changes hooks";
	const commit = codeCommitProblem(code);
	if (commit) return `code that runs ${commit}`;
	if (/\bgh\b/.test(code) && /\b(pr|api)\b/.test(code)) return "code that runs gh pr or gh api";
	return null;
}

const REGISTRY_WHAT = [
	{ re: /(?:^|[;&|("'`]\s*|\bsudo\s+|\bcall\s+)(?:\S*[\\/])?(?:npm|pnpm|yarn)(?:\.cmd)?["']?\s+(?:-\S+(?:\s+[^-\s]\S*)?\s+)*publish\b/i, what: "npm publish" },
	{ re: /\bupdates\.(?:bat|command|mjs)["']?\s+(?:-\S+\s+)*(?:publish|mirror)\b/i, what: "updates publish or mirror" },
	{ re: /\bmaintenance\.mjs["']?\s+(?:-\S+\s+)*mirror\b[^\n;&|]*--confirm/i, what: "maintenance.mjs mirror --confirm" },
	{ re: /\bnode(?:\.exe)?["']?\s+(?:-\S+\s+)*["']?\S*publish-package\.mjs/i, what: "publish-package.mjs" },
];

/** Why this command may not run in the execute phase: publishing and mirroring packages goes only through `publish_packages`. Null when it is fine (a `--dry-run` of update-packages.mjs is). */
export function registryPublishProblem(text: string): string | null {
	const reason = (what: string) => `${what}: publishing and mirroring run only through publish_packages with the plan's Publish:/Mirror: step`;
	for (const { re, what } of REGISTRY_WHAT) if (re.test(text)) return reason(what);
	for (const m of text.matchAll(/\bupdate-packages\.mjs["']?\s+((?:--?\S+\s+)*publish\b[^\n;&|]*)/gi)) {
		if (!/--dry-run\b/.test(m[1])) return reason("update-packages.mjs publish");
	}
	return null;
}

/** The same check for JavaScript run through run_code: a script that names a publish tool and a publish verb close together. */
export function registryPublishCodeProblem(code: string): string | null {
	if (/\b(?:npm|pnpm|yarn)(?:\.cmd)?\b[^\n]{0,60}\bpublish\b/i.test(code)) return "code that runs npm publish: publishing and mirroring run only through publish_packages with the plan's Publish:/Mirror: step";
	if (/\bpublish-package\.mjs/i.test(code)) return "code that runs publish-package.mjs: publishing and mirroring run only through publish_packages with the plan's Publish:/Mirror: step";
	for (const m of code.matchAll(/\b(?:update-packages|maintenance|updates)\.(?:mjs|bat|command)\b[^\n]{0,80}\b(?:publish|mirror)\b[^\n]{0,80}/gi)) {
		if (!/--dry-run/.test(m[0])) return "code that runs a publish or mirror: publishing and mirroring run only through publish_packages with the plan's Publish:/Mirror: step";
	}
	return null;
}
