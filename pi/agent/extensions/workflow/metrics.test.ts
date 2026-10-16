// node --experimental-strip-types --test metrics.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { appendMetrics, type MetricEvent, MetricsQueue, subagentMetric } from "./metrics.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "metrics-"));
const ev = (flowId?: string, n = 0): MetricEvent => ({ kind: "compaction", at: "t", flowId, reason: "guard", tokensBefore: n, ms: 1, ok: true });
const lines = (dir: string) => fs.readFileSync(path.join(dir, "metrics.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("subagentMetric maps a RunResult", () => {
	const r: any = {
		ok: true,
		text: "x",
		turns: 3,
		bootMs: 1200,
		usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, totalTokens: 117, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } },
		toolCalls: [{}, {}],
	};
	const e: any = subagentMetric("judge", "review", "judge", "m", 1000, 3500, r);
	assert.equal(e.kind, "subagent");
	assert.equal(e.ms, 2500);
	assert.equal(e.bootMs, 1200);
	assert.equal(e.turns, 3);
	assert.equal(e.tools, 2);
	assert.equal(e.cost, 0.5);
	assert.deepEqual(e.tokens, { input: 10, output: 5, cacheRead: 100, cacheWrite: 2 });
	assert.equal(e.ok, true);
});

test("appendMetrics writes one JSON line per event and never creates folders", () => {
	const d = tmp();
	assert.equal(appendMetrics(d, [ev("F", 1), ev("F", 2)]), true);
	assert.deepEqual(lines(d), [ev("F", 1), ev("F", 2)]);
	const missing = path.join(d, "nope");
	assert.equal(appendMetrics(missing, [ev("F")]), false);
	assert.equal(fs.existsSync(missing), false);
});

test("flush keeps events of an unknown flow and writes them once its folder is known", () => {
	const d = tmp();
	const q = new MetricsQueue();
	q.record(ev("F"));
	q.flush(() => undefined);
	assert.equal(q.size, 1);
	q.flush((id) => (id === "F" ? d : undefined));
	assert.equal(q.size, 0);
	assert.equal(lines(d).length, 1);
});

test("events without a flow attach to the active flow on flush", () => {
	const d = tmp();
	const q = new MetricsQueue();
	q.record(ev());
	q.flush(() => d);
	assert.equal(q.size, 1);
	q.flush((id) => (id === "F" ? d : undefined), "F");
	assert.equal(q.size, 0);
	assert.equal(lines(d)[0].flowId, "F");
});

test("an event whose flow folder is gone is dropped", () => {
	const q = new MetricsQueue();
	q.record(ev("F"));
	q.flush(() => path.join(tmp(), "gone"));
	assert.equal(q.size, 0);
});

test("queue keeps at most 1000 events, dropping the oldest", () => {
	const d = tmp();
	const q = new MetricsQueue();
	for (let i = 0; i < 1005; i++) q.record(ev("F", i));
	assert.equal(q.size, 1000);
	q.flush(() => d);
	assert.equal(lines(d)[0].tokensBefore, 5);
});

test("clear empties the queue", () => {
	const q = new MetricsQueue();
	q.record(ev("F"));
	q.clear();
	assert.equal(q.size, 0);
});
