// node --test agent-end.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

// agent-end.ts reads findings through agents/api.ts, which loads the pi packages: stub them first.
await import("./test-hooks.ts");
const { preFlowModelAction, gitTaskAllowed, migrateSavedState, handoverAction, approvalBlock, handoverKind, addPlanReply, composePlan, afterPass, noChangeStage, arbiterFirst, codeVerdict, fixableFindings, lateFindingLines, planFlaws, planFlawOnPass, canApprove, hasPlanLine, isPlanReady, judgeCapReached, minorFixOpen, passPending, stageEndAction, parseArbiter, parseMergeArbiter, phaseAfterFlow, shouldResume, skipJudge, judgeAddenda } = await import("./agent-end.ts");
const { JUDGE_MAJOR_ONLY } = await import("./prompts.ts");
const { planWaitProblems } = await import("./stages.ts");
const { parseFindings } = await import("../agents/api.ts");

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

test("a saved quick flow resumes as a normal flow: profile and the quick keys are dropped, the rest stays", () => {
	const saved = { phase: "execute", profile: "quick", [`quick${"From"}`]: "discuss", approvedPlan: "## Plan: x", judgeRounds: 1 };
	const out = migrateSavedState(saved) as Record<string, unknown>;
	assert.equal("profile" in out, false);
	assert.equal(Object.keys(out).some((k) => k.startsWith("quick")), false);
	assert.deepEqual(out, { phase: "execute", approvedPlan: "## Plan: x", judgeRounds: 1 });
	assert.equal(migrateSavedState({ phase: "plan", profile: "quick" } as { phase: string }).phase, "plan");
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

/** A judge reply in agents' findings format, parsed. */
const f = (text: string) => parseFindings(text);

test("planFlawOnPass routes [plan] findings on a pass", () => {
	assert.equal(planFlawOnPass(f("- minor - [plan] `plan S3` - x fix: user\nVERDICT: PASS"), "PASS"), "note");
	assert.equal(planFlawOnPass(f("- major - [plan] `plan S3` - x"), "PASS"), "arbiter");
	assert.equal(planFlawOnPass(f("- major - [plan] `plan S3` - x\n- minor - [plan] `plan S4` - y"), "PASS"), "arbiter");
	assert.equal(planFlawOnPass(f("- blocker - [plan] `plan S3` - x"), "PASS"), "stop");
	assert.equal(planFlawOnPass(f("- minor - [plan] `plan S3` - x"), "FAIL"), "stop");
	assert.equal(planFlawOnPass(f("- Major - [plan] `plan S3` - x"), "PASS"), "arbiter");
	assert.equal(planFlawOnPass(f("- blocker - [bug] `a.ts:3` - y\n- minor - [plan] `plan S3` - x"), "PASS"), "note");
});

test("planFlaws keeps the [plan] findings only; a mention in a Why line or prose is not one", () => {
	const found = planFlaws(f("- major - [plan] `plan S3` - x fix: user\n  Why: [plan] mention\n- minor - [bug] `b.ts:1` - y\nSome prose that mentions [plan] in passing."));
	assert.deepEqual(found.map((x) => x.head), ["major - [plan] `plan S3` - x fix: user"]);
	assert.deepEqual(planFlaws(f("- major - [design] `a.ts:3` - x")), []);
});

test("old-format judge text (saved in state by older versions) has no findings", () => {
	const old = "a.ts:3 - major - [plan-flaw] x\n  Why: y\nb.ts:1 - blocker - [bug] z\nVERDICT: PASS";
	assert.deepEqual(f(old), []);
	assert.equal(planFlawOnPass(f(old), "PASS"), "note");
	assert.equal(fixableFindings(f(old)), 0);
});

test("codeVerdict: a stated PASS with no blocker or non-late major, leaving out [plan] findings", () => {
	const v = (t: string) => codeVerdict(t, f(t));
	assert.equal(v("VERDICT: PASS"), "PASS");
	assert.equal(v("VERDICT: FAIL"), "FAIL");
	assert.equal(v("- major - [bug] `a.ts:1` - x\nVERDICT: PASS"), "FAIL");
	assert.equal(v("- blocker - [bug][late] `a.ts:1` - x\nVERDICT: PASS"), "FAIL");
	assert.equal(v("- major - [bug][late] `a.ts:1` - x\n- minor - [test] `a.test.ts:2` - y\nVERDICT: PASS"), "PASS");
	assert.equal(v("- major - [plan] `plan S2` - x\nVERDICT: PASS"), "PASS");
	assert.equal(v("- blocker - [plan] `plan S2` - x\nVERDICT: PASS"), "PASS");
	assert.equal(v("- minor - [bug] `a.ts:1` - x\nVERDICT: FAIL"), "FAIL");
});

test("lateFindingLines lists the late findings that are not blockers", () => {
	assert.deepEqual(lateFindingLines(f("- major - [bug][late] `a.ts:1` - x\n- blocker - [bug][late] `b.ts:1` - y\n- minor - [bug] `c.ts:1` - z")), ["major - [bug][late] `a.ts:1` - x"]);
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

test("fixableFindings skips knowledge deviations, [plan] findings, late non-blockers and indented lines", () => {
	assert.equal(fixableFindings(f("- minor - [bug] `a.ts:3` - x fix: auto\n  Why: y\n  Fix: z\nVERDICT: PASS")), 1);
	assert.equal(fixableFindings(f("- minor - [knowledge r1] `a.ts:3` - deviation from a recommended rule fix: user\n  Rule: r\nVERDICT: PASS")), 0);
	assert.equal(fixableFindings(f("- minor - [knowledge r1] `a.ts:3` - the required rule about locks is broken\nVERDICT: PASS")), 1);
	assert.equal(fixableFindings(f("- minor - [plan] `plan S3` - x\nVERDICT: PASS")), 0);
	assert.equal(fixableFindings(f("- minor - [bug][late] `a.ts:3` - x\n- blocker - [bug][late] `a.ts:4` - y")), 1);
	assert.equal(fixableFindings(f("  Fix: split the file - minor - and retest\nVERDICT: PASS")), 0);
	assert.equal(fixableFindings(f("- minor - [design] `a.ts:1` - a\r\n- minor - [test] `b.ts:2` - b\r\nVERDICT: PASS")), 2);
	assert.equal(fixableFindings(f("VERDICT: PASS")), 0);
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

test("after a minor-fix round the judge criteria ask for blockers and majors only", () => {
	assert.equal(judgeAddenda(0), "");
	assert.equal(judgeAddenda(1), JUDGE_MAJOR_ONLY);
});

test("parseMergeArbiter: MERGE, NO_MERGE, ASK_USER and no decision", () => {
	assert.deepEqual(parseMergeArbiter("DECISION: MERGE\nReason: S5 needs it on main."), { decision: "MERGE", reason: "S5 needs it on main." });
	assert.equal(parseMergeArbiter("DECISION: NO_MERGE\nReason: a push is enough.\nmore")?.decision, "NO_MERGE");
	assert.equal(parseMergeArbiter("DECISION: NO_MERGE\nReason: a push is enough.\nmore")?.reason, "a push is enough.\nmore");
	assert.equal(parseMergeArbiter("decision: ask_user\nReason: unknown")?.decision, "ASK_USER");
	assert.equal(parseMergeArbiter("I think we should merge"), null);
});

test("migrateSavedState: an open discussion fix round does not survive a restart", () => {
	const out = migrateSavedState({ phase: "discuss", discussionReview: { status: "awaiting-fix", listHash: "x" } } as { phase: string }) as { discussionReview: { status: string; listHash: string } };
	assert.deepEqual(out.discussionReview, { status: "idle", listHash: "x" });
	const paused = migrateSavedState({ phase: "discuss", discussionReview: { status: "paused" } } as { phase: string }) as { discussionReview: { status: string } };
	assert.equal(paused.discussionReview.status, "paused");
});

test("migrateSavedState: fields of the removed external-controller contracts are dropped and an acceptance wait is cleared", () => {
	const saved = { phase: "execute", approvedPlan: "p", openAsk: { id: "f:1" }, askSeq: 3, extraPlanTools: ["x"], planSpec: { kind: "brief", text: "b" }, waiting: { reason: "r", since: "s", planned: false, askId: "f:2", manual: true, waitKind: "external", check: "c" } };
	const out = migrateSavedState(saved as { phase: string }) as Record<string, any>;
	for (const k of ["openAsk", "askSeq", "extraPlanTools", "planSpec"]) assert.ok(!(k in out), k);
	assert.deepEqual(out.waiting, { reason: "r", since: "s", planned: false, waitKind: "external", check: "c" });
	assert.equal(out.approvedPlan, "p");
	const acc = migrateSavedState({ phase: "execute", waiting: { reason: "acceptance", since: "s", planned: false, waitKind: "acceptance", accept: { tree: "t", root: "r", kind: "merge" } } } as { phase: string }) as Record<string, any>;
	assert.equal(acc.waiting, undefined);
	const plain = { phase: "execute", waiting: { reason: "r", since: "s", planned: true } };
	assert.equal(migrateSavedState(plain), plain);
});
