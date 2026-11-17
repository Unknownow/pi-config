// node --experimental-strip-types --test mcp-forward.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import mcpForward, { FORWARD_ENV } from "./mcp-forward.ts";

/** Runs the extension with PI_WORKFLOW_MCP set to `raw` (unset when undefined); returns the registrations. */
function run(raw: string | undefined, fail: string[] = []): [string, unknown][] {
	const calls: [string, unknown][] = [];
	const pi = {
		registerMcpServer(name: string, config: unknown) {
			if (fail.includes(name)) throw new Error("boom");
			calls.push([name, config]);
		},
	};
	const saved = process.env[FORWARD_ENV];
	if (raw === undefined) delete process.env[FORWARD_ENV];
	else process.env[FORWARD_ENV] = raw;
	try {
		mcpForward(pi as never);
	} finally {
		if (saved === undefined) delete process.env[FORWARD_ENV];
		else process.env[FORWARD_ENV] = saved;
	}
	return calls;
}

test("registers each forwarded server", () => {
	assert.deepEqual(run('{"a":{"command":"x"},"b":{"url":"http://h"}}'), [
		["a", { command: "x" }],
		["b", { url: "http://h" }],
	]);
});

test("ignores invalid JSON", () => {
	assert.deepEqual(run("{"), []);
});

test("ignores non-object entries", () => {
	assert.deepEqual(run("[1]"), []);
	assert.deepEqual(run('{"a":1,"b":{"command":"x"}}'), [["b", { command: "x" }]]);
});

test("ignores an unset env", () => {
	assert.deepEqual(run(undefined), []);
});

test("one failing registration doesn't stop the rest", () => {
	assert.deepEqual(run('{"a":{"command":"x"},"b":{"command":"y"}}', ["a"]), [["b", { command: "y" }]]);
});
