// node --experimental-strip-types --test engine.test.ts
// The engine end to end with the fake pi (RELAY_PI_BIN): a scripted RPC worker, critic and judge, a fake worktree extension, real git repos with a bare origin.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { listJobs, readJob } from "./job.ts";
import { git } from "./test/helpers.ts";
import { brief, waitFor, world } from "./test/env.ts";

const FAIL = (extra = "") => `- major - [bug] \`greeting.txt:1\` wrong greeting fix: auto\n  Why: it should say hello.\n  Fix: say hello.\n${extra}\nVERDICT: FAIL`;
const PASS = "- minor - [style] `greeting.txt:1` trailing space fix: auto\n  Why: x\n  Fix: y\n\nVERDICT: PASS";

async function finish(w: ReturnType<typeof world>, id: string, ms = 60_000) {
	const jr = w.engine.get(id)!;
	await waitFor(() => jr.ended, ms, `job ${id} to end (state ${jr.job.state}, wakes: ${w.wakes.join(" | ").slice(0, 400)})`);
	return jr;
}

test("dispatch -> FAIL -> fix -> PASS -> delivery to the bare remote -> report.md -> worker exit -> W2", async () => {
	const w = world();
	try {
		w.write({
			worker: [{ write: [{ file: "greeting.txt", content: "helo\n" }], done: "first try" }, { write: [{ file: "greeting.txt", content: "hello\n" }], done: "fixed" }],
			judge: [FAIL(), PASS],
		});
		// the lead has an uncommitted edit and a new file: both move into the job
		fs.writeFileSync(path.join(w.repo, "a.txt"), "a\nlead edit\n");
		fs.writeFileSync(path.join(w.repo, "lead-new.txt"), "new\n");
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, authority: { merge: "yes (fast-forward to main after PASS)" } }) });
		assert.ok("id" in r, JSON.stringify(r));
		if (!("id" in r)) return;
		const jr = await finish(w, r.id);
		const job = readJob(jr.dir)!;
		assert.equal(job.state, "done");
		assert.equal(job.lastVerdict?.verdict, "PASS");
		assert.equal(job.lastVerdict?.round, 2);
		// worker and judge usage both count against the budget: two worker turns and two judge runs, 350 weighted tokens each
		assert.ok(job.used.tokens >= 4 * 350, String(job.used.tokens));
		// the bare remote's main has the job's files, including the lead's edits
		const check = path.join(path.dirname(w.script), "check");
		git(path.dirname(w.script), "clone", "-q", w.bare, check);
		assert.equal(fs.readFileSync(path.join(check, "greeting.txt"), "utf8"), "hello\n");
		assert.equal(fs.readFileSync(path.join(check, "a.txt"), "utf8"), "a\nlead edit\n");
		assert.ok(fs.existsSync(path.join(check, "lead-new.txt")));
		// the lead's checkout is clean again
		assert.equal(git(w.repo, "status", "--porcelain"), "");
		// the report
		const report = fs.readFileSync(path.join(jr.dir, "report.md"), "utf8");
		assert.ok(report.indexOf("## Approvals") < report.indexOf("## Overrides") && report.indexOf("## Overrides") < report.indexOf("## Done when"));
		assert.match(report, /merge\] fast-forward to main after PASS - by brief/);
		assert.match(report, /greeting\.txt exists/);
		assert.match(report, /merged/);
		// the worker exited, W2 ran once without force, no snapshot branch is left
		assert.equal(jr.worker?.exited, true);
		assert.equal(w.wtCalls.remove.length, 1);
		assert.equal(w.wtCalls.remove[0].force, undefined);
		assert.equal(git(w.repo, "branch", "--list", `relay/${r.id}/lead-edits`), "");
		// W1 was asked without a launch (the fake records the request) and for the lead's repo only
		assert.deepEqual(Object.keys(w.wtCalls.create[0].bases), [w.repo]);
		// notices: one FAIL notice; wakes: PASS and the report, none for the FAIL round
		assert.equal(w.notices.filter((n) => /round 2/.test(n)).length, 1);
		assert.ok(!w.wakes.some((x) => /FAIL/.test(x)));
		assert.ok(w.wakes.some((x) => /judge PASS/.test(x)));
		assert.ok(w.wakes.some((x) => /delivered/.test(x)));
		assert.deepEqual(w.events.map((e) => e.name).filter((n) => n !== "relay:job-progress"), ["relay:approval", "relay:job-start", "relay:job-end"]);
		assert.equal(w.events.find((e) => e.name === "relay:job-end")!.payload.how, "delivered");
		// the worker was spawned with the contract's arguments
		const rpc = w.calls().find((c) => c.mode === "rpc")!;
		for (const f of ["-ne", "-ns", "-np", "--session-dir"]) assert.ok(rpc.args.includes(f), f);
		assert.equal(rpc.env.RELAY_ROLE, "worker");
		const es = rpc.args.flatMap((a: string, i: number) => (rpc.args[i - 1] === "-e" ? [a] : []));
		assert.equal(es.length, 1);
		assert.match(es[0], /worker\.ts$/);
		assert.ok(!rpc.args.includes("builtin:mcp"));
	} finally {
		w.end();
	}
});

test("worker.extensions are in the -e list after worker.ts; builtin:mcp and mcp-forward only with knowledge", async () => {
	const w = world({ worker: { extensions: ["/x/ext.ts"] } }, undefined, { mcpServers: () => [{ name: "knowledge", config: { command: "node", args: [] } }] });
	try {
		w.write({ worker: [{ write: [{ file: "greeting.txt", content: "hello\n" }], done: "ok" }], judge: [PASS] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		await finish(w, r.id);
		const rpc = w.calls().find((c) => c.mode === "rpc")!;
		const es = rpc.args.flatMap((a: string, i: number) => (rpc.args[i - 1] === "-e" ? [a] : []));
		assert.match(es[0], /worker\.ts$/);
		assert.equal(es[1], "/x/ext.ts");
		assert.equal(es[2], "builtin:mcp");
		assert.match(es[3], /mcp-forward\.ts$/);
		assert.equal(es.length, 4);
	} finally {
		w.end();
	}
});

test("an edit to package.json is refused until relay_approve", async () => {
	const w = world();
	try {
		w.write({ worker: [{ write: [{ file: "package.json", content: '{"name":"x"}\n' }, { file: "greeting.txt", content: "hello\n" }], done: "ok" }], judge: [PASS] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, authority: { merge: "yes (ff)" } }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		await waitFor(() => w.wakes.some((x) => /asks approval/.test(x)), 30_000, "the approval request");
		const wake = w.wakes.find((x) => /asks approval/.test(x))!;
		assert.match(wake, /\[deps\] package\.json/);
		const askId = /\((m?\w+)\) for/.exec(wake)![1];
		const jr = w.engine.get(r.id)!;
		// until approved, the file is untouched in the worktree
		assert.equal(fs.readFileSync(path.join(jr.job.repos[0].worktree, "package.json"), "utf8"), "{}\n");
		assert.deepEqual(w.engine.approve(r.id, askId, true, "needed for the greeting"), { ok: true, text: "approved" });
		assert.equal(jr.job.approvals.at(-1)?.category, "deps");
		assert.equal(jr.job.approvals.at(-1)?.by, "lead");
		assert.match(fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8"), /## Amendment 1 \(approval\): \[deps\] package\.json approved/);
		await finish(w, r.id);
		assert.equal(readJob(jr.dir)?.state, "done");
		assert.match(fs.readFileSync(path.join(jr.dir, "report.md"), "utf8"), /\[deps\] package\.json - by lead/);
		assert.ok(w.events.some((e) => e.name === "relay:approval" && e.payload.by === "lead"));
	} finally {
		w.end();
	}
});

test("askUser: publish is refused by relay_approve (ask the user first), other categories are accepted", async () => {
	const w = world({ askUser: ["publish"] });
	try {
		w.write({
			worker: [
				{ ask: { approval: { category: "publish", item: "npm publish", why: "release" } } },
				{ ask: { approval: { category: "deps", item: "left-pad", why: "needed" } }, write: [{ file: "greeting.txt", content: "hello\n" }], done: "ok" },
			],
			judge: [PASS],
		});
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = w.engine.get(r.id)!;
		await waitFor(() => w.wakes.some((x) => /asks approval.*\[publish\]/.test(x)), 30_000, "the publish request");
		const pubId = /\((\w+)\) for \[publish\]/.exec(w.wakes.find((x) => /\[publish\]/.test(x))!)![1];
		const refused = w.engine.approve(r.id, pubId, true, "go");
		assert.ok("error" in refused && /ask the user first/.test(refused.error));
		// refusing needs no user: it unblocks the worker
		assert.deepEqual(w.engine.approve(r.id, pubId, false, "not now"), { ok: true, text: "refused" });
		await waitFor(() => w.wakes.some((x) => /asks approval.*\[deps\]/.test(x)), 40_000, "the deps request");
		const depsId = /\((\w+)\) for \[deps\]/.exec(w.wakes.find((x) => /\[deps\]/.test(x))!)![1];
		assert.deepEqual(w.engine.approve(r.id, depsId, true, "ok"), { ok: true, text: "approved" });
		await finish(w, r.id);
	} finally {
		w.end();
	}
});

test("the judge cap stops the job and wakes the lead; [plan] and crash each start a turn", async () => {
	const w = world({ caps: { judge: 3, escalate: 0, replans: 0 } });
	try {
		w.write({ worker: [{ write: [{ file: "greeting.txt", content: "x\n" }], done: "try" }], judge: [FAIL(), FAIL("- major - [plan] `brief` the Design contradicts a locked decision fix: user\n  Why: x\n  Fix: y"), FAIL()] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = await finish(w, r.id);
		assert.equal(jr.job.state, "stopped", jr.job.endReason);
		assert.match(jr.job.endReason ?? "", /judge cap/);
		assert.ok(w.wakes.some((x) => /plan flaw/.test(x)), "a [plan] finding wakes the lead");
		assert.ok(w.wakes.some((x) => /judge cap/.test(x)));
		assert.ok(fs.existsSync(path.join(jr.dir, "report.md")));
		assert.equal(w.wtCalls.remove.length, 0, "a stopped job keeps its set");
		assert.equal(jr.job.round, 3);
	} finally {
		w.end();
	}
	const c = world();
	try {
		c.write({ worker: [{ crash: true }] });
		const r = await c.engine.dispatch({ brief: brief({ repo: c.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		// a crash is restarted once (-c); the second one pauses the job and wakes the lead
		const jr = c.engine.get(r.id)!;
		await waitFor(() => jr.job.state === "paused", 30_000, "the job to pause after two crashes");
		assert.match(jr.job.paused?.why ?? "", /restarted once already/);
		assert.ok(c.wakes.some((x) => /again after a restart/.test(x)));
		assert.equal(c.calls().filter((x) => x.mode === "rpc").length, 2);
		assert.ok(c.calls().filter((x) => x.mode === "rpc")[1].args.includes("-c"));
		assert.equal(c.wtCalls.remove.length, 0);
	} finally {
		c.end();
	}
});

test("relay_stop aborts the worker, sets stopped and writes report.md", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = w.engine.get(r.id)!;
		await waitFor(() => jr.job.state === "working" && jr.ws.alive, 30_000, "the worker to start");
		assert.deepEqual(await w.engine.stop(r.id), { ok: true });
		assert.equal(readJob(jr.dir)?.state, "stopped");
		assert.match(fs.readFileSync(path.join(jr.dir, "report.md"), "utf8"), /stopped/);
		assert.equal(jr.worker?.exited, true);
		assert.ok("error" in (await w.engine.stop(r.id)));
	} finally {
		w.end();
	}
});

test("relay_stop while the judge runs: no push, no merge, state stopped, the report says so", async () => {
	const w = world();
	try {
		w.write({ worker: [{ write: [{ file: "greeting.txt", content: "hello\n" }], done: "ok" }], judge: [{ text: PASS, delayMs: 20_000 }] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, authority: { merge: "yes (ff)" } }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = w.engine.get(r.id)!;
		await waitFor(() => jr.job.state === "judging" && jr.driving && w.calls().some((c) => c.mode === "json"), 30_000, "the judge to start");
		assert.deepEqual(await w.engine.stop(r.id), { ok: true });
		assert.equal(jr.driving, false);
		const job = readJob(jr.dir)!;
		assert.equal(job.state, "stopped");
		assert.equal(git(w.bare, "log", "--oneline", "main").split("\n").length, 1, "nothing merged");
		assert.equal(git(w.bare, "branch", "--list", `wt/${r.id}`), "", "nothing pushed");
		assert.match(fs.readFileSync(path.join(jr.dir, "report.md"), "utf8"), /stopped/);
		assert.ok(jr.ended);
	} finally {
		w.end();
	}
});

test("a PR-only delivery pushes the branch, keeps the set and never calls W2", async () => {
	const w = world();
	try {
		w.write({ worker: [{ write: [{ file: "greeting.txt", content: "hello\n" }], done: "ok" }], judge: [PASS] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = await finish(w, r.id);
		const job = readJob(jr.dir)!;
		assert.equal(job.state, "done");
		assert.equal(job.repos[0].merged, undefined);
		assert.equal(job.repos[0].remoteBranch, `wt/${r.id}`);
		assert.equal(job.repos[0].remotePushed, git(job.repos[0].worktree, "rev-parse", "HEAD"));
		assert.equal(w.wtCalls.remove.length, 0);
		assert.ok(fs.existsSync(path.join(w.sets, r.id)), "the set is kept");
		assert.match(job.notes.join("\n"), /kept until the PR merges/);
		// main on the remote is untouched
		assert.equal(git(w.bare, "log", "--oneline", "main").split("\n").length, 1);
		assert.ok(git(w.bare, "branch", "--list", `wt/${r.id}`).includes(`wt/${r.id}`));
	} finally {
		w.end();
	}
});

test("dispatch refuses an incomplete brief and a conflicting lead edit keeps the edits", async () => {
	const w = world();
	try {
		const bad = await w.engine.dispatch({ brief: "## Goal\nx\n" });
		assert.ok("error" in bad && /not complete/.test(bad.error));
		// the lead's edit conflicts with a commit already on origin/main
		const other = path.join(path.dirname(w.script), "other");
		git(path.dirname(w.script), "clone", "-q", w.bare, other);
		fs.writeFileSync(path.join(other, "a.txt"), "someone else\n");
		git(other, "commit", "-q", "-am", "other");
		git(other, "push", "-q", "origin", "main");
		fs.writeFileSync(path.join(w.repo, "a.txt"), "lead version\n");
		git(w.repo, "fetch", "-q", "origin");
		w.write({ worker: [{ done: "x" }] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = await finish(w, r.id);
		assert.equal(jr.job.state, "failed");
		assert.match(jr.job.endReason ?? "", /do not apply.*a\.txt/);
		assert.equal(fs.readFileSync(path.join(w.repo, "a.txt"), "utf8"), "lead version\n", "the lead's edits are untouched");
		assert.equal(w.wtCalls.remove[0]?.force, true, "the new set is removed");
		assert.equal(w.calls().filter((c) => c.mode === "rpc").length, 0, "no worker was started");
	} finally {
		w.end();
	}
});

test("jobs are stored under the cwd repo's git folder", async () => {
	const w = world();
	try {
		w.write({ worker: [{ write: [{ file: "greeting.txt", content: "hello\n" }], done: "ok" }], judge: [PASS] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		await finish(w, r.id);
		assert.deepEqual(listJobs(w.jobRoot).map((j) => j.job.id), [r.id]);
		assert.ok(fs.existsSync(path.join(w.jobRoot, r.id, "brief.md")));
	} finally {
		w.end();
	}
});
