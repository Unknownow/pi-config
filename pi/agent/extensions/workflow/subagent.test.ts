// node --experimental-strip-types --test subagent.test.ts
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { idleWatch, recordToolEvent, type ToolCall } from "./subagent.ts";

const start = (id: string, name: string, args?: unknown) => ({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
const end = (id: string, name: string, isError: boolean) => ({ type: "tool_execution_end", toolCallId: id, toolName: name, isError });

test("records tool calls and their outcome", () => {
	const calls: ToolCall[] = [];
	for (const e of [start("1", "read", { path: "a" }), start("2", "mcp__k__status"), end("2", "mcp__k__status", true), end("1", "read", false)]) recordToolEvent(calls, e);
	assert.deepEqual(calls, [
		{ id: "1", name: "read", args: { path: "a" }, isError: false },
		{ id: "2", name: "mcp__k__status", args: {}, isError: true },
	]);
});

test("an end without a start, and other event types, change nothing", () => {
	const calls: ToolCall[] = [];
	recordToolEvent(calls, end("9", "read", false));
	recordToolEvent(calls, { type: "message_end" });
	recordToolEvent(calls, { type: "message_update", toolCallId: "1" });
	assert.deepEqual(calls, []);
});

test("keeps the start of the result text", () => {
	const calls: ToolCall[] = [];
	recordToolEvent(calls, start("1", "mcp__k__get_rule_pack"));
	recordToolEvent(calls, { ...end("1", "mcp__k__get_rule_pack", false), result: { content: [{ type: "text", text: "x".repeat(5000) }] } });
	assert.equal(calls[0].result, "x".repeat(4000));
});

test("a start without an end leaves isError undefined", () => {
	const calls: ToolCall[] = [];
	recordToolEvent(calls, start("1", "read", { path: "a" }));
	assert.equal(calls.length, 1);
	assert.equal(calls[0].isError, undefined);
});

function watch(ms: number) {
	mock.timers.enable({ apis: ["setTimeout"] });
	let fired = 0;
	return { w: idleWatch(ms, () => fired++), fired: () => fired };
}

test("idleWatch fires after ms of silence", () => {
	const { fired } = watch(1000);
	mock.timers.tick(999);
	assert.equal(fired(), 0);
	mock.timers.tick(1);
	assert.equal(fired(), 1);
	mock.timers.reset();
});

test("idleWatch: activity restarts the timer", () => {
	const { w, fired } = watch(1000);
	mock.timers.tick(800);
	w.activity();
	mock.timers.tick(800);
	assert.equal(fired(), 0);
	mock.timers.tick(200);
	assert.equal(fired(), 1);
	mock.timers.reset();
});

test("idleWatch: no timer while a tool runs", () => {
	const { w, fired } = watch(1000);
	w.toolStart();
	mock.timers.tick(10_000);
	assert.equal(fired(), 0);
	w.toolEnd();
	mock.timers.tick(1000);
	assert.equal(fired(), 1);
	mock.timers.reset();
});

test("idleWatch: nested tools and an extra toolEnd", () => {
	const { w, fired } = watch(1000);
	w.toolStart();
	w.toolStart();
	w.toolEnd();
	mock.timers.tick(5000);
	assert.equal(fired(), 0);
	w.toolEnd();
	w.toolEnd();
	mock.timers.tick(1000);
	assert.equal(fired(), 1);
	mock.timers.reset();
});

test("idleWatch: 0 disables", () => {
	const { fired } = watch(0);
	mock.timers.tick(1e9);
	assert.equal(fired(), 0);
	mock.timers.reset();
});

test("idleWatch: stop cancels", () => {
	const { w, fired } = watch(1000);
	w.stop();
	mock.timers.tick(5000);
	assert.equal(fired(), 0);
	mock.timers.reset();
});
