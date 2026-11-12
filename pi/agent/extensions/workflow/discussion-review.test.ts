// node --experimental-strip-types --test discussion-review.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { discussionReviewPrompts, discussionVerdict, lastAgreedList } from "./discussion-review.ts";
import { JUDGE_DISCUSSION } from "./prompts.ts";

test("lastAgreedList: none", () => {
	assert.equal(lastAgreedList(["hello", "world"]), undefined);
});

test("lastAgreedList picks the newest list and starts at its line", () => {
	const r = lastAgreedList(["x\nAgreed so far:\n- old", "intro\nAgreed so far:\n- new\n"]);
	assert.equal(r, "Agreed so far:\n- new");
});

test("lastAgreedList matches bold", () => {
	assert.equal(lastAgreedList(["a\n**Agreed so far:**\n- k"]), "**Agreed so far:**\n- k");
});

test("discussionVerdict", () => {
	assert.equal(discussionVerdict("VERDICT: PASS"), "PASS");
	assert.equal(discussionVerdict("VERDICT: PASS or VERDICT: FAIL"), "FAIL");
	assert.equal(discussionVerdict("nothing"), "FAIL");
});

test("discussionReviewPrompts", () => {
	const a = discussionReviewPrompts(undefined, "T", []);
	assert.equal(a[0], JUDGE_DISCUSSION);
	assert.ok(a[1].includes("No `Agreed so far:` list yet"));
	assert.equal(a.length, 3);
	assert.ok(a[a.length - 1].startsWith("## Discussion transcript"));
	const b = discussionReviewPrompts("Agreed so far:\n- x", "T", ["D:/f"]);
	assert.equal(b.length, 4);
	assert.ok(b[2].includes("## Other folders of this session") && b[2].includes("D:/f"));
	assert.ok(b[3].endsWith("T"));
});
