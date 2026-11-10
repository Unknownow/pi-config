// node --experimental-strip-types --test inbox.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { verdictMatches } from "./inbox.ts";

test("a verdict resolves only the plan it names", () => {
	assert.equal(verdictMatches(2, { data: { approve: true, n: 2 } }), true);
	assert.equal(verdictMatches(2, { data: { approve: true, n: 1 } }), false);
	assert.equal(verdictMatches(2, { data: { approve: true } }), false);
	assert.equal(verdictMatches(2, {}), false);
	assert.equal(verdictMatches(undefined, { data: { n: 1 } }), false);
});
