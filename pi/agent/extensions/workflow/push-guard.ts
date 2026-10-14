/**
 * Execute phase: refuses git commands that publish or skip the hooks. Pushing is the
 * workflow's job, after the judge passes; the executor may not push, force-push, push
 * to a protected branch, or commit with --no-verify. Checked on the command text, so it
 * is a guardrail against a drifting executor, not a sandbox. It also refuses `gh` commands that
 * open or merge pull requests unless the flow's delivery allows them, and `gh pr merge --admin`
 * / `--auto` and `gh pr review --approve` always.
 */
import { gitSubcommand, KEYWORDS, parseCommands, WRAPPERS } from "./readonly-bash.ts";

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
	if (g.sub !== "push" && g.sub !== "commit") return null;
	// Only the options before the subcommand: a commit message may mention hooksPath.
	if (args.slice(0, args.length - g.rest.length - 1).some((a) => /hookspath/i.test(a))) return "changes where git looks for hooks";
	return g.sub === "push" ? pushOnly(g.rest, o) : commitOnly(g.rest);
}

function commitOnly(rest: string[]): string | null {
	if (rest.some((a) => isLong(a, "--no-verify") || shortHas(a, "n"))) return "git commit skips the hooks (--no-verify)";
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
