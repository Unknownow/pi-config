// node --experimental-strip-types --test running.test.ts
// Stage 3: mid-run input, escalation and re-plan, stalls and tool timeouts, pause, adoption, PR-only cleanup and follow-ups.
// Engine tests with the fake pi, real git repos with a bare origin, and a fake clock where time matters.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { listJobs, readJob, writeJob } from "./job.ts";
import { run } from "./sh.ts";
import { runSubagent } from "./subagent.ts";
import { git, tmpDir } from "./test/helpers.ts";
import { brief, type World, waitFor, world } from "./test/env.ts";

const FAIL = "- major - [bug] `greeting.txt:1` wrong greeting fix: auto\n  Why: it should say hello.\n  Fix: say hello.\n\nVERDICT: FAIL";
const PASS = "VERDICT: PASS";
const turn = (file: string, content = "hello\n", done = "ok") => ({ write: [{ file, content }], done });
const judgeCalls = (w: World) => w.calls().filter((c) => c.mode === "json" && c.role === "judge").length;
const rpcCalls = (w: World) => w.calls().filter((c) => c.mode === "rpc");
const nl = String.fromCharCode(10);

async function start(w: World, over: Parameters<typeof brief>[0] = {}): Promise<string> {
	const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, ...over }) });
	assert.ok("id" in r, JSON.stringify(r));
	return (r as { id: string }).id;
}
async function working(w: World, id: string) {
	const jr = w.engine.get(id)!;
	await waitFor(() => jr.job.state === "working" && jr.ws.alive && w.cmds().some((c) => c.type === "prompt"), 30_000, "the worker to start");
	return jr;
}
async function ended(w: World, id: string, ms = 60_000) {
	const jr = w.engine.get(id)!;
	await waitFor(() => jr.ended, ms, `job ${id} to end (state ${jr.job.state}; wakes: ${w.wakes.join(" | ").slice(0, 300)})`);
	return jr;
}
/** origin/main moves: another clone commits a file and pushes. */
function moveMain(w: World, file: string, content: string): void {
	const c = tmpDir("relay-other-");
	git(c, "clone", "-q", w.bare!, ".");
	fs.writeFileSync(path.join(c, file), content);
	git(c, "add", "-A");
	git(c, "commit", "-q", "-m", `upstream ${file}`);
	git(c, "push", "-q", "origin", "main");
	fs.rmSync(c, { recursive: true, force: true });
}

// ------------------------------------------------------------------------------------------------ mid-run input

test("a steer reaches a running worker and is recorded as an amendment", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }] });
		const id = await start(w);
		const jr = await working(w, id);
		const r = await w.engine.send(id, "name the file greeting.txt in lower case", "steer");
		assert.ok("ok" in r, JSON.stringify(r));
		const steer = w.cmds().find((c) => c.type === "steer");
		assert.match(steer.message, /Amendment 1 \(user\)/);
		assert.match(fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8"), /## Amendment 1 \(user\): name the file/);
		assert.equal(readJob(jr.dir)?.briefVersion, 2);
		await w.engine.stop(id);
	} finally {
		w.end();
	}
});

test("a steer still queued when the worker settles is cleared and sent as a prompt", async () => {
	const w = world();
	try {
		w.write({ worker: [{ delayMs: 900 }, turn("greeting.txt")], judge: [PASS] });
		const id = await start(w);
		await working(w, id);
		const r = await w.engine.send(id, "use a lower case file name", "steer");
		assert.ok("ok" in r, JSON.stringify(r));
		const jr = await ended(w, id);
		const types = w.cmds().map((c) => c.type);
		assert.deepEqual(types.filter((t) => ["prompt", "steer", "clear_queue"].includes(t)), ["prompt", "steer", "clear_queue", "prompt"]);
		assert.match(w.cmds().filter((c) => c.type === "prompt")[1].message, /Amendment 1 \(user\)/);
		assert.equal(jr.job.state, "done");
	} finally {
		w.end();
	}
});

test("a verdict on an old brief version is discarded; the worker gets the amendment and the judge runs again after its next done", async () => {
	const w = world();
	try {
		w.write({ worker: [turn("greeting.txt"), turn("greeting.txt", "hello world\n", "amended")], judge: [{ text: PASS, delayMs: 1500 }, PASS] });
		const id = await start(w);
		const jr = w.engine.get(id)!;
		await waitFor(() => judgeCalls(w) === 1, 30_000, "the judge to start");
		const r = await w.engine.send(id, "the greeting is hello world", "steer");
		assert.ok("ok" in r, JSON.stringify(r));
		await ended(w, id);
		assert.equal(judgeCalls(w), 2);
		const prompts = w.cmds().filter((c) => c.type === "prompt");
		assert.equal(prompts.length, 2);
		assert.match(prompts[1].message, /amended while the job was being reviewed/);
		assert.match(prompts[1].message, /hello world/);
		assert.equal(jr.job.lastVerdict?.briefVersion, 2);
		assert.equal(jr.job.round, 0, "an amendment is not a failed round");
		assert.equal(jr.job.state, "done");
	} finally {
		w.end();
	}
});

test("restart: the critic checks the amendment, the worker is dropped and a new session starts with the amendment (reset base)", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }, turn("greeting.txt")], judge: [PASS] });
		fs.writeFileSync(path.join(w.repo, "a.txt"), "a" + nl + "lead edit" + nl);
		const id = await start(w);
		const jr = await working(w, id);
		const r = await w.engine.send(id, "do it with one file only", "restart", { reset: "base" });
		assert.ok("ok" in r, JSON.stringify(r));
		assert.ok(fs.existsSync(path.join(jr.dir, "critic", "amendment-1.md")));
		const rpc = rpcCalls(w);
		assert.equal(rpc.length, 2);
		assert.ok(!rpc[1].args.includes("-c"), "a restart is a new session");
		assert.match(w.cmds().filter((c) => c.type === "prompt")[1].message, /previous approach is dropped/);
		assert.match(fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8"), /Amendment 1 \(user\): do it with one file only/);
		// the branch was reset to base and the lead's edit is applied again
		assert.equal(fs.readFileSync(path.join(jr.job.repos[0].worktree, "a.txt"), "utf8"), "a" + nl + "lead edit" + nl);
		await ended(w, id);
		assert.equal(jr.job.state, "done");
	} finally {
		w.end();
	}
});

test("restart is refused when the critic finds a blocker in the amendment; nothing changes", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }], critic: ["- blocker - [design] `brief` contradicts the locked decision fix: x\n  Why: y\n  Fix: z\n\nVERDICT: FAIL"] });
		const id = await start(w);
		const jr = await working(w, id);
		const r = await w.engine.send(id, "drop everything", "restart");
		assert.ok("error" in r && /critic found 1 blocker/.test(r.error), JSON.stringify(r));
		assert.equal(jr.job.briefVersion, 1);
		assert.equal(rpcCalls(w).length, 1);
		await w.engine.stop(id);
	} finally {
		w.end();
	}
});

test("an amendment after PASS holds delivery: nothing merges until the new version is judged", async () => {
	let pushing: (() => void) | undefined;
	const slow = new Promise<void>((r) => (pushing = r));
	const w = world({}, undefined, {
		run: async (c, a, d, o) => {
			// the first push of the job branch is slow: the amendment arrives while delivery is in progress
			if (c === "git" && a[0] === "push" && pushing) {
				const go = pushing;
				pushing = undefined;
				go();
				await new Promise((r) => setTimeout(r, 1500));
			}
			return run(c, a, d, o);
		},
	});
	try {
		w.write({ worker: [turn("greeting.txt"), turn("second.txt", "two" + nl)], judge: [PASS, PASS] });
		const mainBefore = git(w.bare!, "rev-parse", "main");
		const id = await start(w, { authority: { merge: "yes (ff)" } });
		await slow;
		const r = await w.engine.send(id, "also add second.txt", "steer");
		assert.ok("ok" in r, JSON.stringify(r));
		await waitFor(() => w.notices.some((n) => /amended/.test(n)), 30_000, "the hold");
		assert.equal(git(w.bare!, "rev-parse", "main"), mainBefore, "nothing merged while the amendment was unjudged");
		const jr = await ended(w, id);
		assert.equal(jr.job.state, "done");
		assert.equal(judgeCalls(w), 2);
		assert.equal(git(w.bare!, "show", "main:second.txt"), "two");
		assert.equal(git(w.bare!, "show", "main:greeting.txt"), "hello");
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ escalation and re-plan

test("escalation: after the judge rounds the worker switches model; then a re-plan; then the job stops", async () => {
	const w = world({ caps: { judge: 2, escalate: 1, replans: 1 } });
	try {
		w.write({ worker: [turn("greeting.txt", "helo\n")], judge: [FAIL] });
		const id = await start(w);
		const jr = w.engine.get(id)!;
		await waitFor(() => jr.job.state === "paused", 60_000, "the re-plan wait");
		assert.equal(jr.job.paused?.why, "replan");
		assert.equal(jr.job.round, 3);
		assert.equal(jr.job.escalated, 1);
		const sm = w.cmds().filter((c) => c.type === "set_model");
		assert.equal(sm.length, 1);
		assert.equal(`${sm[0].provider}/${sm[0].modelId}`, w.cfg.roles.escalate.model);
		assert.ok(w.wakes.some((x) => /relay_replan/.test(x)));
		assert.ok("error" in (await w.engine.resume(id)), "a re-plan wait is not resumed, it is re-planned");
		assert.ok("error" in (await w.engine.deliver(id)));
		// the Targets cannot change
		assert.ok("error" in (await w.engine.replan(id, brief({ repo: w.repo, target: "other" }))));
		const r = await w.engine.replan(id, brief({ repo: w.repo }).replace("One new file.", "Two small files."));
		assert.ok("ok" in r, JSON.stringify(r));
		assert.equal(jr.job.replans, 1);
		assert.equal(jr.job.round, 0);
		assert.equal(jr.job.escalated, 0);
		assert.equal(rpcCalls(w).length, 2);
		assert.ok(!rpcCalls(w)[1].args.includes("-c"), "a re-plan starts a new session");
		const text = fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8");
		assert.match(text, /Two small files/);
		assert.match(text, /re-plan 1/);
		assert.ok(fs.existsSync(path.join(jr.dir, "brief.before-replan-1.md")));
		await ended(w, id);
		assert.equal(jr.job.state, "stopped");
		assert.match(jr.job.endReason ?? "", /judge cap reached \(3 failed rounds, 1 re-plan/);
		assert.equal(judgeCalls(w), 6);
		assert.equal(w.wtCalls.remove.length, 0, "a stopped job keeps its set");
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ stalls and tool timeouts

test("a stall (no events, no tool) aborts and restarts the worker with -c; a second stall pauses the job and wakes the lead", async () => {
	const clock = { t: 1_000_000 };
	const w = world({ budget: { wallMin: 100_000, tokens: 1e12 } }, undefined, { now: () => clock.t });
	try {
		w.write({ worker: [{ hang: true }] });
		const id = await start(w);
		const jr = await working(w, id);
		clock.t += 9 * 60_000;
		await w.engine.tick();
		assert.equal(rpcCalls(w).length, 1, "9 min is not a stall");
		clock.t += 2 * 60_000;
		await w.engine.tick();
		await waitFor(() => rpcCalls(w).length === 2, 30_000, "the restart");
		assert.ok(rpcCalls(w)[1].args.includes("-c"));
		assert.ok(w.notices.some((n) => /stalled/.test(n)));
		assert.equal(jr.job.restarts, 1);
		await waitFor(() => w.cmds().filter((c) => c.type === "prompt").length === 2, 30_000, "the restart prompt");
		clock.t += 11 * 60_000;
		await w.engine.tick();
		await waitFor(() => jr.job.state === "paused", 30_000, "the pause");
		assert.match(jr.job.paused?.why ?? "", /stalled.*restarted once already/);
		assert.ok(w.wakes.some((x) => /again after a restart/.test(x)));
		assert.equal(rpcCalls(w).length, 2);
	} finally {
		w.end();
	}
});

test("a tool running 15 min is not a stall; a bash past its timeout is aborted and counts as a crash", async () => {
	const clock = { t: 1_000_000 };
	const w = world({ budget: { wallMin: 100_000, tokens: 1e12 }, bashTimeoutMin: 60 }, undefined, { now: () => clock.t });
	try {
		w.write({ worker: [{ tool: { name: "bash", args: { command: "npm test" }, hang: true } }, turn("greeting.txt")], judge: [PASS] });
		const id = await start(w);
		const jr = await working(w, id);
		await waitFor(() => jr.tools.size === 1, 30_000, "the tool start");
		clock.t += 15 * 60_000;
		await w.engine.tick();
		assert.equal(rpcCalls(w).length, 1);
		assert.equal(jr.job.state, "working");
		clock.t += 46 * 60_000;
		await w.engine.tick();
		await waitFor(() => rpcCalls(w).length === 2, 30_000, "the restart after the tool timeout");
		assert.ok(w.notices.some((n) => /past its 60 min timeout/.test(n)));
		await ended(w, id);
		assert.equal(jr.job.state, "done");
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ pause, resume

test("a paused job holds; resume restarts the worker with -c and reaches PASS", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }, turn("greeting.txt")], judge: [PASS] });
		const id = await start(w);
		const jr = await working(w, id);
		assert.deepEqual(await w.engine.pause(id), { ok: true });
		assert.equal(jr.job.state, "paused");
		assert.equal(readJob(jr.dir)?.paused?.from, "working");
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(jr.job.state, "paused", "nothing moves a paused job");
		assert.equal(rpcCalls(w).length, 1);
		assert.ok("error" in (await w.engine.deliver(id)), "relay_deliver does not resume a paused worker");
		// an amendment while paused is read when the job continues
		assert.ok("ok" in (await w.engine.send(id, "keep it small", "steer")));
		const r = await w.engine.resume(id);
		assert.ok("ok" in r, JSON.stringify(r));
		assert.ok(rpcCalls(w)[1].args.includes("-c"));
		assert.match(w.cmds().filter((c) => c.type === "prompt")[1].message, /resumed/);
		await ended(w, id);
		assert.equal(jr.job.state, "done");
		assert.ok("error" in (await w.engine.resume(id)));
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ adoption

function expire(dir: string): void {
	for (const f of fs.readdirSync(dir).filter((x) => /^owner\.\d+\.lock$/.test(x))) {
		const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		j.heartbeat = 0;
		fs.writeFileSync(path.join(dir, f), JSON.stringify(j));
	}
}

test("adoption: a new lead takes over a job whose lead went away, restarts the worker with -c and reaches PASS", async () => {
	const w = world();
	let b: ReturnType<World["mk"]> | undefined;
	try {
		w.write({ worker: [{ hang: true }, turn("greeting.txt")], judge: [PASS] });
		const id = await start(w);
		const jr = await working(w, id);
		// a live lead's job is left alone
		const other = w.mk({ me: { pid: process.pid, sessionId: "lead-b", host: "h" } });
		assert.deepEqual(await other.adopt(), [], "the lock is fresh");
		await w.engine.shutdown(); // the lead goes away
		assert.deepEqual(await other.adopt(), [], "still fresh: a heartbeat is only 2 min stale");
		expire(jr.dir);
		b = other;
		b.start();
		assert.deepEqual(await b.adopt(), [id]);
		const jr2 = b.get(id)!;
		await waitFor(() => jr2.ended, 60_000, "the adopted job to end");
		assert.equal(jr2.job.state, "done");
		assert.ok(rpcCalls(w)[1].args.includes("-c"));
		assert.ok(w.notices.some((n) => /taken over/.test(n)));
		assert.equal(readJob(jr.dir)?.state, "done");
		// the old lead no longer owns it
		assert.equal(jr.lock.isOwner(), false);
	} finally {
		await b?.shutdown();
		w.end();
	}
});

test("a reload of the same session re-attaches at once, without waiting for a stale lock", async () => {
	const w = world();
	let b: ReturnType<World["mk"]> | undefined;
	try {
		w.write({ worker: [{ hang: true }, turn("greeting.txt")], judge: [PASS] });
		const id = await start(w);
		await working(w, id);
		await w.engine.shutdown();
		b = w.mk(); // same pid, session and host
		b.start();
		assert.deepEqual(await b.adopt(), [id]);
		assert.ok(w.notices.some((n) => /re-attached/.test(n)));
		const jr2 = b.get(id)!;
		await waitFor(() => jr2.ended, 60_000, "the job to end");
		assert.equal(jr2.job.state, "done");
	} finally {
		await b?.shutdown();
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ PR-only cleanup

test("PR-only cleanup: a done job with a kept set loses it once its PR has merged (OPEN first, then MERGED)", async () => {
	const states = ["OPEN", "MERGED"];
	const w = world({}, undefined, {
		run: async (c, a, d, o) => (c === "gh" && a[0] === "pr" && a[1] === "view" ? { code: 0, stdout: JSON.stringify({ state: states.shift() }), stderr: "" } : run(c, a, d, o)),
	});
	try {
		w.write({ worker: [turn("greeting.txt")], judge: [PASS] });
		const id = await start(w);
		const jr = await ended(w, id);
		assert.equal(jr.job.state, "done");
		assert.ok(fs.existsSync(jr.job.repos[0].worktree), "the set is kept until the PR merges");
		jr.job.repos[0].pr = "https://example.test/pull/1";
		writeJob(jr.dir, jr.job);
		assert.deepEqual(await w.engine.prCleanup(), []);
		assert.equal(w.wtCalls.remove.length, 0);
		assert.deepEqual(await w.engine.prCleanup(), [id]);
		assert.equal(w.wtCalls.remove.length, 1);
		assert.equal(w.wtCalls.remove[0].force, undefined);
		assert.equal(readJob(jr.dir)?.repos[0].merged, true);
		assert.ok(!fs.existsSync(jr.job.repos[0].worktree));
		assert.deepEqual(await w.engine.prCleanup(), [], "nothing left to do");
		assert.equal(listJobs(w.jobRoot).length, 1);
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ follow-ups

/** The judge's task text with the diff part only. */
function diffOf(tasks: string[]): string {
	const t = tasks[tasks.length - 1];
	return t.slice(t.indexOf("## Diff"));
}
function followWorld(cfg: object = {}, script: object) {
	const tasks: string[] = [];
	const w = world(cfg, undefined, {
		runReviewer: (o) => {
			if (/relay-role: judge/.test(o.systemPrompts.join("\n"))) tasks.push(o.task);
			return runSubagent(o);
		},
	});
	w.write(script);
	return { w, tasks };
}

test("follow-up, PR-only, set present: the set is reused; delivery rebases onto the moved target, pushes with the lease, the judge sees only the follow-up", async () => {
	const { w, tasks } = followWorld({}, { worker: [turn("greeting.txt"), turn("b2.txt", "b" + nl)], judge: [PASS, PASS] });
	try {
		const id = await start(w);
		const first = await ended(w, id);
		const r1 = first.job.repos[0];
		assert.equal(first.job.state, "done");
		assert.ok(r1.remotePushed);
		const pushed1 = r1.remotePushed;
		moveMain(w, "up.txt", "u" + nl);
		const before = git(r1.worktree, "rev-parse", "HEAD");
		const f = await w.engine.followup(id, "also add b2.txt");
		assert.deepEqual(f, { ok: true, n: 1, queued: false });
		const jr = w.engine.get(id)!;
		assert.notEqual(jr, first);
		await ended(w, id);
		const job = readJob(jr.dir)!;
		assert.equal(job.state, "done");
		assert.equal(job.followups, 1);
		assert.equal(w.wtCalls.create.length, 1, "the set was reused");
		assert.equal(w.wtCalls.remove.length, 0);
		const r = job.repos[0];
		assert.equal(r.followBase, before);
		const d = diffOf(tasks);
		assert.ok(d.includes("b2.txt") && !d.includes("greeting.txt"), "the judge reviews followBase..HEAD only");
		// the same branch on the remote: rebased onto the moved main, updated with the lease
		const remote = git(w.bare!, "rev-parse", `wt/${id}`);
		assert.equal(remote, r.remotePushed);
		assert.notEqual(remote, pushed1);
		assert.equal(git(w.bare!, "show", `wt/${id}:up.txt`), "u");
		assert.equal(git(w.bare!, "show", `wt/${id}:b2.txt`), "b");
		assert.equal(git(w.bare!, "show", `wt/${id}:greeting.txt`), "hello");
		const report = fs.readFileSync(path.join(jr.dir, "report.md"), "utf8");
		assert.match(report, /## Follow-up 1/);
		assert.match(report, /also add b2\.txt/);
		assert.ok(fs.existsSync(path.join(jr.dir, "report.before-followup-1.md")));
		assert.ok(fs.existsSync(path.join(jr.dir, "sessions", "f1")), "the follow-up has its own session folder");
	} finally {
		w.end();
	}
});

test("follow-up, PR-only, set gone: <id>-f1 starts from origin/<remoteBranch> and pushes to the same remote branch", async () => {
	const { w, tasks } = followWorld({}, { worker: [turn("greeting.txt"), turn("b2.txt", "b" + nl)], judge: [PASS, PASS] });
	try {
		const id = await start(w);
		const first = await ended(w, id);
		const remoteBranch = first.job.repos[0].remoteBranch!;
		assert.equal(remoteBranch, `wt/${id}`);
		await w.wt.remove({ name: first.job.set }); // the set is gone
		moveMain(w, "up.txt", "u" + nl);
		const f = await w.engine.followup(id, "also add b2.txt");
		assert.ok("ok" in f, JSON.stringify(f));
		await ended(w, id);
		const job = readJob(w.engine.get(id)!.dir)!;
		assert.equal(job.state, "done");
		assert.equal(job.set, `${id}-f1`);
		assert.equal(w.wtCalls.create[1].name, `${id}-f1`);
		assert.equal(w.wtCalls.create[1].bases[w.repo], `origin/${remoteBranch}`);
		assert.equal(job.repos[0].branch, `wt/${id}-f1`);
		assert.equal(job.repos[0].remoteBranch, remoteBranch);
		assert.equal(git(w.bare!, "show", `${remoteBranch}:b2.txt`), "b");
		assert.equal(git(w.bare!, "show", `${remoteBranch}:up.txt`), "u");
		assert.equal(git(w.bare!, "branch", "--list", `wt/${id}-f1`), "", "only the original remote branch is pushed");
		assert.ok(!diffOf(tasks).includes("greeting.txt"));
	} finally {
		w.end();
	}
});

test("follow-up on a stopped job reuses its set", async () => {
	const { w } = followWorld({}, { worker: [{ hang: true }, turn("b2.txt", "b" + nl)], judge: [PASS] });
	try {
		const id = await start(w);
		const first = await working(w, id);
		await w.engine.stop(id);
		assert.equal(first.job.state, "stopped");
		const f = await w.engine.followup(id, "do b2.txt instead");
		assert.ok("ok" in f, JSON.stringify(f));
		const jr = w.engine.get(id)!;
		await ended(w, id);
		assert.equal(jr.job.state, "done");
		assert.equal(w.wtCalls.create.length, 1);
		assert.equal(jr.job.set, id);
		assert.equal(git(w.bare!, "show", `wt/${id}:b2.txt`), "b");
	} finally {
		w.end();
	}
});

test("follow-up on a merged job whose set was kept (W2 refused): <id>-f1 from origin/<target>, a new branch, the old remote branch untouched, W2 tried again", async () => {
	const { w, tasks } = followWorld({}, { worker: [turn("greeting.txt"), turn("b2.txt", "b" + nl)], judge: [PASS, PASS] });
	try {
		w.wtCalls.refuse = 1; // the cleanup of the merged job is refused
		const id = await start(w, { authority: { merge: "yes (ff)" } });
		const first = await ended(w, id);
		assert.ok(first.job.repos[0].merged);
		assert.ok(fs.existsSync(first.job.repos[0].worktree), "the set was kept");
		assert.equal(w.wtCalls.remove.length, 1);
		const oldRemote = git(w.bare!, "rev-parse", `wt/${id}`);
		moveMain(w, "up.txt", "u" + nl);
		const oldSet = first.job.set;
		const f = await w.engine.followup(id, "also add b2.txt");
		assert.ok("ok" in f, JSON.stringify(f));
		await ended(w, id);
		const job = readJob(w.engine.get(id)!.dir)!;
		assert.equal(job.state, "done");
		assert.equal(w.wtCalls.create[1].bases[w.repo], "origin/main");
		assert.equal(job.repos[0].branch, `wt/${id}-f1`);
		assert.equal(job.repos[0].remoteBranch, `wt/${id}-f1`, "a new branch: delivery opens a new PR");
		assert.equal(git(w.bare!, "rev-parse", `wt/${id}`), oldRemote, "the old remote branch is left alone");
		assert.ok(w.wtCalls.remove.slice(1).some((c) => c.name === oldSet), "W2 was tried again on the old set");
		assert.ok(!fs.existsSync(path.join(w.sets, oldSet)));
		assert.equal(git(w.bare!, "show", "main:b2.txt"), "b");
		assert.equal(git(w.bare!, "show", "main:up.txt"), "u");
		const d = diffOf(tasks);
		assert.ok(d.includes("b2.txt") && !d.includes("greeting.txt"));
		assert.ok(job.repos[0].merged);
	} finally {
		w.end();
	}
});

test("follow-up on a merged job whose set is gone: same, without the W2 retry", async () => {
	const { w } = followWorld({}, { worker: [turn("greeting.txt"), turn("b2.txt", "b" + nl)], judge: [PASS, PASS] });
	try {
		const id = await start(w, { authority: { merge: "yes (ff)" } });
		const first = await ended(w, id);
		assert.ok(first.job.repos[0].merged);
		assert.ok(!fs.existsSync(first.job.repos[0].worktree), "cleanup removed the set");
		assert.equal(w.wtCalls.remove.length, 1);
		moveMain(w, "up.txt", "u" + nl);
		const f = await w.engine.followup(id, "also add b2.txt");
		assert.ok("ok" in f, JSON.stringify(f));
		await ended(w, id);
		const job = readJob(w.engine.get(id)!.dir)!;
		assert.equal(job.state, "done");
		assert.equal(w.wtCalls.create[1].bases[w.repo], "origin/main");
		assert.equal(w.wtCalls.remove.filter((c) => c.name === first.job.set).length, 1, "the old set was not removed again");
		assert.equal(git(w.bare!, "show", "main:b2.txt"), "b");
		assert.equal(git(w.bare!, "show", "main:up.txt"), "u");
	} finally {
		w.end();
	}
});

test("a follow-up is refused for a running job, an unknown job, an empty text; a critic blocker changes nothing", async () => {
	const { w } = followWorld({ caps: { judge: 3, escalate: 0, replans: 0 } }, { worker: [turn("greeting.txt")], judge: [PASS], critic: ["- blocker - [design] `brief` bad fix: x\n  Why: y\n  Fix: z\n\nVERDICT: FAIL"] });
	try {
		const id = await start(w);
		const jr = await ended(w, id);
		assert.ok("error" in (await w.engine.followup("rzzzzzz", "x")));
		assert.ok("error" in (await w.engine.followup(id, "   ")));
		const before = fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8");
		const r = await w.engine.followup(id, "something bad");
		assert.ok("error" in r && /critic found 1 blocker/.test(r.error), JSON.stringify(r));
		assert.equal(fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8"), before);
		assert.equal(readJob(jr.dir)?.state, "done");
		assert.ok(fs.existsSync(path.join(jr.dir, "report.md")));
		assert.equal(readJob(jr.dir)?.followups, 0);
	} finally {
		w.end();
	}
});
