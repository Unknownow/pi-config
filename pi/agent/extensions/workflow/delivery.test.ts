// node --test delivery.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName, planTitle } from "./delivery.ts";
import { planPhase } from "./prompts.ts";

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

test("the plan prompt asks for the final plan with commits and stages", () => {
	const p = planPhase();
	assert.ok(p.includes("9. Commits:"));
	assert.ok(p.includes("### Stage 1:"));
	assert.ok(p.includes("Delivery: no merge"));
	assert.ok(p.includes("8. Risks, rollback"));
	assert.ok(p.includes("give direction, not implementation"));
	assert.ok(p.includes("builds on an earlier one"));
	assert.ok(planPhase("onRequest").includes("Use stages only when the user asks for the work to be delivered in parts"));
	assert.ok(!planPhase("onRequest").includes("builds on an earlier one"));
});

test("the plan prompt names both templates and the change sections", () => {
	const p = planPhase();
	assert.ok(p.includes("short template") && p.includes("full template"));
	assert.ok(p.includes("## Plan changes") && p.includes("with no rewrite"));
	assert.ok(p.includes("Staged delivery") && p.includes("Propose stages yourself"));
	assert.ok(!planPhase("onRequest").includes("Propose stages yourself"));
});
