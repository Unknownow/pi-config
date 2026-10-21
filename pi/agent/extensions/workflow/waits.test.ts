// node --test waits.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWaitStep, pollDecision, resumePrefix, waitAmendment } from "./waits.ts";

const CHECK = "git ls-remote --exit-code --tags origin com.iecgames.core/v0.17.0";
const plan = `## 5. Steps\n\n**S6.** Edit the code\n**S7.** Wait: publish core 0.17.0 (check: ${CHECK})\n- **S8.** Wait: open the Editor\n**S9.** Do it and write a long line that is more than one hundred and twenty characters long so the checklist text would cut it short, see?\n`;

test("parseWaitStep reads the reason and the check", () => {
	assert.deepEqual(parseWaitStep(plan, "S7"), { reason: "publish core 0.17.0", check: CHECK });
	assert.deepEqual(parseWaitStep(plan, "S8"), { reason: "open the Editor" });
});

test("parseWaitStep is null for other steps and unknown IDs", () => {
	assert.equal(parseWaitStep(plan, "S6"), null);
	assert.equal(parseWaitStep(plan, "S99"), null);
});

test("parseWaitStep keeps a check beyond 120 characters", () => {
	const long = `x`.repeat(130);
	const p = `**S1.** Wait: something (check: git ls-remote --exit-code --tags origin ${long})`;
	assert.equal(parseWaitStep(p, "S1")?.check, `git ls-remote --exit-code --tags origin ${long}`);
});

test("waitAmendment text", () => {
	assert.equal(waitAmendment(3, { reason: "publish core", step: "S7", check: "git ls-remote x" }), "## Amendment 3 (executor: wait)\npublish core (step S7) (check: git ls-remote x)");
	assert.equal(waitAmendment(1, { reason: "open Editor" }), "## Amendment 1 (executor: wait)\nopen Editor");
});

test("resumePrefix", () => {
	assert.equal(resumePrefix("x", "passed"), 'The wait for "x" is over (check passed).');
	assert.equal(resumePrefix("x", "forced"), 'The wait for "x" is over (you continued without the check passing).');
	assert.equal(resumePrefix("x", "plain"), 'The wait for "x" is over.');
});

test("pollDecision", () => {
	const base = { waiting: true, hasCheck: true, idle: true, elapsedMs: 0, maxMs: 100 };
	assert.equal(pollDecision(base), "run");
	assert.equal(pollDecision({ ...base, idle: false }), "hold");
	assert.equal(pollDecision({ ...base, elapsedMs: 100 }), "stop");
	assert.equal(pollDecision({ ...base, elapsedMs: 100, idle: false }), "stop");
	assert.equal(pollDecision({ ...base, hasCheck: false }), "stop");
	assert.equal(pollDecision({ ...base, waiting: false }), "stop");
});
