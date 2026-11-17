// node --experimental-strip-types --import ../agents/test-hooks.ts --test files.test.ts
// `## Files` end to end: the snapshot paths at dispatch, a worker that asks for a path with the files category, the
// check before the judge, and the worker extension's edit refusal and bash warning.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { readJob } from "./job.ts";
import { readFilesGuard, writeFilesGuard } from "./files.ts";
import { brief, type World, waitFor, world } from "./test/env.ts";
import { cleanup, makeRepo, tmpDir } from "./test/helpers.ts";

const PASS = "VERDICT: PASS";
const FILES = "\n## Files\n- greeting.txt\n";
const judgeCalls = (w: World) => w.calls().filter((c) => c.mode === "json" && c.role === "judge").length;

async function ended(w: World, id: string, ms = 60_000) {
	const jr = w.engine.get(id)!;
	await waitFor(() => jr.ended, ms, `job ${id} to end (state ${jr.job.state}; wakes: ${w.wakes.join(" | ").slice(0, 300)})`);
	return jr;
}

test("Files: the snapshot's paths join the globs at dispatch; a path outside is asked for with the files category, approved, and the job passes", async () => {
	const w = world();
	try {
		w.write({ worker: [{ write: [{ file: "greeting.txt", content: "hello\n" }, { file: "notes.md", content: "n\n" }], done: "ok" }], judge: [PASS] });
		// the lead's uncommitted edit moves into the job: the worker is never failed for it
		fs.writeFileSync(path.join(w.repo, "a.txt"), "a\nlead edit\n");
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, extra: FILES }) });
		assert.ok("id" in r, JSON.stringify(r));
		if (!("id" in r)) return;
		const jr = w.engine.get(r.id)!;
		await waitFor(() => jr.ws.openAsks.length === 1, 30_000, "the worker's approval request");
		assert.deepEqual(readFilesGuard(jr.dir), { files: ["greeting.txt"], snapshot: ["a.txt"] });
		const ask = jr.asks.get(jr.ws.openAsks[0])!;
		assert.deepEqual([ask.type, (ask as { category?: string }).category, (ask as { item?: string }).item], ["approval", "files", "notes.md"]);
		assert.ok(w.wakes.some((x) => /approval .*\[files\] notes\.md/.test(x)));
		const a = w.engine.approve(r.id, jr.ws.openAsks[0], true, "notes belong to the job");
		assert.ok("ok" in a, JSON.stringify(a));
		const done = await ended(w, r.id);
		assert.equal(done.job.state, "done", done.job.endReason);
		const job = readJob(jr.dir)!;
		assert.ok(job.approvals.some((x) => x.category === "files" && x.item === "notes.md" && x.by === "lead"));
		assert.match(fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8"), /\[files\] notes\.md approved/);
		assert.equal(judgeCalls(w), 1, "the Files check passed: greeting.txt, the approved notes.md and the snapshot's a.txt");
	} finally {
		w.end();
	}
});

test("Files: a change outside the globs fails the round before the judge, as a judge round; a job without Files is not limited", async () => {
	const w = world();
	try {
		w.write({ worker: [{ delayMs: 1500, write: [{ file: "greeting.txt", content: "hello\n" }], done: "ok" }, { hang: true }], judge: [PASS] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, extra: FILES }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = w.engine.get(r.id)!;
		await waitFor(() => jr.job.repos.length === 1 && jr.ws.alive, 30_000, "the worker");
		// something outside the guard's reach writes a stray file into the worktree
		fs.writeFileSync(path.join(jr.job.repos[0].worktree, "stray.txt"), "x\n");
		await waitFor(() => jr.job.round === 1, 30_000, "the failed round");
		assert.equal(judgeCalls(w), 0, "no judge call");
		assert.equal(jr.job.lastVerdict?.verdict, "FAIL");
		assert.match(fs.readFileSync(path.join(jr.dir, "judge", "round-1.md"), "utf8"), /\[files\] `stray\.txt`/);
		assert.ok(w.cmds().some((c) => c.type === "prompt" && /Files check failed \(round 1\)[\s\S]*- stray\.txt/.test(c.message)));
		await w.engine.stop(r.id);
	} finally {
		w.end();
	}
	const v = world();
	try {
		v.write({ worker: [{ write: [{ file: "greeting.txt", content: "hello\n" }, { file: "notes.md", content: "n\n" }], done: "ok" }], judge: [PASS] });
		const r = await v.engine.dispatch({ brief: brief({ repo: v.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const done = await ended(v, r.id);
		assert.equal(done.job.state, "done");
		assert.equal(readFilesGuard(done.dir), undefined);
		assert.equal(done.job.approvals.length, 0);
	} finally {
		v.end();
	}
});

test("the worker extension: an edit outside Files is refused; a bash call that changed paths outside Files gets the warning appended", async () => {
	const { dir } = makeRepo({ "a.txt": "a\n" });
	const jobDir = tmpDir("relay-job-");
	const before = process.env.RELAY_JOB_DIR;
	process.env.RELAY_JOB_DIR = jobDir;
	try {
		fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ v: 1, id: "r1", repos: [{ key: "R", main: dir, worktree: dir, branch: "main", base: "x" }], approvals: [] }));
		writeFilesGuard(jobDir, ["src/**"], []);
		const hooks = new Map<string, (e: any, c?: any) => Promise<any>>();
		const { default: worker } = await import("./worker.ts");
		worker({ on: (n: string, fn: any) => void hooks.set(n, fn), registerTool: () => {} } as never);
		const refused = await hooks.get("tool_call")!({ toolName: "write", input: { path: "docs/x.md" } }, { cwd: dir });
		assert.equal(refused?.block, true);
		assert.match(refused.reason, /outside the brief's Files.*category: "files"/);
		assert.equal(await hooks.get("tool_call")!({ toolName: "write", input: { path: "src/x.ts" } }, { cwd: dir }), undefined);
		// bash: nothing outside yet -> unchanged; then a stray file -> the warning is appended to the result
		const content = [{ type: "text", text: "ran" }];
		assert.equal(await hooks.get("tool_result")!({ toolName: "bash", content }), undefined);
		fs.mkdirSync(path.join(dir, "src"));
		fs.writeFileSync(path.join(dir, "src", "ok.ts"), "x\n");
		fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
		const res = await hooks.get("tool_result")!({ toolName: "bash", content });
		assert.equal(res.content[0].text, "ran");
		assert.match(res.content[1].text, /outside the brief's Files[\s\S]*- a\.txt/);
		assert.ok(!res.content[1].text.includes("src/ok.ts"));
		assert.equal(await hooks.get("tool_result")!({ toolName: "read", content }), undefined, "only bash");
		// an approval applies at once
		fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ v: 1, id: "r1", repos: [{ key: "R", main: dir, worktree: dir, branch: "main", base: "x" }], approvals: [{ category: "files", item: "a.txt", by: "lead" }] }));
		assert.equal(await hooks.get("tool_result")!({ toolName: "bash", content }), undefined);
	} finally {
		if (before === undefined) delete process.env.RELAY_JOB_DIR;
		else process.env.RELAY_JOB_DIR = before;
		cleanup(dir, jobDir);
	}
});
