// node --test delivery.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName, planTitle } from "./delivery.ts";
import { finalize, planPhase, SHOW_PLAN } from "./prompts.ts";

const d = new Date(2026, 9, 14, 9, 5);

test("planTitle", () => {
	assert.equal(planTitle("## Plan: Per-flow delivery\n1. Goal"), "Per-flow delivery");
	assert.equal(planTitle(undefined), "");
	assert.equal(planTitle("no plan here"), "");
});

test("branchName slugs the title", () => {
	assert.equal(branchName("flow/", "Per-flow delivery (commit / push / PR / merge)", d), "flow/per-flow-delivery-commit-push-pr-merge");
	assert.equal(branchName("flow/", "A".repeat(60), d), `flow/${"a".repeat(40)}`);
	assert.equal(branchName("flow/", `${"a".repeat(39)} bc`, d), `flow/${"a".repeat(39)}`);
	assert.equal(branchName("flow/", "!!!", d), "flow/flow-20261014-0905");
	assert.equal(branchName("my prefix/", "x", d), "myprefix/x");
});

test("final plan asks for commits only when splitting", () => {
	assert.ok(finalize(true).includes("9. Commits:"));
	assert.ok(!finalize(false).includes("9. Commits"));
	assert.ok(finalize(true).includes("### Stage 1:"));
	assert.ok(!finalize(true).includes("(delivery:"));
	assert.ok(finalize(true).includes("Delivery: no merge"));
	for (const f of [finalize(true), finalize(false)]) {
		assert.ok(f.includes("8. Risks, rollback"));
		assert.ok(f.endsWith("How to write the code is the executor's job."));
		assert.ok(f.includes("Give direction, not implementation."));
		assert.ok(!f.includes("code for non-trivial logic"));
	}
});

test("final plan stages on its own unless onRequest", () => {
	const auto = finalize(true);
	assert.ok(auto.includes("builds on an earlier one"));
	assert.ok(auto.includes("### Stage 1:"));
	assert.ok(auto.includes("its own tests"));
	assert.ok(!auto.includes("in one go, group"));
	const manual = finalize(true, "onRequest");
	assert.ok(manual.includes("Only when the user asked for the work to be delivered in parts"));
	assert.ok(manual.includes("### Stage 1:"));
	assert.ok(!manual.includes("builds on an earlier one"));
	for (const f of [auto, manual]) assert.ok(f.endsWith("How to write the code is the executor's job."));
});

test("planner proposes stages unless onRequest", () => {
	const auto = planPhase(true);
	assert.ok(auto.includes("Staged delivery") && auto.includes("Propose stages yourself"));
	assert.ok(!auto.includes("### Stage 1:"));
	const manual = planPhase(true, "onRequest");
	assert.ok(manual.includes("Staged delivery") && !manual.includes("Propose stages yourself"));
	assert.ok(planPhase(false).includes("### Stage 1:"));
	assert.ok(planPhase(false, "onRequest").includes("### Stage 1:"));
});

test("planner repeats only plan changes unless always", () => {
	const d = planPhase(true);
	assert.ok(d.includes("don't repeat it") && d.includes("only the changes") && !d.includes("(the plan so far)"));
	const a = planPhase(true, "auto", "always");
	assert.ok(a.includes("(the plan so far)") && !a.includes("don't repeat it"));
	const n = planPhase(false);
	assert.ok(n.includes("(the plan so far)") && !n.includes("don't repeat it"));
});

test("show plan message", () => {
	assert.ok(SHOW_PLAN.includes("whole current plan") && SHOW_PLAN.includes("Plan:"));
});

