// node --experimental-strip-types --test reviewer.test.ts
// The judge and critic processes' guard: only reading tools, plus the knowledge tools named in PI_AGENTS_REVIEW_ALLOW.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./test-hooks.ts";

const { default: reviewer, parseAllow, REVIEW_ALLOW_ENV, reviewerRefusal } = await import("./reviewer.ts");

test("reviewerRefusal: reading tools pass, prefixed ones too; writing and running tools are refused", () => {
	for (const t of ["read", "grep", "find", "ls", "x__read"]) assert.equal(reviewerRefusal(t), undefined, t);
	for (const t of ["bash", "edit", "write", "run_code", "x__bash"]) assert.match(reviewerRefusal(t) ?? "", /not available to a reviewer/, t);
});

test("reviewerRefusal: an allowed tool passes by its full name only", () => {
	const allow = ["mcp__knowledge__search"];
	assert.equal(reviewerRefusal("mcp__knowledge__search", allow), undefined);
	assert.match(reviewerRefusal("mcp__knowledge__propose_entry", allow) ?? "", /not available/);
	assert.match(reviewerRefusal("search", allow) ?? "", /not available/);
});

test("parseAllow: a comma list, blanks dropped; unset is empty", () => {
	assert.deepEqual(parseAllow(" a, b ,,c "), ["a", "b", "c"]);
	assert.deepEqual(parseAllow(undefined), []);
	assert.deepEqual(parseAllow(""), []);
});

test("the extension blocks refused tool calls with the reason and lets the env's allow list through", async () => {
	const before = process.env[REVIEW_ALLOW_ENV];
	process.env[REVIEW_ALLOW_ENV] = "mcp__knowledge__search";
	try {
		let handler: ((e: { toolName: string }) => Promise<unknown>) | undefined;
		reviewer({ on: (name: string, fn: typeof handler) => void (name === "tool_call" && (handler = fn)) } as never);
		assert.ok(handler);
		assert.deepEqual(await handler!({ toolName: "bash" }), { block: true, reason: reviewerRefusal("bash") });
		assert.equal(await handler!({ toolName: "read" }), undefined);
		assert.equal(await handler!({ toolName: "mcp__knowledge__search" }), undefined);
	} finally {
		if (before === undefined) delete process.env[REVIEW_ALLOW_ENV];
		else process.env[REVIEW_ALLOW_ENV] = before;
	}
});
