import assert from "node:assert/strict";
import { test } from "node:test";
import { countSubagent } from "./agent-events.ts";

const ev = { role: "advisor", label: "[error] q", ms: 1200, model: "m/x", ok: true, turns: 2, tools: 3, usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, cost: { total: 0.5 } } };

test("a finished run counts while a flow is active", () => {
	const c = countSubagent(ev, "execute", "execute", Date.parse("2026-01-01T00:00:00Z"));
	assert.ok(c);
	assert.equal(c.metric.kind, "subagent");
	assert.equal(c.metric.kind === "subagent" && c.metric.stage, "execute");
	assert.equal(c.metric.kind === "subagent" && c.metric.tools, 3);
	assert.equal(c.metric.kind === "subagent" && c.metric.cost, 0.5);
	assert.equal(c.event.usage.cacheRead, 100);
});

test("outside a flow the event is ignored", () => {
	assert.equal(countSubagent(ev, "off", "execute"), undefined);
});

test("only the advisor resets the error counter", () => {
	assert.equal(countSubagent(ev, "execute", "execute")?.resetErrors, true);
	assert.equal(countSubagent({ ...ev, role: "explore" }, "execute", "execute")?.resetErrors, false);
});

test("malformed events are dropped, missing numbers count as 0", () => {
	assert.equal(countSubagent(null, "execute", "execute"), undefined);
	assert.equal(countSubagent({ role: "explore" }, "execute", "execute"), undefined);
	const c = countSubagent({ role: "explore", model: "m/x", usage: {} }, "plan", "plan");
	assert.equal(c?.event.usage.input, 0);
	assert.equal(c?.event.ok, false);
});
