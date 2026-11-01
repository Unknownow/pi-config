// node --test agent-end.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { preFlowModelAction, gitTaskAllowed, migrateSavedState, handoverAction, approvalBlock, handoverKind, addPlanReply, composePlan, afterPass, noChangeStage, arbiterFirst, fixableFindings, hasPlanFlaw, planFlawLines, planFlawOnPass, canApprove, hasPlanLine, isPlanReady, judgeCapReached, minorFixOpen, passPending, stageEndAction, parseArbiter, phaseAfterFlow, shouldResume, skipJudge, judgeAddenda, profileRole, nextProfile } from "./agent-end.ts";
import { JUDGE_MAJOR_ONLY, JUDGE_QUICK } from "./prompts.ts";
import { planWaitProblems } from "./stages.ts";

const empty = { role: "assistant", content: [] };

test("the pre-flow model is saved when a flow starts and restored when it ends", () => {
	assert.equal(preFlowModelAction("off", "discuss"), "save");
	assert.equal(preFlowModelAction("discuss", "off"), "restore");
	assert.equal(preFlowModelAction("execute", "off"), "restore");
	assert.equal(preFlowModelAction("off", "off"), "keep");
	assert.equal(preFlowModelAction("discuss", "plan"), "keep");
});

test("git_task runs in normal mode (no gate) and in execute with a plan; discuss and plan refuse it", () => {
	assert.deepEqual(gitTaskAllowed("off", false), { ok: true, ungated: true });
	assert.deepEqual(gitTaskAllowed("execute", true), { ok: true, ungated: false });
	assert.equal(gitTaskAllowed("execute", false).ok, false);
	assert.equal(gitTaskAllowed("discuss", false).ok, false);
	assert.equal(gitTaskAllowed("plan", true).ok, false);
});

test("a saved state from the removed test phase loads as off; its test tokens are dropped", () => {
	const moved = migrateSavedState({ phase: "test", folders: ["D:/x"], tokens: { test: 1 }, testFlow: {} } as { phase: string; tokens?: unknown }) as Record<string, unknown>;
	assert.equal(moved.phase, "off");
	assert.deepEqual(moved.folders, ["D:/x"]);
	assert.deepEqual(moved.tokens, {});
	assert.equal(moved.testFlow, undefined);
	const kept = migrateSavedState({ phase: "execute", tokens: { test: 1, plan: 2 } }) as { tokens: Record<string, number> };
	assert.deepEqual(kept.tokens, { plan: 2 });
	const same = { phase: "plan" };
	assert.equal(migrateSavedState(same), same);
});

test("resume only after an overflow retry with an empty reply, at most twice", () => {
	assert.equal(shouldResume(true, empty, 0), true);
	assert.equal(shouldResume(true, empty, 1), true);
	assert.equal(shouldResume(true, empty, 2), false);
	assert.equal(shouldResume(false, empty, 0), false);
	assert.equal(shouldResume(true, { role: "assistant", content: [{ type: "text" }] }, 0), false);
	assert.equal(shouldResume(true, undefined, 0), false);
});

test("a plan is the last full reply plus the change sections after it", () => {
	let d = { full: "", changes: [] as string[] };
	d = addPlanReply(d, "Let me think.\n\n## Plan changes\n- S2 now x");
	assert.equal(composePlan(d), "");
	d = addPlanReply(d, "Intro\n## Plan: A\n1. s1");
	d = addPlanReply(d, "ok\n## Plan changes\n- S1 changed");
	d = addPlanReply(d, "## Plan changes\n- S3 new");
	d = addPlanReply(d, "just talk");
	assert.equal(composePlan(d), "## Plan: A\n1. s1\n\n## Plan changes\n- S1 changed\n\n## Plan changes\n- S3 new");
	d = addPlanReply(d, "## Plan: B\n1. t");
	assert.equal(composePlan(d), "## Plan: B\n1. t");
});

test("canApprove after a proposed plan", () => {
	assert.equal(canApprove("Sounds good, step 2 uses the cache.", true, true), true);
	assert.equal(canApprove("Sounds good, step 2 uses the cache.", true, false), false);
	assert.equal(canApprove("## Plan: x\n1. y", true, false), false);
	assert.equal(canApprove("Which db do you want?", true, true), false);
	assert.equal(canApprove("Fine.", false, true), false);
	assert.equal(hasPlanLine("## Plan: x\n1. y"), true);
	assert.equal(hasPlanLine("Plan mode is on."), false);
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

test("arbiterFirst: this flow's choice, else the config", () => {
	assert.equal(arbiterFirst("auto", "ask"), true);
	assert.equal(arbiterFirst(undefined, "ask"), false);
	assert.equal(arbiterFirst(undefined, "auto"), true);
	assert.equal(arbiterFirst("auto", "auto"), true);
});

test("planFlawOnPass routes plan flaws on a pass", () => {
	assert.equal(planFlawOnPass("a.ts:3 - minor - [plan-flaw] x\nVERDICT: PASS", "PASS"), "note");
	assert.equal(planFlawOnPass("a.ts:3 - major - [plan-flaw] x", "PASS"), "arbiter");
	assert.equal(planFlawOnPass("a.ts:3 - major - [plan-flaw] x\nb.ts:1 - minor - [plan-flaw] y", "PASS"), "arbiter");
	assert.equal(planFlawOnPass("a.ts:3 - blocker - [plan-flaw] x", "PASS"), "stop");
	assert.equal(planFlawOnPass("a.ts:3 - minor - [plan-flaw] x", "FAIL"), "stop");
	assert.equal(planFlawOnPass("a.ts:3 - Major - [plan-flaw] x", "PASS"), "arbiter");
	assert.equal(planFlawOnPass("a.ts:3 - blocker - [bug] y\na.ts:4 - minor - [plan-flaw] x", "PASS"), "note");
});

test("planFlawLines keeps plan-flaw finding lines only", () => {
	assert.deepEqual(planFlawLines("a.ts:3 - major - [plan-flaw] x\n  Why: [plan-flaw] mention\nb.ts:1 - minor - [bug] y"), ["a.ts:3 - major - [plan-flaw] x"]);
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

test("a passed diff gets one minor-fix round, not after flow end or an earlier message", () => {
	const open = { summarized: false, hash: "h" };
	assert.equal(minorFixOpen(open), true);
	assert.equal(minorFixOpen({ ...open, summarized: true }), false);
	assert.equal(minorFixOpen({ ...open, sentFor: "h" }), false);
	assert.equal(minorFixOpen({ ...open, sentFor: "other" }), true);
});

test("a pass is pending until its stage or flow was ended", () => {
	const judged = { hash: "h", verdict: "PASS" as const };
	assert.equal(passPending({ passedDiff: "h", judged }), true);
	assert.equal(passPending({ passedDiff: "h", judged, summarized: ["x"] }), true);
	assert.equal(passPending({ passedDiff: "h", judged, summarized: ["h"] }), false);
	assert.equal(passPending({ judged }), false);
	assert.equal(passPending({ passedDiff: "h", judged: { hash: "other", verdict: "PASS" } }), false);
	assert.equal(passPending({ passedDiff: "h", judged: { hash: "h", verdict: "FAIL" } }), false);
	assert.equal(passPending({ passedDiff: "h" }), false);
});

test("a stage with open steps is reminded once per pass", () => {
	assert.equal(stageEndAction({ openSteps: 2, hash: "h" }), "nudge");
	assert.equal(stageEndAction({ openSteps: 2, nudgedFor: "other", hash: "h" }), "nudge");
	assert.equal(stageEndAction({ openSteps: 2, nudgedFor: "h", hash: "h" }), "done");
	assert.equal(stageEndAction({ openSteps: 0, hash: "h" }), "done");
	// an unmerged pull request counts as one open step
	assert.equal(stageEndAction({ openSteps: 1, hash: "h" }), "nudge");
});

test("a pass with findings is fixed while rounds are left, then the stage is done", () => {
	assert.equal(afterPass(0, 0, 2), "done");
	assert.equal(afterPass(2, 0, 2), "fix");
	assert.equal(afterPass(1, 1, 2), "fix");
	assert.equal(afterPass(1, 2, 2), "done");
	assert.equal(afterPass(3, 0, 0), "done");
});

test("a finished flow returns to plan only from execute, when enabled", () => {
	assert.equal(phaseAfterFlow("discuss", "execute"), "discuss");
	assert.equal(phaseAfterFlow("plan", "execute"), "plan");
	assert.equal(phaseAfterFlow("off", "execute"), undefined);
	assert.equal(phaseAfterFlow("discuss", "plan"), undefined);
	assert.equal(phaseAfterFlow("discuss", "discuss"), undefined);
});

test("noChangeStage advances in auto mode", () => {
	assert.equal(noChangeStage(false, true, true), "advance");
	assert.equal(noChangeStage(false, false, true), "advance");
	assert.equal(noChangeStage(false, true, false), "ask");
	assert.equal(noChangeStage(false, false), "wait");
});

test("a no-change stage advances only when judged", () => {
	assert.equal(noChangeStage(true, false), "advance");
	assert.equal(noChangeStage(true, true), "advance");
	assert.equal(noChangeStage(false, true), "ask");
	assert.equal(noChangeStage(false, false), "wait");
});

test("handoverAction compacts at a start handover only an idle, unaborted run over the threshold with a plan", () => {
	const ok = { aborted: false, kind: "start" as const, idle: true, compacting: false, hasPlan: true, tokens: 50_000, threshold: 30_000 };
	assert.equal(handoverAction(ok), "compact");
	for (const o of [{ idle: false }, { compacting: true }, { hasPlan: false }, { tokens: null }, { tokens: 30_000 }, { threshold: 0 }]) {
		assert.equal(handoverAction({ ...ok, ...o }), "send");
	}
	assert.equal(handoverAction({ ...ok, kind: "continue" }), "send");
	assert.equal(handoverKind("workflow-execute"), "start");
	assert.equal(handoverKind("workflow-stage"), "start");
	assert.equal(handoverKind("workflow-open-steps"), "continue");
	assert.equal(handoverKind("workflow-test-fix"), "continue");
	assert.equal(handoverAction({ ...ok, aborted: true }), "hold");
	assert.equal(handoverAction({ ...ok, aborted: true, tokens: 1000 }), "hold");
	assert.equal(handoverAction({ ...ok, aborted: true, hasPlan: false }), "hold");
});

test("noChangeStage keeps a stage with open steps", () => {
	assert.equal(noChangeStage(false, true, true, 2), "ask");
	assert.equal(noChangeStage(false, false, true, 2), "wait");
	assert.equal(noChangeStage(true, true, true, 2), "advance");
	assert.equal(noChangeStage(false, true, true, 0), "advance");
});

test("approvalBlock refuses an empty draft and wait problems", () => {
	assert.ok(approvalBlock({ full: "", changes: [] }, []));
	assert.ok(approvalBlock({ full: "## Plan: x", changes: [] }, ["S2 check"])?.includes("S2 check"));
	assert.equal(approvalBlock({ full: "## Plan: x", changes: [] }, []), undefined);
});

test("a wait check broken in the full plan stays broken in a change section; a new full plan clears it", () => {
	const bad = "## Plan: x\n**S2.** Wait: act (check: echo `date`)";
	const fix = "## Plan changes\n**S2.** Wait: act (check: test -f a)";
	const problems = (d: { full: string; changes: string[] }) => planWaitProblems(composePlan(d), () => null);
	let d = addPlanReply({ full: "", changes: [] }, bad);
	assert.ok(problems(d).length > 0);
	d = addPlanReply(d, fix);
	assert.ok(problems(d).length > 0);
	d = addPlanReply(d, "## Plan: x\n**S2.** Wait: act (check: test -f a)");
	assert.equal(problems(d).length, 0);
});

test("judge addenda after a minor round", async () => {
	const { judgeAddenda } = await import("./agent-end.ts");
	assert.equal(judgeAddenda(0), "");
	assert.ok(judgeAddenda(1).includes("only blocker and major"));
});

test("a quick flow plans on the quick role and reviews on quick-judge; other roles and full flows keep theirs", () => {
	assert.equal(profileRole("quick", "plan"), "quick");
	assert.equal(profileRole("quick", "judge"), "quick-judge");
	assert.equal(profileRole("quick", "execute"), "execute");
	assert.equal(profileRole("quick", "arbiter"), "arbiter");
	assert.equal(profileRole(undefined, "plan"), "plan");
	assert.equal(profileRole(undefined, "judge"), "judge");
});

test("a quick flow's judge reports only blockers and majors from the first round", () => {
	assert.equal(judgeAddenda(0), "");
	assert.equal(judgeAddenda(1), "\n" + JUDGE_MAJOR_ONLY);
	assert.equal(judgeAddenda(0, true), "\n" + JUDGE_QUICK);
	assert.equal(judgeAddenda(2, true), "\n" + JUDGE_QUICK);
});

test("only the approval carries a quick profile into execute; every other switch clears it", () => {
	assert.equal(nextProfile("off", "plan", "quick", undefined), "quick");
	assert.equal(nextProfile("plan", "plan", undefined, "quick"), undefined, "/flow plan from a scope card is a full flow");
	assert.equal(nextProfile("plan", "execute", undefined, "quick"), "quick", "approval");
	assert.equal(nextProfile("execute", "execute", undefined, "quick"), "quick", "a repeated switch keeps it");
	assert.equal(nextProfile("off", "execute", undefined, "quick"), undefined);
	assert.equal(nextProfile("discuss", "execute", undefined, "quick"), undefined, "/flow resume from elsewhere is a full flow");
	assert.equal(nextProfile("execute", "off", undefined, "quick"), undefined);
	assert.equal(nextProfile("execute", "discuss", undefined, "quick"), undefined);
	assert.equal(nextProfile("off", "plan", undefined, undefined), undefined);
});
