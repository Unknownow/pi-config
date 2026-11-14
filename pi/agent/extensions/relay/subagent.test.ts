// node --experimental-strip-types --test subagent.test.ts
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { baseArgs, idleWatch, recordToolEvent, type ToolCall } from "./subagent.ts";

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

test("baseArgs adds --no-context-files only when asked", () => {
	const o = { role: { model: "m" }, extensions: [], tools: ["read"] };
	assert.ok(baseArgs({ ...o, noContextFiles: true }).includes("--no-context-files"));
	assert.ok(!baseArgs(o).includes("--no-context-files"));
	assert.ok(!baseArgs({ ...o, noContextFiles: false }).includes("--no-context-files"));
});


test("baseArgs: -ne -ns -np, trust follows the lead", () => {
	const o = { role: { model: "p/m" }, extensions: ["/x/reviewer.ts"], tools: ["read"] };
	const a = baseArgs(o);
	for (const f of ["--no-session", "-ne", "-ns", "-np"]) assert.ok(a.includes(f), f);
	assert.ok(!a.includes("-a") && !a.includes("-na"));
	assert.ok(baseArgs({ ...o, trusted: true }).includes("-a"));
	assert.ok(baseArgs({ ...o, trusted: false }).includes("-na"));
	assert.ok(!a.includes("--no-extensions"));
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runSubagent } from "./subagent.ts";

test("with RELAY_PI_BIN=fake-pi.mjs the judge returns the fake's scripted verdict, and the spawn args carry -ne -ns -np and the reviewer extension", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sub-"));
	const script = path.join(dir, "script.json");
	fs.writeFileSync(script, JSON.stringify({ judge: ["- major - [bug] `x.ts:1` broken fix: auto\n  Why: a\n  Fix: b\nVERDICT: FAIL", "VERDICT: PASS"] }));
	const prev = { bin: process.env.RELAY_PI_BIN, script: process.env.FAKE_PI_SCRIPT };
	process.env.RELAY_PI_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "test", "fake-pi.mjs");
	process.env.FAKE_PI_SCRIPT = script;
	try {
		const run = () => runSubagent({ role: { model: "p/m", thinking: "high" }, systemPrompts: ["<!-- relay-role: judge -->\nrules"], tools: ["read", "grep"], task: "judge it", cwd: dir, extensions: ["/x/reviewer.ts"], timeoutMs: 30_000, trusted: false });
		const a = await run();
		assert.ok(a.ok && /VERDICT: FAIL/.test(a.text));
		const b = await run();
		assert.ok(b.ok && /VERDICT: PASS/.test(b.text));
		const calls = fs.readFileSync(`${script}.calls.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(calls[0].role, "judge");
		for (const f of ["-ne", "-ns", "-np", "-na", "--no-session"]) assert.ok(calls[0].args.includes(f), f);
		assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("-e"), calls[0].args.indexOf("-e") + 2), ["-e", "/x/reviewer.ts"]);
	} finally {
		if (prev.bin === undefined) delete process.env.RELAY_PI_BIN;
		else process.env.RELAY_PI_BIN = prev.bin;
		if (prev.script === undefined) delete process.env.FAKE_PI_SCRIPT;
		else process.env.FAKE_PI_SCRIPT = prev.script;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
