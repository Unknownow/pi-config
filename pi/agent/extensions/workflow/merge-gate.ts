/**
 * The judge gate: a merge, a push to a protected branch and a publish run only on a tree that has
 * passed the judge (or never when the plan says "Delivery: no merge"). Pure decisions, plus the
 * fact collection and the review-base move that take a git/gh runner so tests can stub them.
 */
import { execFile } from "node:child_process";

export type GateKind = "merge" | "protected-push" | "publish";

export interface GateFacts {
	noMerge: boolean;
	/** Snapshot trees of every judge PASS in this flow, for this repo. */
	passedTrees: string[];
	/** The tree about to be merged, pushed or published; null when it could not be read. */
	tree: string | null;
	/** Paths that differ between the last passed tree and `tree`. */
	diffNames?: string[];
	/** The commit about to be merged, pushed or published, when known; names it when its tree is missing from the repo. */
	commit?: string;
	/** What is being gated, e.g. "merging pull request 12". */
	what: string;
}

/** A plan line `Delivery: no merge` turns merge, protected pushes and publishing off for the flow. */
export function noMerge(plan: string): boolean {
	return /^\s*(?:[-*]\s+)?Delivery:\s*no merge\b/im.test(plan);
}

/** Why this merge, protected push or publish is refused, or null when its tree has passed the judge. */
export function gateProblem(_kind: GateKind, f: GateFacts): string | null {
	if (f.noMerge) return `this plan says Delivery: no merge; ${f.what} is not allowed`;
	if (f.tree && f.passedTrees.includes(f.tree)) return null;
	if (!f.tree && f.commit) return `${f.what}: its head ${f.commit.slice(0, 7)} is not in this repo; run the merge in the repo it belongs to, or fetch that commit first`;
	const names = f.diffNames ?? [];
	const list = names.length ? `; differs from the last passed tree in: ${names.slice(0, 10).join(", ")}${names.length > 10 ? ", …" : ""}` : "";
	return `${f.what} is not judged: run judge, then retry${list}`;
}

/** Whether a recorded judged merge belongs to `stage` (an earlier stage's merge does not count for this one). */
export function mergedInStage(jm: { stage?: number } | undefined, stage: number | undefined): boolean {
	return !!jm && jm.stage === stage;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type Runner = (cmd: "git" | "gh", args: string[], cwd: string) => Promise<RunResult>;

/** Runs git or gh without a shell; never throws. */
export const defaultRunner: Runner = (cmd, args, cwd) =>
	new Promise((resolve) => {
		execFile(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
		});
	});

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";

export interface GateCheck {
	problem: string | null;
	tree: string | null;
	/** The commit being merged or pushed, when it could be read. */
	commit?: string;
}

/** Collects the facts for a merge or protected push in `dir` and decides with `gateProblem`. */
export async function gateCheck(run: Runner, kind: "merge" | "protected-push", dir: string, target: string | undefined, o: { passedTrees: string[]; noMerge: boolean; repo?: string }): Promise<GateCheck> {
	const what = kind === "merge" ? `merging pull request ${target ?? "of the current branch"}` : `pushing ${target ?? "HEAD"} to a protected branch`;
	if (o.noMerge) return { problem: gateProblem(kind, { noMerge: true, passedTrees: [], tree: null, what }), tree: null };
	let commit: string | undefined;
	if (kind === "merge") {
		const view = await run("gh", ["pr", "view", ...(target ? [target] : []), ...(o.repo ? ["-R", o.repo] : []), "--json", "headRefOid,state"], dir);
		if (view.code !== 0) return { problem: `cannot read the pull request (${firstLine(view.stderr) || "gh failed"})`, tree: null };
		try {
			commit = String(JSON.parse(view.stdout).headRefOid ?? "") || undefined;
		} catch {
			return { problem: "cannot read the pull request (gh printed no JSON)", tree: null };
		}
	} else {
		const rev = await run("git", ["rev-parse", "--verify", `${target ?? "HEAD"}^{commit}`], dir);
		commit = rev.code === 0 ? firstLine(rev.stdout) : undefined;
	}
	let tree: string | null = null;
	if (commit) {
		const t = await run("git", ["rev-parse", `${commit}^{tree}`], dir);
		if (t.code === 0) tree = firstLine(t.stdout) || null;
	}
	let diffNames: string[] = [];
	if (tree && !o.passedTrees.includes(tree) && o.passedTrees.length) {
		const d = await run("git", ["diff", "--name-only", o.passedTrees[o.passedTrees.length - 1], tree], dir);
		if (d.code === 0) diffNames = d.stdout.split(/\r?\n/).filter(Boolean);
	}
	return { problem: gateProblem(kind, { noMerge: false, passedTrees: o.passedTrees, tree, diffNames, what, commit }), tree, commit };
}

/** Where HEAD left `upstream`: the review base of a repo whose start nobody noticed, so commits made since are reviewed too. Null when there is none. */
export async function forkBase(run: Runner, dir: string, upstream: string): Promise<string | null> {
	const r = await run("git", ["merge-base", "HEAD", upstream], dir);
	return r.code === 0 && firstLine(r.stdout) ? firstLine(r.stdout) : null;
}

/** A commit holding `tree` on top of HEAD, used as a review base: the diff from it to a worktree with that tree is empty. Null on failure. */
export async function baseFromTree(run: Runner, dir: string, tree: string, parent = "HEAD"): Promise<string | null> {
	const c = await run("git", ["-c", "user.name=pi-workflow", "-c", "user.email=workflow@pi.invalid", "commit-tree", tree, "-p", parent, "-m", "workflow review base"], dir);
	const sha = firstLine(c.stdout);
	return c.code === 0 && sha ? sha : null;
}

/**
 * A review base that already contains what `upstream` brought in: the tree of an in-memory merge of
 * `base` and `upstream` (git merge-tree), as a commit on top of `base`. Null on a conflict or when git
 * has no `merge-tree --write-tree` (before 2.38).
 */
export async function mergedBase(run: Runner, dir: string, base: string, upstream: string): Promise<string | null> {
	const mt = await run("git", ["merge-tree", "--write-tree", base, upstream], dir);
	if (mt.code !== 0) return null;
	const tree = firstLine(mt.stdout);
	if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;
	return baseFromTree(run, dir, tree, base);
}

/** What a finished git task left behind that counts as a judged merge: a MERGED pull request whose head tree passed (looked up by the starting branch and by PR numbers in the report), else a protected branch whose HEAD tree passed and is on a remote (HEAD must have moved, or have reached a remote, during the task). `pr` is the text to show. */
export async function recordJudged(
	run: Runner,
	dir: string,
	opts: { startBranch: string; headBefore?: string; remoteBefore?: boolean; report: string; passed: string[]; protectedBranches: string[] },
): Promise<{ entry?: { pr?: string; commit?: string; tree: string }; pr: string }> {
	const out = async (...args: string[]) => (await run("git", args, dir).catch(() => ({ code: 1, stdout: "", stderr: "" }))).stdout.trim();
	const candidates = [opts.startBranch, ...[...opts.report.matchAll(/(?:\/pull\/|#)(\d+)/g)].map((m) => m[1])].filter((c, i, all) => c && c !== "HEAD" && all.indexOf(c) === i);
	let pr = "no PR";
	for (const cand of candidates) {
		const fromBranch = cand === opts.startBranch;
		const res = await run("gh", ["pr", "view", cand, "--json", "number,state,url,headRefOid"], dir).catch(() => undefined);
		if (res?.code !== 0) continue;
		try {
			const j = JSON.parse(res.stdout);
			if (pr === "no PR" && fromBranch) pr = `PR #${j.number} ${j.state} ${j.url}`;
			if (j.state !== "MERGED" || !j.headRefOid) continue;
			const tree = await out("rev-parse", `${j.headRefOid}^{tree}`);
			if (tree && opts.passed.includes(tree)) return { entry: { pr: String(j.number), tree }, pr: `PR #${j.number} ${j.state} ${j.url}` };
		} catch {
			// unreadable: try the next candidate
		}
	}
	const branch = await out("rev-parse", "--abbrev-ref", "HEAD");
	if (opts.protectedBranches.includes(branch)) {
		const head = await out("rev-parse", "HEAD");
		const tree = await out("rev-parse", "HEAD^{tree}");
		if (head && (head !== opts.headBefore || !opts.remoteBefore) && tree && opts.passed.includes(tree) && (await out("branch", "-r", "--contains", "HEAD"))) return { entry: { commit: head, tree }, pr };
	}
	return { pr };
}
