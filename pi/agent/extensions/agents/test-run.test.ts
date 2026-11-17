// node --test test-run.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { acquireLock, lockFile } from "./lock.ts";
import { callDir, formatTaskResult, LOCK_LOST, parseRunnerReply, runnerGate, sanitizeIds, scheduleTasks, verifyRun } from "./test-run.ts";
import type { ToolCall } from "./subagent.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the tasks through scheduleTasks and records the most that were active at once, overall and per resource. */
async function trace(resources: string[], concurrency: number) {
	const tasks = resources.map((resource, i) => ({ resource, n: i }));
	let active = 0;
	let maxActive = 0;
	const perResource = new Map<string, number>();
	let maxPerResource = 0;
	const results = await scheduleTasks(tasks, concurrency, async (t) => {
		active++;
		maxActive = Math.max(maxActive, active);
		const k = t.resource.trim().toLowerCase();
		perResource.set(k, (perResource.get(k) ?? 0) + 1);
		if (k !== "none") maxPerResource = Math.max(maxPerResource, perResource.get(k) as number);
		await sleep(5);
		perResource.set(k, (perResource.get(k) as number) - 1);
		active--;
		return t.n;
	});
	return { results, maxActive, maxPerResource };
}

test("same resource never overlaps; results keep input order", async () => {
	const r = await trace(["unity:p", "unity:p", "UNITY:p ", "unity:p"], 4);
	assert.equal(r.maxPerResource, 1);
	assert.deepEqual(r.results, [0, 1, 2, 3]);
});

test("different resources run together", async () => {
	const r = await trace(["device:a", "device:b", "unity:p"], 4);
	assert.equal(r.maxActive, 3);
});

test("concurrency is respected", async () => {
	const r = await trace(["none", "none", "none", "none", "none", "none"], 2);
	assert.equal(r.maxActive, 2);
});

test("concurrency 1 is serial", async () => {
	const r = await trace(["none", "device:a", "device:b", ""], 1);
	assert.equal(r.maxActive, 1);
	assert.deepEqual(r.results, [0, 1, 2, 3]);
});

test("sanitizeIds gives unique, safe IDs", () => {
	const ids = sanitizeIds(["a b", "a b", "", "x".repeat(80)]);
	assert.deepEqual(ids.slice(0, 3), ["a_b", "a_b-2", "task3"]);
	assert.equal(new Set(ids).size, ids.length);
	for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,40}$/);
});

test("parseRunnerReply", () => {
	const r = parseRunnerReply("RESULT: PASS\nCommand: unity run-tests\nExit: 0\nObserved:\n12 passed\nArtifacts: a.log, b.png");
	assert.equal(r.result, "PASS");
	assert.equal(r.command, "unity run-tests");
	assert.equal(r.exit, "0");
	assert.equal(r.observed, "12 passed");
	assert.deepEqual(r.artifacts, ["a.log", "b.png"]);
	const none = parseRunnerReply("I ran it, all good");
	assert.equal(none.result, "ERROR");
	assert.match(none.note ?? "", /no RESULT line/);
});

test("Observed is cut to 40 lines", () => {
	const text = `RESULT: FAIL\nObserved:\n${Array.from({ length: 90 }, (_, i) => `line ${i}`).join("\n")}\nArtifacts: none`;
	const r = parseRunnerReply(text);
	assert.equal(r.observed.split("\n").length, 40);
	assert.deepEqual(r.artifacts, []);
});

const bash = (command: string, isError = false): ToolCall => ({ id: "1", name: "bash", args: { command }, isError });

test("verifyRun marks unverified claims", () => {
	const pass = parseRunnerReply("RESULT: PASS");
	const fail = parseRunnerReply("RESULT: FAIL");
	assert.equal(verifyRun(pass, []).status, "PASS (unverified: no command was run)");
	assert.equal(verifyRun(pass, [bash("x", true)]).status, "PASS (unverified: 1 command(s) failed)");
	assert.equal(verifyRun(pass, [bash("x")]).status, "PASS");
	assert.equal(verifyRun(fail, [bash("x", true)]).status, "FAIL");
	assert.equal(verifyRun(fail, []).status, "FAIL (unverified: no command was run)");
	assert.deepEqual(verifyRun(pass, [{ id: "2", name: "read", args: {} }, bash("ls")]).ran, [{ ok: true, command: "ls" }]);
});

test("formatTaskResult lists the commands actually run", () => {
	const reply = parseRunnerReply("RESULT: PASS\nCommand: ls\nExit: 0\nObserved:\nok");
	const text = formatTaskResult({ id: "t1", resource: "none", status: "PASS", reply, ran: [{ ok: true, command: "ls" }], record: "/r/t1.md" });
	assert.match(text, /### t1 · none · PASS/);
	assert.match(text, /Commands actually run \(1\):\n- ok `ls`/);
	assert.match(text, /Record: \/r\/t1\.md/);
});

async function gateTrace(limit: number, resources: string[]) {
	const gate = runnerGate(() => limit);
	let active = 0;
	let max = 0;
	await Promise.all(
		resources.map((r) =>
			gate(r, async () => {
				active++;
				max = Math.max(max, active);
				await sleep(15);
				active--;
			}),
		),
	);
	return max;
}

test("runnerGate: one runner per resource across calls", async () => {
	assert.equal(await gateTrace(4, ["unity:D:/p", "unity:D:/p"]), 1);
	assert.equal(await gateTrace(4, ["unity:D:/p", "device:A"]), 2);
	assert.equal(await gateTrace(4, ["UNITY:D:/P", "unity:d:/p"]), 1);
});

test("runnerGate: global limit", async () => {
	assert.equal(await gateTrace(1, ["none", "none", "none"]), 1);
	assert.equal(await gateTrace(3, ["none", "", "none"]), 3);
});

test("runnerGate: releases on error", async () => {
	const gate = runnerGate(() => 2);
	await assert.rejects(gate("device:A", async () => { throw new Error("boom"); }), /boom/);
	assert.equal(await gate("device:A", async () => 7), 7);
});

test("callDir: next free numbered folder", () => {
	const made: string[] = [];
	let fail = 1;
	const fsx = {
		readdirSync: () => ["1", "a.md"],
		mkdirSync: (p: string) => {
			if (fail-- > 0) throw Object.assign(new Error("x"), { code: "EEXIST" });
			made.push(p);
		},
	};
	const join = (...p: string[]) => p.join("/");
	assert.equal(callDir("r", fsx, join), "r/3");
	assert.throws(() => callDir("r", { ...fsx, mkdirSync: () => { throw Object.assign(new Error("no"), { code: "EACCES" }); } }, join), /no/);
	assert.equal(callDir("r", { ...fsx, mkdirSync: (p: string) => made.push(p) }, join), "r/2");
});

test("runnerGate: waiting runners start in order", async () => {
	const gate = runnerGate(() => 1);
	const order: string[] = [];
	await Promise.all(["A", "B", "C"].map((n) => gate("none", async () => { order.push(n); await sleep(5); })));
	assert.deepEqual(order, ["A", "B", "C"]);
});

test("runnerGate: a newcomer does not take a freed slot from a waiter", async () => {
	for (let ticks = 0; ticks < 12; ticks++) {
		const gate = runnerGate(() => 1);
		const order: string[] = [];
		let releaseA = () => {};
		const a = gate("none", async () => {
			order.push("A");
			await new Promise<void>((r) => (releaseA = r));
		});
		const b = gate("none", async () => {
			order.push("B");
		});
		await sleep(5);
		releaseA();
		for (let i = 0; i < ticks; i++) await Promise.resolve();
		const d = gate("none", async () => {
			order.push("D");
		});
		await Promise.all([a, b, d]);
		assert.deepEqual(order, ["A", "B", "D"], `D after ${ticks} microtasks`);
	}
});

test("runnerGate: an aborted waiter does not block the next one", async () => {
	const gate = runnerGate(() => 4);
	const order: string[] = [];
	let open = () => {};
	const first = gate("device:A", () => new Promise<void>((r) => (open = () => { order.push("first"); r(); })));
	const ac = new AbortController();
	const second = gate("device:A", async () => { order.push("second"); }, ac.signal);
	const third = gate("device:A", async () => { order.push("third"); });
	await sleep(5);
	ac.abort();
	await assert.rejects(second, /aborted/);
	assert.deepEqual(order, [], "the third still waits for the first");
	open();
	await Promise.all([first, third]);
	assert.deepEqual(order, ["first", "third"]);
});

test("runnerGate: a slot wait stops on abort and frees nothing it does not hold", async () => {
	const gate = runnerGate(() => 1);
	let open = () => {};
	const first = gate("none", () => new Promise<void>((r) => (open = r)));
	const ac = new AbortController();
	const second = gate("none", async () => 2, ac.signal);
	await sleep(5);
	ac.abort();
	await assert.rejects(second, /aborted/);
	open();
	await first;
	assert.equal(await gate("none", async () => 3), 3);
});

test("runnerGate: the file lock is taken after the resource wait and before the slot, and released", async () => {
	const events: string[] = [];
	const lock = async (r: string) => {
		events.push(`lock ${r}`);
		return { release: () => events.push(`unlock ${r}`) };
	};
	const gate = runnerGate(() => 1, lock);
	await Promise.all([gate("device:A", async () => { events.push("run 1"); await sleep(5); }), gate("device:A", async () => { events.push("run 2"); }), gate("none", async () => { events.push("run none"); })]);
	assert.deepEqual(events.filter((e) => e.includes("device")), ["lock device:A", "unlock device:A", "lock device:A", "unlock device:A"]);
	assert.equal(events.filter((e) => e.startsWith("run")).length, 3);
	assert.ok(!events.includes("lock none"));
});

test("runnerGate: the task gets the held file lock's signal; a lock taken over by another process aborts it (resource lock lost)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-gate-lock-"));
	const gate = runnerGate(() => 2, (resource, signal) => acquireLock(resource, { dir, signal, pollMs: 5, heartbeatMs: 10 }));
	const out = await gate("device:Z", async (lockSignal) => {
		assert.ok(lockSignal, "a shared resource has a file lock");
		assert.equal(lockSignal.aborted, false);
		// another process takes the lock file over
		const file = lockFile("device:Z", dir);
		fs.rmSync(file);
		fs.writeFileSync(file, JSON.stringify({ token: "other", pid: process.pid }));
		await new Promise<void>((r) => lockSignal.addEventListener("abort", () => r(), { once: true }));
		return `stopped: ${(lockSignal.reason as Error).message}`;
	});
	assert.equal(out, `stopped: ${LOCK_LOST}`);
	assert.equal(JSON.parse(fs.readFileSync(lockFile("device:Z", dir), "utf8")).token, "other", "the new owner's lock is kept");
	assert.equal(await gate("none", async (lockSignal) => lockSignal), undefined, "no file lock for a task without a resource");
});
