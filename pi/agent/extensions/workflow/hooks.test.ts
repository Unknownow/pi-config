import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStartPlan, planReviewAction, acceptanceRefusal, ACCEPTANCE_NO_ANSWER, exactToolRegexes } from "./hooks.ts";

test("parseStartPlan accepts a good payload", () => {
	assert.deepEqual(parseStartPlan({ v: 1, title: "t", brief: "b", allowTools: ["x"] }), { title: "t", brief: "b", allowTools: ["x"] });
	assert.deepEqual(parseStartPlan({ v: 1, title: "t", brief: "b" }), { title: "t", brief: "b", allowTools: [] });
});

test("parseStartPlan rejects a wrong v, a missing brief, a bad allowTools", () => {
	for (const bad of [{ v: 2, title: "t", brief: "b" }, { v: 1, title: "t" }, { v: 1, title: "t", brief: "b", allowTools: "x" }, { v: 1, title: "t", brief: "b", allowTools: [1] }, null]) {
		assert.ok("error" in parseStartPlan(bad));
	}
});

test("planReviewAction", () => {
	assert.equal(planReviewAction({ approve: true }, true), "approve");
	assert.equal(planReviewAction({ approve: true }, false), "ignore");
	assert.equal(planReviewAction({ reject: "no" }, true), "reject");
	assert.equal(planReviewAction(null, true), "ignore");
	assert.equal(planReviewAction({ error: "x" }, true), "ignore");
});

test("acceptanceRefusal", () => {
	assert.equal(acceptanceRefusal({ problem: "wait" }), "wait");
	assert.equal(acceptanceRefusal({ error: "boom" }), ACCEPTANCE_NO_ANSWER);
	assert.equal(acceptanceRefusal(null), null);
});

test("exactToolRegexes matches only the exact name", () => {
	const [re] = exactToolRegexes(["ask_orchestrator"]);
	assert.ok(re.test("ask_orchestrator"));
	assert.ok(!re.test("xask_orchestrator"));
	assert.ok(!re.test("ask_orchestrator2"));
});
