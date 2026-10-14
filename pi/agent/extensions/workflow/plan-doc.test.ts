import assert from "node:assert/strict";
import test from "node:test";
import { commitPlan, mergeChecklist, parseChecklist, planCard } from "./plan-doc.ts";

const PLAN = `## Plan: Demo
### 1. Goal and non-goals
Make x work.
### 2. User decisions
- D1: use y
### 3. Facts
Facts text here.
### 5. Steps
### Stage 1: A
**S1.** Do **x** now
### Stage 2: B
- **S2:** Do y
3. S3) Do z
### 6. Tests
**S9.** not a step
### 7. Done when
- x works
### 9. Commits
- \`feat: demo\`: a.ts`;

test("parseChecklist reads step IDs and stages", () => {
	assert.deepEqual(parseChecklist(PLAN), [
		{ id: "S1", text: "Do x now", stage: 1, done: false },
		{ id: "S2", text: "Do y", stage: 2, done: false },
		{ id: "S3", text: "Do z", stage: 2, done: false },
	]);
});

test("parseChecklist: no IDs gives []; duplicate keeps first; only the Steps section", () => {
	assert.deepEqual(parseChecklist("## Plan: x\n5. Steps\n- do it"), []);
	const dup = parseChecklist("5. Steps\n**S1.** first\n**S1.** second");
	assert.equal(dup.length, 1);
	assert.equal(dup[0].text, "first");
	assert.ok(!parseChecklist(PLAN).some((i) => i.id === "S9"));
	assert.equal(parseChecklist("**S4.** loose").length, 1);
});

test("mergeChecklist keeps ticks by ID", () => {
	const old = parseChecklist(PLAN).map((i) => ({ ...i, done: i.id === "S1" }));
	const merged = mergeChecklist(`${PLAN}\n\n## Amendment 1 (arbiter)\nx`, old);
	assert.deepEqual(merged.map((i) => i.done), [true, false, false]);
});

test("planCard shows goal, decisions, done-when and open steps", () => {
	const list = parseChecklist(PLAN).map((i) => ({ ...i, done: i.id === "S1" }));
	const card = planCard(PLAN, list, 2, 2, "/p/plan.md");
	assert.ok(card.startsWith("## Plan card (full plan: /p/plan.md)"));
	assert.ok(card.includes("### Done when"));
	assert.ok(card.includes("- [ ] S2"));
	assert.ok(!card.includes("S1 "));
	assert.ok(card.includes("stage 2 of 2"));
	assert.ok(!card.includes("Facts text here"));
});

test("planCard without a path carries the full plan; with a path it does not; without sections it is the plan", () => {
	const bare = planCard(PLAN, undefined);
	assert.ok(bare.startsWith("## Plan card\n"));
	assert.ok(!bare.includes("Read "));
	assert.ok(bare.includes("## Full plan (no plan file yet)"));
	assert.ok(bare.includes("Facts text here"));
	const withPath = planCard(PLAN, undefined, undefined, undefined, "/p/plan.md");
	assert.ok(!withPath.includes("Full plan (no plan file yet)"));
	assert.ok(!withPath.includes("Facts text here"));
	assert.ok(planCard("just text", undefined, undefined, undefined, "/p").startsWith("## The approved plan"));
});

test("planCard includes amendments", () => {
	const card = planCard(`${PLAN}\n\n## Amendment 1 (arbiter)\nchange x`, [], undefined, undefined, "/p");
	assert.ok(card.includes("### Amendments"));
	assert.ok(card.includes("change x"));
});

test("commitPlan keeps goal and commits", () => {
	const c = commitPlan(PLAN) ?? "";
	assert.ok(c.includes("Make x work."));
	assert.ok(c.includes("feat: demo"));
	assert.ok(!c.includes("Facts text here"));
	assert.equal(commitPlan("## Plan: x\n1. Goal\nonly goal"), null);
});

test("planCard lists a step above the first stage heading as open in every stage", () => {
	const plan = "## Plan: x\n1. Goal\ng\n5. Steps\n**S1.** early\n### Stage 1: A\n**S2.** a\n### Stage 2: B\n**S3.** b\n7. Done when\nd";
	const card = planCard(plan, parseChecklist(plan), 2, 2, "/p");
	assert.ok(card.includes("- [ ] S1 early"));
	assert.ok(card.includes("- [ ] S3 b"));
	assert.ok(!card.includes("S2 a"));
});
