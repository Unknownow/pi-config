// node --experimental-strip-types --test runs.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, endRun, newRun, shortModel } from "./runs.ts";
import { DEFAULT_TOKEN_WEIGHTS } from "./tokens.ts";

const w = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };

test("a run counts tools, streams usage and returns what each finished message spent", () => {
	const run = newRun(1, "explore", "where is x?", "claude-bridge/claude-haiku-5-5");
	assert.equal(run.model, "haiku-5-5");
	assert.equal(applyEvent(run, { type: "tool", name: "grep", args: { pattern: "x", path: "/w/src" } }, "/w", w), undefined);
	assert.equal(run.tools, 1);
	assert.equal(run.activity, "grep /x/ in src");
	assert.equal(applyEvent(run, { type: "usage", usage: { input: 10, output: 2 }, done: false }, "/w", w), undefined);
	assert.deepEqual(run.liveTokens, { raw: 12, cost: 12 });
	// A failed stream can end with empty usage: the streamed tokens still count.
	const spent = applyEvent(run, { type: "usage", usage: {}, done: true }, "/w", w);
	assert.deepEqual(spent?.tokens, { raw: 12, cost: 12 });
	assert.deepEqual(run.tokens, { raw: 12, cost: 12 });
	assert.deepEqual(run.liveTokens, { raw: 0, cost: 0 });
	// explore rows keep their last tool as the activity; other roles show what they write.
	applyEvent(run, { type: "text", text: "found it" }, "/w", w);
	assert.equal(run.activity, "grep /x/ in src");
});

test("endRun settles a message cut off mid-stream and records the outcome", () => {
	const run = newRun(2, "advisor", "help", "a/b");
	applyEvent(run, { type: "text", text: "thinking about it\nstep two" }, "/w", w);
	assert.equal(run.activity, "writing: step two");
	applyEvent(run, { type: "usage", usage: { output: 5 }, done: false }, "/w", DEFAULT_TOKEN_WEIGHTS);
	const spent = endRun(run, false, "timed out");
	assert.deepEqual(spent.tokens, { raw: 5, cost: 25 });
	assert.equal(spent.counts.output, 5);
	assert.equal(run.status, "fail");
	assert.equal(run.activity, "timed out");
	assert.deepEqual(run.tokens, { raw: 5, cost: 25 });
	assert.ok(run.ended);
	assert.equal(shortModel("p/claude-opus-5-5"), "opus-5-5");
});
