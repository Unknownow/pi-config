// node --test merge-gate.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { forkBase, mergedInStage, baseFromTree, defaultRunner, gateCheck, recordJudged, gateProblem, mergedBase, noMerge, type Runner } from "./merge-gate.ts";

test("gateProblem: a passed tree is allowed", () => {
	assert.equal(gateProblem("merge", { noMerge: false, passedTrees: ["t1", "t2"], tree: "t2", what: "merging" }), null);
});

test("gateProblem: an unjudged tree says run judge and names the paths, never the user", () => {
	const p = gateProblem("merge", { noMerge: false, passedTrees: ["t1"], tree: "t9", diffNames: ["a.ts", "b.ts"], what: "merging pull request 12" }) ?? "";
	assert.match(p, /run judge, then retry/);
	assert.match(p, /a\.ts, b\.ts/);
	assert.doesNotMatch(p, /user/i);
	const many = gateProblem("publish", { noMerge: false, passedTrees: [], tree: "t", diffNames: Array.from({ length: 12 }, (_, i) => `f${i}`), what: "x" }) ?? "";
	assert.match(many, /f9, …/);
	assert.doesNotMatch(many, /f10/);
});

test("gateProblem: an unreadable tree is refused", () => {
	assert.match(gateProblem("protected-push", { noMerge: false, passedTrees: ["t"], tree: null, what: "pushing x" }) ?? "", /run judge/);
});

test("gateProblem: Delivery: no merge refuses every kind", () => {
	for (const kind of ["merge", "protected-push", "publish"] as const) {
		const p = gateProblem(kind, { noMerge: true, passedTrees: ["t"], tree: "t", what: "x" }) ?? "";
		assert.match(p, /Delivery: no merge/);
		assert.doesNotMatch(p, /user/i);
	}
});

test("mergedInStage: a stage-1 merge does not count in stage 2", () => {
	assert.equal(mergedInStage({ stage: 1 }, 2), false);
	assert.equal(mergedInStage({ stage: 2 }, 2), true);
	assert.equal(mergedInStage({}, undefined), true);
	assert.equal(mergedInStage(undefined, 1), false);
});

test("noMerge", () => {
	assert.equal(noMerge("## Plan\nDelivery: no merge\n"), true);
	assert.equal(noMerge("- Delivery: no merge"), true);
	assert.equal(noMerge("we do not merge here"), false);
	assert.equal(noMerge("Delivery: merge"), false);
});

test("gateCheck: reads the pull request head tree", async () => {
	const calls: string[] = [];
	const run: Runner = async (cmd, args) => {
		calls.push(`${cmd} ${args.join(" ")}`);
		if (cmd === "gh") return { code: 0, stdout: '{"headRefOid":"abc","state":"OPEN"}', stderr: "" };
		if (args[0] === "rev-parse") return { code: 0, stdout: "t1\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const ok = await gateCheck(run, "merge", "/r", "12", { passedTrees: ["t1"], noMerge: false });
	assert.equal(ok.problem, null);
	assert.equal(ok.tree, "t1");
	assert.equal(ok.commit, "abc");
	assert.match(calls[0], /^gh pr view 12 --json headRefOid,state$/);
	const bad = await gateCheck(run, "merge", "/r", "12", { passedTrees: ["other"], noMerge: false });
	assert.match(bad.problem ?? "", /run judge/);
});

test("gateCheck: the pull request is read from the repo the command names", async () => {
	const calls: string[] = [];
	const run: Runner = async (cmd, args) => {
		calls.push(`${cmd} ${args.join(" ")}`);
		return cmd === "gh" ? { code: 0, stdout: '{"headRefOid":"abc"}', stderr: "" } : { code: 0, stdout: "t1\n", stderr: "" };
	};
	await gateCheck(run, "merge", "/r", "12", { passedTrees: ["t1"], noMerge: false, repo: "o/r" });
	assert.match(calls[0], /^gh pr view 12 -R o\/r --json headRefOid,state$/);
});

test("gateCheck: gh failure names the stderr line", async () => {
	const run: Runner = async () => ({ code: 1, stdout: "", stderr: "no pull requests found\nmore" });
	const r = await gateCheck(run, "merge", "/r", undefined, { passedTrees: ["t"], noMerge: false });
	assert.match(r.problem ?? "", /cannot read the pull request \(no pull requests found\)/);
});

test("gateCheck: no merge never runs a command", async () => {
	const run: Runner = async () => assert.fail("must not run");
	const r = await gateCheck(run, "protected-push", "/r", "HEAD", { passedTrees: ["t"], noMerge: true });
	assert.match(r.problem ?? "", /Delivery: no merge/);
});

const git = async (dir: string, ...args: string[]) => {
	const r = await defaultRunner("git", args, dir);
	assert.equal(r.code, 0, `${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
const mergeTreeSupported = async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-probe-"));
	try {
		await git(dir, "init", "-q");
		return (await defaultRunner("git", ["merge-tree", "--write-tree", "--help"], dir)).stderr.indexOf("unknown option") < 0 && (await defaultRunner("git", ["merge-tree", "--write-tree", "HEAD", "HEAD"], dir)).stderr.indexOf("unknown option") < 0;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

async function repoWithMerge(conflict: boolean) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-"));
	await git(dir, "init", "-q", "-b", "main");
	await git(dir, "config", "user.email", "t@t");
	await git(dir, "config", "user.name", "t");
	await git(dir, "config", "commit.gpgsign", "false");
	fs.writeFileSync(path.join(dir, "base.txt"), "one\n");
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", "init");
	const base = await git(dir, "rev-parse", "HEAD");
	await git(dir, "checkout", "-qb", "flow/x");
	fs.writeFileSync(path.join(dir, conflict ? "base.txt" : "f.txt"), "branch\n");
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", "f");
	// A conflict needs a base that already holds the branch change: main then edits the same line.
	const tip = await git(dir, "rev-parse", "HEAD");
	await git(dir, "checkout", "-q", "main");
	fs.writeFileSync(path.join(dir, conflict ? "base.txt" : "g.txt"), "main\n");
	await git(dir, "add", "-A");
	await git(dir, "commit", "-qm", "g");
	await git(dir, "checkout", "-q", "flow/x");
	if (!conflict) await git(dir, "merge", "-q", "--no-edit", "main");
	return { dir, base: conflict ? tip : base };
}

test("mergedBase: a merged main stays out of the diff", async (t) => {
	if (!(await mergeTreeSupported())) return t.skip("git merge-tree --write-tree is not supported");
	const { dir, base } = await repoWithMerge(false);
	try {
		const moved = await mergedBase(defaultRunner, dir, base, "main");
		assert.ok(moved);
		assert.deepEqual((await git(dir, "diff", "--name-only", moved, "HEAD")).split(/\r?\n/), ["f.txt"]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("baseFromTree: after the pull request was merged and main moved, the next stage starts from the worktree as it is", async () => {
	const { dir } = await repoWithMerge(false);
	try {
		// main moves on without this flow, then the flow's branch is merged into it and checked out
		await git(dir, "checkout", "-q", "main");
		fs.writeFileSync(path.join(dir, "others.txt"), "teammate\n");
		await git(dir, "add", "-A");
		await git(dir, "commit", "-qm", "teammate");
		await git(dir, "merge", "-q", "--no-edit", "flow/x");
		const tree = await git(dir, "rev-parse", "HEAD^{tree}");
		const base = await baseFromTree(defaultRunner, dir, tree);
		assert.ok(base);
		assert.equal(await git(dir, "diff", "--name-only", base), "");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("forkBase: commits made before the repo was noticed are inside the diff", async () => {
	const { dir } = await repoWithMerge(false);
	try {
		const base = await forkBase(defaultRunner, dir, "main");
		assert.ok(base);
		const names = (await git(dir, "diff", "--name-only", base, "HEAD")).split(/\r?\n/).sort();
		assert.ok(names.includes("f.txt"));
		assert.equal(await forkBase(defaultRunner, dir, "no-such-ref"), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("mergedBase: a conflict gives null", async (t) => {
	if (!(await mergeTreeSupported())) return t.skip("git merge-tree --write-tree is not supported");
	const { dir, base } = await repoWithMerge(true);
	try {
		assert.equal(await mergedBase(defaultRunner, dir, base, "main"), null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function stub(opts: { branch: string; pr?: { number: number; state: string; headRefOid: string }; trees: Record<string, string>; remote?: string }): Runner {
	return async (cmd, args) => {
		const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
		if (cmd === "gh") return opts.pr ? ok(JSON.stringify({ ...opts.pr, url: "u" })) : { code: 1, stdout: "", stderr: "" };
		if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return ok(opts.branch);
		if (args[0] === "rev-parse") return ok(opts.trees[args[1]] ?? "");
		if (args[0] === "branch") return ok(opts.remote ?? "");
		return ok("");
	};
}

test("recordJudged: a merged PR with a passed tree is found from the starting branch, even when the checkout is on main", async () => {
	const run = stub({ branch: "main", pr: { number: 7, state: "MERGED", headRefOid: "h" }, trees: { "h^{tree}": "T" } });
	const r = await recordJudged(run, ".", { startBranch: "flow/x", report: "", passed: ["T"], protectedBranches: ["main"] });
	assert.deepEqual(r.entry, { pr: "7", tree: "T" });
});

test("recordJudged: a PR number in the report is found", async () => {
	const run = stub({ branch: "main", pr: { number: 12, state: "MERGED", headRefOid: "h" }, trees: { "h^{tree}": "T" } });
	const r = await recordJudged(run, ".", { startBranch: "", report: "merged #12", passed: ["T"], protectedBranches: [] });
	assert.equal(r.entry?.pr, "12");
});

test("recordJudged: an open PR or an unpassed tree is skipped", async () => {
	const open = stub({ branch: "f", pr: { number: 1, state: "OPEN", headRefOid: "h" }, trees: { "h^{tree}": "T" } });
	assert.equal((await recordJudged(open, ".", { startBranch: "f", report: "", passed: ["T"], protectedBranches: [] })).entry, undefined);
	const merged = stub({ branch: "f", pr: { number: 1, state: "MERGED", headRefOid: "h" }, trees: { "h^{tree}": "T" } });
	assert.equal((await recordJudged(merged, ".", { startBranch: "f", report: "", passed: ["other"], protectedBranches: [] })).entry, undefined);
});

test("recordJudged: an unchanged HEAD on a protected branch records nothing", async () => {
	const run = stub({ branch: "main", trees: { HEAD: "c1", "HEAD^{tree}": "T" }, remote: "origin/main" });
	assert.equal((await recordJudged(run, ".", { startBranch: "main", headBefore: "c1", report: "", passed: ["T"], protectedBranches: ["main"] })).entry, undefined);
});

test("recordJudged: a protected push of a passed tree that is on the remote is recorded", async () => {
	const run = stub({ branch: "main", trees: { HEAD: "c1", "HEAD^{tree}": "T" }, remote: "origin/main" });
	const r = await recordJudged(run, ".", { startBranch: "main", report: "", passed: ["T"], protectedBranches: ["main"] });
	assert.deepEqual(r.entry, { commit: "c1", tree: "T" });
	const local = stub({ branch: "main", trees: { HEAD: "c1", "HEAD^{tree}": "T" } });
	assert.equal((await recordJudged(local, ".", { startBranch: "main", report: "", passed: ["T"], protectedBranches: ["main"] })).entry, undefined);
});
