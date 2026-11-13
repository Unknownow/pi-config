// node --experimental-strip-types --test plan-judge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmPlanTitle, judgeSection, parsePlanJudge, phaseLabel, planReviewJudgeLine } from "./plan-judge.ts";

const ok = { ran: true, verdict: "PASS", rounds: 2, spec: "agreed", findings: [], userFindings: [] };

test("parsePlanJudge", () => {
	assert.deepEqual(parsePlanJudge(ok)?.rounds, 2);
	assert.equal(parsePlanJudge(undefined), undefined);
	assert.equal(parsePlanJudge({ ...ok, verdict: "x" }), undefined);
	assert.equal(parsePlanJudge({ ...ok, findings: [1] }), undefined);
	assert.equal(parsePlanJudge({ ...ok, ran: "yes" }), undefined);
});

test("planReviewJudgeLine", () => {
	assert.equal(planReviewJudgeLine(undefined), "");
	assert.equal(planReviewJudgeLine(parsePlanJudge(ok)), "judge: PASS (2 runs)");
	assert.equal(planReviewJudgeLine(parsePlanJudge({ ...ok, ran: false, verdict: "cancelled" })), "judge: did not run (cancelled)");
	assert.equal(planReviewJudgeLine(parsePlanJudge({ ...ok, ran: false, verdict: "error" })), "judge: did not run (error)");
	assert.equal(planReviewJudgeLine(parsePlanJudge({ ...ok, verdict: "FAIL", findings: ["a"], userFindings: ["b"] })), "judge: 2 open findings (1 need a decision) after 2 runs, see the plan file");
});

test("judgeSection", () => {
	assert.equal(judgeSection(undefined), "");
	assert.equal(judgeSection(parsePlanJudge(ok)), "");
	const s = judgeSection(parsePlanJudge({ ...ok, verdict: "FAIL", findings: ["open one"], userFindings: ["decide this"] }));
	assert.ok(s.includes("## Open judge findings") && s.includes("Needs a decision:\n- decide this") && s.includes("Open after the cap:\n- open one"));
	assert.ok(judgeSection(parsePlanJudge({ ...ok, ran: false, verdict: "cancelled" })).includes("did not run (cancelled)"));
});

test("phaseLabel", () => {
	assert.equal(phaseLabel("plan", "plan"), "plan (judging plan)");
	assert.equal(phaseLabel("discuss", "discussion"), "discuss (judging discussion)");
	assert.equal(phaseLabel("plan"), "plan");
	assert.equal(phaseLabel("plan", "x"), "plan");
});

test("judgeSection: a run that did not run lists no stale findings", () => {
	const s = judgeSection(parsePlanJudge({ ...ok, ran: false, verdict: "cancelled", findings: ["old"] }));
	assert.ok(s.includes("did not run (cancelled)") && !s.includes("old") && !s.includes("Open after the cap"));
});

test("confirmPlanTitle: the judge line is added only when there is one", () => {
	assert.equal(confirmPlanTitle("a", "S"), "Approve plan of a? S");
	assert.equal(confirmPlanTitle("a", "S", ""), "Approve plan of a? S");
	assert.equal(confirmPlanTitle("a", "S", "judge: PASS (1 runs)"), "Approve plan of a? S\njudge: PASS (1 runs)");
});
