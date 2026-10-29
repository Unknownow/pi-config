/**
 * Execute phase: refuses git commands that skip the hooks or publish beyond what the judge has seen.
 * Committing, pushing to a non-protected branch and opening pull requests are free. Merging a pull
 * request and pushing to a protected branch are handed to the caller's gate (a judge PASS on the exact
 * tree); force, delete and mirror pushes, --no-verify, config-env tricks, `gh pr merge --admin` / `--auto`
 * and `gh pr review --approve` are never allowed. Checked on the command text, so it is a guardrail
 * against a drifting executor, not a sandbox.
 */
import { gitSubcommand, KEYWORDS, parseCommands, WRAPPERS } from "./readonly-bash.ts";
import * as path from "node:path";
import { normalizeRemote } from "./plan-doc.ts";
import { fallbackTexts, repoKey, repoTexts } from "./repos.ts";

/** A command the pure check cannot decide: the caller's gate must (a merge, or a push to a protected branch). */
export interface GateRequest {
	/** "tag-check": a push whose destination may be a tag (`target` is the destination name); the guard's `isTag` decides. */
	/** "head-push": a push whose destination is the current branch; the guard only checks that no command before it on the line switches branch. */
	kind: "merge" | "protected-push" | "tag-check" | "head-push";
	/** For a merge: the pull request argument (number, URL or branch), or undefined for the current branch. For a push: the source ref. */
	target: string | undefined;
	/** For a merge: the `-R` / `--repo` the command names, if any. */
	repo?: string;
}

export interface PushContext {
	/** The current branch; "HEAD" or "" on a detached HEAD. */
	branch: string;
	protectedBranches: string[];
	/** Collects the commands that need the gate; when absent they are not checked here. */
	gates?: GateRequest[];
}

/** `a` is the long option `full` or an abbreviation of it, which git accepts. */
const isLong = (a: string, full: string) => {
	const opt = a.split("=")[0];
	return opt.length > 2 && full.startsWith(opt);
};
const shortHas = (a: string, letters: string) => /^-[a-zA-Z]+$/.test(a) && [...a.slice(1)].some((c) => letters.includes(c));

const FORCE_LONG = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune", "--no-verify"];

/** Why this shell text may not run in the execute phase, or null. */
export function pushProblem(command: string, given: PushContext): string | null {
	const o = given.gates ? given : { ...given, gates: [] };
	// GIT_CONFIG_* can switch hooks off without -c, however it is set (inline, env, export, $env:).
	if (/GIT_CONFIG/i.test(command) && /\bgit\b/i.test(command)) return "sets GIT_CONFIG_*, which can switch hooks off";
	const cmds = parseCommands(command);
	const gatedCmd: boolean[] = [];
	const headCmd: boolean[] = [];
	for (const cmd of cmds) {
		const seen = o.gates?.length ?? 0;
		const problem = wordsProblem(cmd.words, o);
		if (problem) return problem;
		const fresh = (o.gates ?? []).slice(seen);
		gatedCmd.push(fresh.some((g) => g.kind === "merge" || g.kind === "protected-push"));
		headCmd.push(fresh.some((g) => g.kind === "head-push"));
	}
	// A push to "the current branch" must not follow a command that switches it: the gate and the branch check read HEAD before the line runs.
	if (headCmd.some(Boolean) && cmds.some((c, i) => !headCmd[i] && changesBranch(c))) return SWITCHED;
	// The gate reads the tree before the command runs, so nothing that could change it may run in the same command line.
	if (gatedCmd.some(Boolean) && cmds.some((c, i) => !gatedCmd[i] && !siblingOk(c))) return CHAINED;
	return null;
}

/** Whether the text changes folder (cd, pushd, git -C, --git-dir, --work-tree) to somewhere outside `cwd`. */
function leavesWorkingFolder(text: string, cwd: string): boolean {
	if (/--git-dir|--work-tree/.test(text)) return true;
	const base = repoKey(cwd);
	for (const m of text.matchAll(/(?:^|[;&|(\s])(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)|\s-C\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
		const raw = (m[1] ?? m[2]).replace(/^["']|["']$/g, "");
		if (/^~|\$/.test(raw)) return true;
		const key = /^([/\\]|[A-Za-z]:)/.test(raw) ? repoKey(raw) : repoKey(path.resolve(cwd, raw));
		if (key !== base && !key.startsWith(base.endsWith("/") ? base : `${base}/`)) return true;
	}
	return false;
}

const ELSEWHERE = "a merge or a push to a protected branch must run in the working folder or in a folder of this flow, without cd, pushd or git -C to another place";
const REPO_UNKNOWN = "a merge with --repo must name a repo of this flow (its origin remote, else its first remote); run it in that repo's folder after the repo has joined the flow";
const SWITCHED = "a push to the current branch must be its own command after a branch switch (git switch, git checkout, gh pr merge ... change the branch the push goes to)";
const CHAINED = "a merge or a push to a protected branch must be its own command, run after everything it ships is committed and judged (not chained with commands that change files, commits or branches)";
const SAFE_GH_PR = new Set(["checks", "view", "status", "list", "diff", "merge"]);

/** Whether the command can change which branch HEAD is on. */
function changesBranch(cmd: { words: string[] }): boolean {
	const words = unwrap(cmd.words);
	if (!words.length) return false;
	const name = commandName(words[0]);
	const args = words.slice(1);
	if (["bash", "sh", "zsh", "dash", "ksh"].includes(name) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[0] ?? "")) return args[1] === undefined || parseCommands(args[1]).some(changesBranch);
	if (name === "git") {
		const g = gitSubcommand(args);
		if (!g) return false;
		if (["switch", "checkout", "rebase", "worktree"].includes(g.sub)) return true;
		if (g.sub === "symbolic-ref") return g.rest.filter((a) => !a.startsWith("-")).length >= 2;
		if (g.sub === "branch") return g.rest.some((a) => shortHas(a, "mM") || /^--move\b/.test(a));
		return /^@|[$`]/.test(g.sub);
	}
	if (name === "gh") {
		const positional = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-R" && args[i - 1] !== "--repo");
		return positional[0] === "pr" && (positional[1] === "merge" || positional[1] === "checkout");
	}
	return false;
}

/** Whether `git <sub> <rest>` only reads: no commit, branch, ref or config changes. */
function gitSiblingOk(sub: string, rest: string[]): boolean {
	const positional = rest.filter((a) => !a.startsWith("-"));
	switch (sub) {
		case "status":
		case "log":
		case "diff":
		case "show":
		case "rev-parse":
		case "ls-remote":
		case "show-ref":
		case "describe":
		case "cat-file":
		case "rev-list":
		case "merge-base":
			return true;
		case "fetch":
			return !rest.some((a) => a.includes(":"));
		case "symbolic-ref":
			return positional.length < 2;
		case "branch":
			return positional.length === 0 && !rest.some((a) => shortHas(a, "fmMcCdDu") || /^--(force|move|copy|delete|set-upstream|set-upstream-to|track|no-track|edit-description|unset-upstream)\b/.test(a));
		case "remote":
			return rest.length === 0 || ["-v", "show", "get-url"].includes(rest[0]);
		case "config":
			return rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
	}
	return false;
}

/** A command that may share a command line with a gated merge or push: it changes no files, commits or branches (waiting for checks, reading state, changing folder). */
function siblingOk(cmd: { words: string[]; writes: string[] }): boolean {
	if (cmd.writes.length) return false;
	const words = unwrap(cmd.words);
	if (!words.length) return true;
	const name = commandName(words[0]);
	const args = words.slice(1);
	if (["cd", "pushd", "popd", "true", ":"].includes(name)) return true;
	if (["bash", "sh", "zsh", "dash", "ksh"].includes(name) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[0] ?? "")) return args[1] !== undefined && parseCommands(args[1]).every(siblingOk);
	if (name === "git") {
		const g = gitSubcommand(args);
		return !!g && gitSiblingOk(g.sub, g.rest);
	}
	if (name === "gh") {
		const positional = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-R" && args[i - 1] !== "--repo");
		return positional[0] === "pr" && SAFE_GH_PR.has(positional[1]);
	}
	return false;
}

/** Whether a remote URL and a `--repo` argument name the same owner/name; the host and the case are ignored. */
export function repoMatches(remoteUrl: string, repoArg: string): boolean {
	const tail = (s: string) => normalizeRemote(s).split("/").filter(Boolean).slice(-2);
	const a = tail(remoteUrl);
	const b = tail(repoArg);
	return a.length === 2 && b.length === 2 && a[0].toLowerCase() === b[0].toLowerCase() && a[1].toLowerCase() === b[1].toLowerCase();
}

export interface ShellGuard {
	/** The flow's repos; undefined means a single repo. */
	roots?: string[];
	cwd: string;
	protectedBranches: string[];
	branchOf(dir: string): Promise<string>;
	/** Decides a merge or a push to a protected branch in a repo (undefined root: the working folder): a refusal, or null to allow. */
	gate(kind: "merge" | "protected-push", root: string | undefined, target: string | undefined, repo?: string): Promise<string | null>;
	/** Whether `name` is a tag in the repo (undefined root: the working folder). Without it, a push to a bare name is not checked for being a tag. */
	isTag?(root: string | undefined, name: string): Promise<boolean>;
	/** The root of the flow repo whose origin remote (else first remote) is the `--repo` a merge names, or null. Without it, `--repo` does not move the gate. */
	repoRoot?(repo: string): Promise<string | null>;
}

/** Why this shell text may not run, checking each command against the repo it runs in, or null. */
export async function shellProblem(text: string, powershell: boolean, g: ShellGuard): Promise<string | null> {
	// The config-env rule spans commands, so such a text is checked whole; otherwise each command against the repo it runs in.
	const groups = g.roots && !/GIT_CONFIG/i.test(text) ? repoTexts(text, g.roots, g.cwd, process.platform, { powershell }) : fallbackTexts(text, powershell).map((t) => ({ root: undefined, text: t }));
	for (const group of groups) {
		const branch = await g.branchOf(group.root ?? g.cwd);
		const gates: GateRequest[] = [];
		const problem = pushProblem(group.text, { branch, protectedBranches: g.protectedBranches, gates });
		if (problem) return problem;
		// Without a known root the gate reads the working folder, so a command that points elsewhere cannot be gated.
		if (group.root === undefined && gates.some((r) => r.kind === "merge" || r.kind === "protected-push") && leavesWorkingFolder(group.text, g.cwd)) return ELSEWHERE;
		for (const req of gates) {
			if (req.kind === "head-push") continue;
			if (req.kind === "tag-check") {
				if (g.isTag && req.target && (await g.isTag(group.root, req.target))) return TAG_PUSH;
				continue;
			}
			let root = group.root;
			if (req.kind === "merge" && root === undefined && req.repo && g.repoRoot) {
				const found = await g.repoRoot(req.repo);
				if (found === null) return REPO_UNKNOWN;
				root = found;
			}
			const refusal = await g.gate(req.kind, root, req.target, req.repo);
			if (refusal) return refusal;
		}
	}
	return null;
}

function commandName(word: string): string {
	return word.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
}

/** The command's own words: without leading keywords, NAME=value assignments and wrapper commands (env, timeout, ...). */
function unwrap(input: string[]): string[] {
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
	return words;
}

function wordsProblem(input: string[], o: PushContext): string | null {
	const words = unwrap(input);
	if (!words.length) return null;
	const name = commandName(words[0]);
	const args = words.slice(1);
	if (["bash", "sh", "zsh", "dash", "ksh"].includes(name) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(args[0] ?? "") && args[1] !== undefined) return pushProblem(args[1], o);
	if (name === "gh") return ghOnly(args, o);
	if (name !== "git") return null;
	const g = gitSubcommand(args);
	if (!g) return null;
	if (/^@|[$`]/.test(g.sub)) return "runs a git subcommand built at runtime";
	// Only the options before the subcommand: a commit message may mention hooksPath.
	const before = args.slice(0, args.length - g.rest.length - 1);
	if (before.some((a) => /^alias\./i.test(a))) return ALIAS;
	if (g.sub === "config" && g.rest.some((a) => /hookspath|include(if)?\./i.test(a))) return "changes where git looks for hooks";
	if (g.sub === "config" && !g.rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)) && g.rest.some((a) => /^alias\./i.test(a))) return ALIAS;
	if (g.sub === "branch" && g.rest.some((a) => /^(-u|--set-upstream-to(=.*)?|--set-upstream)$/.test(a))) return PUSH_CONFIG;
	if (g.sub === "config" && !g.rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a)) && g.rest.some((a) => PUSH_KEY.test(a))) return PUSH_CONFIG;
	if (NO_VERIFY_SUBS.has(g.sub)) return g.rest.some((a) => isLong(a, "--no-verify")) ? `git ${g.sub} --no-verify skips the hooks` : null;
	if (g.sub !== "push" && g.sub !== "commit") return null;
	if (before.some((a) => /hookspath/i.test(a))) return "changes where git looks for hooks";
	if (g.sub === "push" && before.some((a) => PUSH_KEY.test(a))) return PUSH_CONFIG;
	return g.sub === "push" ? pushOnly(g.rest, o) : commitOnly(g.rest);
}

/** Subcommands that can create a commit without `git commit`; only --no-verify is refused on them. */
const NO_VERIFY_SUBS = new Set(["merge", "cherry-pick", "revert", "pull", "rebase", "am"]);

function commitOnly(rest: string[]): string | null {
	if (rest.some((a) => isLong(a, "--no-verify") || shortHas(a, "n"))) return "git commit skips the hooks (--no-verify)";
	return null;
}

const PUSH_KEY = /^(push\.default|remote\.[^\s=]+\.push|branch\.[^\s=]+\.merge)(=.*)?$/i;
const PUSH_CONFIG = "changes where git push goes (push.default, remote.*.push or an upstream): name the branch in the push command";
const ALIAS = "defines a git alias, which would hide the subcommand from this guard";
const TAG_PUSH = "git push of a tag: tags are created or moved with deliver {tag}, as a named Deliver step";

function pushOnly(rest: string[], o: PushContext): string | null {
	for (const a of rest) {
		if (a === "--") break;
		if (a.startsWith("--") && FORCE_LONG.some((f) => isLong(a, f))) return `git push ${a.split("=")[0]} is never allowed (force, delete, mirror, or skipping hooks)`;
		if (shortHas(a, "fd")) return "git push -f / -d is never allowed (force or delete)";
		if (isLong(a, "--all") || isLong(a, "--branches")) return "git push --all publishes every branch, including protected ones";
		if (isLong(a, "--tags") || isLong(a, "--follow-tags")) return TAG_PUSH;
	}
	const positional = rest.filter((a) => !a.startsWith("-"));
	if (positional[1] === "tag") return TAG_PUSH;
	const refspecs = positional.slice(1);
	for (const spec of refspecs) {
		if (spec.startsWith("+")) return "git push with a +refspec forces the update";
		if (spec.startsWith(":")) return "git push with a :refspec deletes a remote branch";
		const rawDest = spec.includes(":") ? spec.split(":")[1] : spec;
		if (/^refs\/tags\//.test(rawDest)) return TAG_PUSH;
		const dest = rawDest.replace(/^refs\/heads\//, "");
		if (dest !== "HEAD" && dest !== "@") o.gates?.push({ kind: "tag-check", target: dest });
		if (o.protectedBranches.includes(dest)) o.gates?.push({ kind: "protected-push", target: pushSource(spec) });
		else if ((dest === "HEAD" || dest === "@") && o.protectedBranches.includes(o.branch)) o.gates?.push({ kind: "protected-push", target: "HEAD" });
		if (dest === "HEAD" || dest === "@") o.gates?.push({ kind: "head-push", target: "HEAD" });
	}
	if (refspecs.length === 0) {
		if (!o.branch || o.branch === "HEAD") return "git push from a detached HEAD (no branch)";
		if (o.protectedBranches.includes(o.branch)) o.gates?.push({ kind: "protected-push", target: "HEAD" });
		o.gates?.push({ kind: "head-push", target: "HEAD" });
	}
	return null;
}

/** The value of `-R` / `--repo` in gh arguments, or undefined. */
function repoOption(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-R" || a === "--repo") return args[i + 1];
		if (a.startsWith("--repo=")) return a.slice(7);
		if (/^-R./.test(a)) return a.slice(2);
	}
	return undefined;
}

/** The source ref of a push refspec: the left side of `src:dst`, else the refspec itself. */
export function pushSource(refspec: string): string {
	return refspec.includes(":") ? refspec.split(":")[0] : refspec;
}

/** The pull request argument of `gh pr merge` (number, URL or branch), or undefined for the current branch. `args` are the words after `merge`. */
export function mergeTarget(args: string[]): string | undefined {
	const valued = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-t", "--subject", "--match-head-commit", "-A", "--author-email"]);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (valued.has(a)) i++;
		else if (!a.startsWith("-")) return a;
	}
	return undefined;
}

/** gh: merging a pull request goes through the gate; --admin, --auto and approving are never allowed. */
function ghOnly(args: string[], o: PushContext): string | null {
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-R" || a === "--repo") i++;
		else if (!a.startsWith("-")) positional.push(a);
	}
	const [group, sub] = positional;
	if (group === "alias" && (sub === "set" || sub === "import")) return "defines a gh alias, which would hide the subcommand from this guard";
	if (group === "api") return ghApi(args.slice(args.indexOf("api") + 1));
	if (group !== "pr") return null;
	if (sub === "review" && args.some((a) => isLong(a, "--approve") || shortHas(a, "a"))) return "approving a pull request is never allowed";
	if (sub === "merge") {
		if (args.some((a) => isLong(a, "--admin"))) return "gh pr merge --admin bypasses the repo's branch rules";
		if (args.some((a) => isLong(a, "--auto"))) return "gh pr merge --auto is never used; wait for the checks (gh pr checks --watch), then merge";
		const at = args.indexOf("merge");
		const repo = repoOption(args);
		o.gates?.push({ kind: "merge", target: mergeTarget(args.slice(at + 1)), ...(repo ? { repo } : {}) });
	}
	return null;
}

function ghApi(rest: string[]): string | null {
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
	if (/mergePullRequest|enablePullRequestAutoMerge/.test(text)) return "merging a pull request through gh api skips the judge gate; use gh pr merge";
	const effective = method || (fields ? "POST" : "GET");
	if (effective === "GET") return null;
	if (/(^|\/)pulls\/[^/\s]+\/merge\b/.test(text)) return "merging a pull request through gh api skips the judge gate; use gh pr merge";
	return null;
}

/** Why JavaScript run through run_code may not run in execute phase (it pushes, skips hooks or merges a PR), or null. */
export function codePublishProblem(code: string): string | null {
	if (/\bgit\b/.test(code) && /\bpush\b|--no-verify|hooksPath|GIT_CONFIG/i.test(code)) return "code that runs git push, skips hooks or changes hooks (use bash, where the judge gate applies)";
	if (/\bgh\b/.test(code) && /\b(pr|api)\b/.test(code) && /\bmerge\b|mergePullRequest|AutoMerge/i.test(code)) return "code that merges a pull request (use bash, where the judge gate applies)";
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
