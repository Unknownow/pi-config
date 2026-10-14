// node --test agent-end.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { afterPass, fixableFindings, hasPlanFlaw, isPlanReady, judgeCapReached, minorFixOpen, parseArbiter, shouldResume, skipJudge } from "./agent-end.ts";

const empty = { role: "assistant", content: [] };

test("resume only after an overflow retry with an empty reply, at most twice", () => {
	assert.equal(shouldResume(true, empty, 0), true);
	assert.equal(shouldResume(true, empty, 1), true);
	assert.equal(shouldResume(true, empty, 2), false);
	assert.equal(shouldResume(false, empty, 0), false);
	assert.equal(shouldResume(true, { role: "assistant", content: [{ type: "text" }] }, 0), false);
	assert.equal(shouldResume(true, undefined, 0), false);
});

test("plan is ready with a Plan heading and no trailing question", () => {
	assert.equal(isPlanReady("Plan:\n1. do it", true), true);
	assert.equal(isPlanReady("## Plan (revised)\n1. do it", true), true);
	assert.equal(isPlanReady("**Plan:** 1. do it", true), true);
	assert.equal(isPlanReady("Plan:\n1. do it\n\nOpen question: which db?", true), false);
	assert.equal(isPlanReady("Plan:\n1. x\n\n**Which db?**", true), false);
	assert.equal(isPlanReady("Here is an explanation of the planning", true), false);
	assert.equal(isPlanReady("Plan mode is on, so I can only read files.", true), false);
	assert.equal(isPlanReady("plan: none yet, reading X first.\n1. x", true), false);
	assert.equal(isPlanReady("PLAN: x\n1. x", true), true);
	assert.equal(isPlanReady("## plan\n1. x", true), true);
	assert.equal(isPlanReady("**plan**\n1. x", true), true);
	assert.equal(isPlanReady("## Plan\r\n1. x\r\n", true), true);
	assert.equal(isPlanReady("Intro\r\n**Plan:**\r\n1. x", true), true);
	assert.equal(isPlanReady("Plan:\r\n1. x\r\nWhich db?\r\n", true), false);
	assert.equal(isPlanReady("**Plan** mode is on, so I can only read files.", true), false);
	assert.equal(isPlanReady("## Plan mode\nreading first", true), false);
	assert.equal(isPlanReady("## Plan for the cache fix\n1. x", true), true);
	assert.equal(isPlanReady("## Plan \u2014 add retries\n1. x", true), true);
	assert.equal(isPlanReady("**Plan for X**\n1. x", true), true);
	assert.equal(isPlanReady("**Plan Mode** is active", true), false);
	assert.equal(isPlanReady("## PLAN MODE\nreading", true), false);
	assert.equal(isPlanReady("**Plan-mode** on", true), false);
	assert.equal(isPlanReady("## Plan\n- Mode toggle\n1. x", true), true);
	assert.equal(isPlanReady("**Plan**\n\nMode: strict", true), true);
	assert.equal(isPlanReady("**Plan** \u2014 mode is on", true), false);
	assert.equal(isPlanReady("**Plan**: mode is on", true), false);
	assert.equal(isPlanReady("## Planning notes\nreading first", true), false);
	assert.equal(isPlanReady("**Plan:** mode is on", true), false);
	assert.equal(isPlanReady("**Plan \u2014** mode", true), false);
	assert.equal(isPlanReady("Plan: mode is on, so I can only read files.", true), false);
	assert.equal(isPlanReady("**Plan** to read the config first", true), false);
	assert.equal(isPlanReady("_plan_ is to look at X first.", true), false);
	assert.equal(isPlanReady("## Plan not ready yet", true), false);
	assert.equal(isPlanReady("## Plan: mode switch redesign\n1. x", true), true);
	assert.equal(isPlanReady("## Plan \u2014 mode toggle cleanup\n1. x", true), true);
	assert.equal(isPlanReady("## Plan (not touching the API)\n1. x", true), true);
	assert.equal(isPlanReady("## Plan \u2014 not including tests\n1. x", true), true);
	assert.equal(isPlanReady("## Plan: pending\nreading", true), false);
	// Known trade-off: "Plan mode <word>" reads as a plan heading, only "Plan mode" alone or "Plan mode is on" is a notice.
	assert.equal(isPlanReady("## Plan mode restrictions\n1. x", true), true);
	assert.equal(isPlanReady("Plan:\n1. x", false), false);
});

test("judge is skipped only on an errored reply", () => {
	assert.equal(skipJudge({ role: "assistant", stopReason: "error" }), true);
	assert.equal(skipJudge({ role: "assistant", stopReason: "stop" }), false);
	assert.equal(skipJudge(undefined), false);
});

test("the judge cap: 0 means no limit", () => {
	assert.equal(judgeCapReached(5, 5), true);
	assert.equal(judgeCapReached(4, 5), false);
	assert.equal(judgeCapReached(99, 0), false);
});

test("hasPlanFlaw sees a tagged finding line only", () => {
	assert.equal(hasPlanFlaw("a.ts:3 - major - [plan-flaw] the plan loses data"), true);
	assert.equal(hasPlanFlaw("a.ts:3 - minor - [plan-flaw] x\nVERDICT: PASS"), true);
	assert.equal(hasPlanFlaw("a.ts:3 - major - [design] x"), false);
	assert.equal(hasPlanFlaw("Some prose that mentions [plan-flaw] in passing."), false);
});

test("parseArbiter reads the decision, the reason and the amendment", () => {
	const revise = parseArbiter("DECISION: REVISE\nReason: the lock is taken twice (a.ts:9).\n## Plan amendment\n1. Take the lock once in b.ts.\n2. Add a test.");
	assert.equal(revise?.decision, "REVISE");
	assert.match(revise?.reason ?? "", /lock is taken twice/);
	assert.match(revise?.amendment ?? "", /^1\. Take the lock once/);
	assert.equal(parseArbiter("DECISION: REVISE\nReason: x")?.decision, "ASK_USER");
	assert.equal(parseArbiter("decision: keep\nReason: the judge's scenario cannot happen (c.ts:2).")?.decision, "KEEP");
	assert.equal(parseArbiter("DECISION: ASK_USER\nReason: touches D2")?.decision, "ASK_USER");
	assert.equal(parseArbiter("I think the plan is fine."), null);
});

test("fixableFindings skips knowledge deviations, plan flaws and indented lines", () => {
	assert.equal(fixableFindings("a.ts:3 - minor - [bug] x\n  Why: y\n  Fix: z\nVERDICT: PASS"), 1);
	assert.equal(fixableFindings("a.ts:3 - minor - [knowledge r1] deviation from a recommended rule\nVERDICT: PASS"), 0);
	assert.equal(fixableFindings("a.ts:3 - minor - [knowledge r1] the required rule about locks is broken\nVERDICT: PASS"), 1);
	assert.equal(fixableFindings("a.ts:3 - minor - [plan-flaw] x\nVERDICT: PASS"), 0);
	assert.equal(fixableFindings("  Fix: split the file - minor - and retest\nVERDICT: PASS"), 0);
	assert.equal(fixableFindings("a.ts:1 - minor - [design] a\r\nb.ts:2 - minor - [test] b\r\nVERDICT: PASS"), 2);
	assert.equal(fixableFindings("VERDICT: PASS"), 0);
});

test("a passed diff gets one minor-fix round, not after commit, flow end or an earlier message", () => {
	const open = { committed: false, commitPending: false, summarized: false, hash: "h" };
	assert.equal(minorFixOpen(open), true);
	assert.equal(minorFixOpen({ ...open, committed: true }), false);
	assert.equal(minorFixOpen({ ...open, commitPending: true }), false);
	// autoCommit off: the flow ended on this diff, so a later agent_end must not ask again
	assert.equal(minorFixOpen({ ...open, summarized: true }), false);
	assert.equal(minorFixOpen({ ...open, sentFor: "h" }), false);
	assert.equal(minorFixOpen({ ...open, sentFor: "other" }), true);
});

test("a pass with findings is fixed while rounds are left, then committed", () => {
	assert.equal(afterPass(0, 0, 2), "commit");
	assert.equal(afterPass(2, 0, 2), "fix");
	assert.equal(afterPass(1, 1, 2), "fix");
	assert.equal(afterPass(1, 2, 2), "commit");
	assert.equal(afterPass(3, 0, 0), "commit");
});
