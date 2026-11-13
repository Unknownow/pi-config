// node --experimental-strip-types --test findings.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isClean, judgeVerdict, lastAgreedList, parseFindings, textHash } from "./findings.ts";

const REPLY = `Intro.
- major - [gap] fix: auto - step 3 misses the caller
  Why: w
  Fix: f
- minor - [risk] fix: user - which name?
Why: needs a decision
VERDICT: FAIL`;

test("parseFindings: severity, route, body", () => {
	const fs = parseFindings(REPLY);
	assert.equal(fs.length, 2);
	assert.equal(fs[0].severity, "major");
	assert.equal(fs[0].route, "auto");
	assert.equal(fs[0].category, "gap");
	assert.ok(fs[0].body.includes("Why: w") && fs[0].body.includes("Fix: f"));
	assert.equal(fs[1].route, "user");
	assert.ok(fs[1].body.includes("needs a decision"));
});

test("isClean", () => {
	assert.equal(isClean("PASS", []), true);
	assert.equal(isClean("PASS", parseFindings(REPLY)), false);
	assert.equal(isClean("FAIL", []), false);
});

test("textHash ignores CRLF and outer whitespace", () => {
	assert.equal(textHash("a\r\nb"), textHash("  a\nb\n"));
	assert.notEqual(textHash("a"), textHash("b"));
});

test("lastAgreedList returns the newest list", () => {
	assert.equal(lastAgreedList(["Agreed so far:\n- old", "chat", "Intro\nAgreed so far:\n- new"]), "Agreed so far:\n- new");
	assert.equal(lastAgreedList(["nothing"]), undefined);
});

test("judgeVerdict", () => {
	assert.equal(judgeVerdict("All good.\nVERDICT: PASS"), "PASS");
	assert.equal(judgeVerdict(REPLY), "FAIL");
	assert.equal(judgeVerdict("no verdict"), "FAIL");
});
