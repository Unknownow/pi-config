// node --test tokens.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { countTokens, type TokenWeights } from "./tokens.ts";

const WEIGHTS: TokenWeights = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

test("raw counts every kind in full; cost weights cache reads down", () => {
	const usage = { input: 100, output: 50, cacheRead: 10_000, cacheWrite: 200 };
	assert.deepEqual(countTokens(usage, WEIGHTS), { raw: 10_350, cost: 100 + 250 + 1000 + 250 });
});

test("with all weights 1 the two figures are equal", () => {
	const one = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
	assert.deepEqual(countTokens({ input: 3, output: 4, cacheRead: 5, cacheWrite: 6 }, one), { raw: 18, cost: 18 });
});

test("missing usage counts as nothing", () => {
	assert.deepEqual(countTokens(undefined, WEIGHTS), { raw: 0, cost: 0 });
	assert.deepEqual(countTokens({}, WEIGHTS), { raw: 0, cost: 0 });
});
