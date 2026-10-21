// node --test test-run.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTaskResult, parseRunnerReply, sanitizeIds, scheduleTasks, verifyRun } from "./test-run.ts";
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
