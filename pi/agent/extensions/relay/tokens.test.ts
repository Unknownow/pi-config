// node --experimental-strip-types --import ../agents/test-hooks.ts --test tokens.test.ts
// The job token cap's sources, each priced by agents costOf (weighted tokens x model multiplier): the worker per its model
// (escalation included), the judge, the critic of amendments, relay_critic draft rounds, and the worker's agents tools
// (agents-usage.jsonl, counted once by byte offset, also across a lead change); the advisor cap per job.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { costOf, emptyUsage } from "../agents/api.ts";
import { readJob } from "./job.ts";
import { criticRound } from "./steps/critic.ts";
import { brief, type World, waitFor, world } from "./test/env.ts";
import { advisorRunsUsed, readNewUsage } from "./usage.ts";

const FAIL = "- major - [bug] `greeting.txt:1` - wrong greeting fix: auto\n  Why: it should say hello.\n  Fix: say hello.\nVERDICT: FAIL";
const PASS = "VERDICT: PASS";
const turn = (content: string) => ({ write: [{ file: "greeting.txt", content }], done: "ok" });
/** One fake run: input 100, output 50 -> 100 + 50 x 5 = 350 weighted tokens. */
const RUN = 350;
const rpcCalls = (w: World) => w.calls().filter((c) => c.mode === "rpc");

async function ended(w: World, id: string, ms = 60_000) {
	const jr = w.engine.get(id)!;
	await waitFor(() => jr.ended, ms, `job ${id} to end (state ${jr.job.state}; wakes: ${w.wakes.join(" | ").slice(0, 300)})`);
	return jr;
}

test("the model multiplier: costOf prices the same usage by Haiku 0.2, Sonnet 0.6, Opus 1.0 (agents.json modelCost)", () => {
	const u = { ...emptyUsage(), input: 100, output: 50 };
	assert.equal(costOf(u, "claude-bridge/claude-haiku-5-5"), RUN * 0.2);
	assert.equal(costOf(u, "claude-bridge/claude-sonnet-5-5"), RUN * 0.6);
	assert.equal(costOf(u, "claude-bridge/claude-opus-5-5"), RUN);
});

test("worker tokens follow its model: a small job on Haiku, then the escalate model (Opus) after the judge cap; every judge run counts", async () => {
	const w = world({ caps: { judge: 1, escalate: 1, replans: 0 } });
	try {
		w.write({ worker: [turn("helo\n"), turn("hello\n")], judge: [FAIL, PASS] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }), size: "small" });
		assert.ok("id" in r, JSON.stringify(r));
		if (!("id" in r)) return;
		const jr = await ended(w, r.id);
		assert.equal(jr.job.state, "done", jr.job.endReason);
		assert.equal(jr.job.escalated, 1);
		assert.ok(w.cmds().some((c) => c.type === "set_model" && /opus/.test(c.modelId)), "the worker was switched to the escalate model");
		// turn 1 on Haiku, the FAIL judge run, turn 2 on Opus, the PASS judge run (the scripted judge's model "fake" is 1.0)
		assert.equal(readJob(jr.dir)!.used.tokens, RUN * 0.2 + RUN + RUN + RUN);
	} finally {
		w.end();
	}
});

test("relay_critic draft rounds are added at dispatch; the critic of a restart counts; the reviewers get relay's limits and trust", async () => {
	const w = world({}, undefined, { trusted: () => false });
	try {
		w.write({ worker: [{ hang: true }, turn("hello\n")], judge: [PASS], critic: [PASS] });
		const text = brief({ repo: w.repo });
		const round = await criticRound({ cfg: w.cfg, root: w.jobRoot, cwd: w.repo, critic: (req) => w.engine.critic(req) }, text);
		assert.ok(!("error" in round) && round.ran);
		if ("error" in round) return;
		const r = await w.engine.dispatch({ brief: text, draft: round.draft });
		assert.ok("id" in r, JSON.stringify(r));
		if (!("id" in r)) return;
		const jr = w.engine.get(r.id)!;
		assert.equal(jr.job.used.tokens, RUN, "the draft's critic round");
		await waitFor(() => jr.job.state === "working" && jr.ws.alive && w.cmds().some((c) => c.type === "prompt") && !jr.driving, 30_000, "the worker to start");
		const re = await w.engine.send(r.id, "start over with a simpler file", "restart");
		assert.ok("ok" in re, JSON.stringify(re));
		const done = await ended(w, r.id);
		assert.equal(done.job.state, "done", `${done.job.endReason} ${w.wakes.join("|")}`);
		// draft critic + restart critic + one worker turn (Sonnet 0.6; the hung turn reported nothing) + the judge
		assert.equal(readJob(jr.dir)!.used.tokens, RUN + RUN + RUN * 0.6 + RUN);
		const reviews = w.calls().filter((c) => c.mode === "json");
		assert.deepEqual(reviews.map((c) => c.role), ["critic", "critic", "judge"]);
		for (const c of reviews) assert.deepEqual([c.timeoutMs, c.idleTimeoutMs, c.trusted], [30 * 60_000, 10 * 60_000, false]);
	} finally {
		w.end();
	}
});

test("agents-usage.jsonl: complete lines count once by byte offset (saved in job.json); a re-attached lead goes on from it; the advisor cap is per job", async () => {
	const w = world();
	let b: ReturnType<World["mk"]> | undefined;
	try {
		w.write({ worker: [{ hang: true }, { hang: true }] });
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r);
		if (!("id" in r)) return;
		const jr = w.engine.get(r.id)!;
		await waitFor(() => jr.job.state === "working" && jr.ws.alive, 30_000, "the worker to start");
		const file = path.join(jr.dir, "agents-usage.jsonl");
		await waitFor(() => rpcCalls(w).length === 1, 30_000, "the worker process");
		assert.equal(rpcCalls(w)[0].env.PI_AGENTS_ADVISOR_CAP, "3");
		const line = (role: string, weightedCost: number, ok = true) => `${JSON.stringify({ role, model: "m", usage: emptyUsage(), weightedCost, ok, at: "" })}\n`;
		const first = line("advisor", 1000, false) + line("explore", 500);
		fs.appendFileSync(file, `${first}${line("advisor", 7).slice(0, 20)}`);
		await waitFor(() => jr.job.used.tokens >= 1500, 30_000, "the usage lines to be counted");
		await waitFor(() => readJob(jr.dir)?.usageOffset === Buffer.byteLength(first), 30_000, "the offset in job.json");
		assert.equal(jr.job.used.tokens, 1500, "a line still being written waits");
		fs.appendFileSync(file, line("advisor", 7).slice(20));
		await waitFor(() => jr.job.used.tokens === 1507, 30_000, "the completed line");
		const offset = fs.statSync(file).size;
		await waitFor(() => readJob(jr.dir)?.usageOffset === offset, 30_000, "the new offset saved");
		// the lead goes away; the same session re-attaches: nothing is counted twice, the worker restarts with the advisor runs left
		await w.engine.shutdown();
		b = w.mk();
		b.start();
		assert.deepEqual(await b.adopt(), [r.id]);
		const jr2 = b.get(r.id)!;
		await waitFor(() => rpcCalls(w).length === 2, 30_000, "the restarted worker");
		assert.equal(rpcCalls(w)[1].env.PI_AGENTS_ADVISOR_CAP, "1", "3 minus 2 advisor runs, the failed one included");
		fs.appendFileSync(file, line("test_run", 3));
		await waitFor(() => jr2.job.used.tokens === 1510, 30_000, "only the new line counted");
		assert.equal(advisorRunsUsed(file), 2);
		assert.deepEqual(readNewUsage(file, fs.statSync(file).size), { cost: 0, offset: fs.statSync(file).size });
		await b.stop(r.id);
	} finally {
		await b?.shutdown();
		w.end();
	}
});
