import assert from "node:assert/strict";
import test from "node:test";
import { commitPlan, isFlowId, mergeChecklist, newFlowId, normalizeRemote, openStepsReminder, parseChecklist, parseStatus, planCard, pruneIds, renderPlanFile, splitPlanFile } from "./plan-doc.ts";

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

test("renderPlanFile/splitPlanFile round-trip", () => {
	const plan = "## Plan: x\n### 5. Steps\n**S1.** a\n## Checklist\nown text\n";
	const list = parseChecklist(plan);
	assert.equal(splitPlanFile(renderPlanFile("20261015-0930-x-a1b2", plan, list)), plan);
	assert.equal(splitPlanFile(renderPlanFile("20261015-0930-x-a1b2", "no newline", [])), "no newline");
	const done = renderPlanFile("20261015-0930-x-a1b2", plan, [{ ...list[0], done: true }], { at: "2026-10-15T09:30:00Z", ok: true, text: "delivered" });
	assert.ok(done.includes("- [x] S1 a"));
	assert.ok(done.includes("## Outcome"));
	assert.ok(done.includes("— ok: delivered"));
	assert.equal(splitPlanFile(done), plan);
	assert.equal(splitPlanFile("plain"), "plain");
});

test("newFlowId format", () => {
	assert.equal(newFlowId("Cheaper commit step!", new Date(2026, 9, 15, 9, 30), "a1b2"), "20261015-0930-cheaper-commit-step-a1b2");
	assert.equal(newFlowId("", new Date(2026, 9, 15, 9, 30), "a1b2"), "20261015-0930-flow-a1b2");
	const long = newFlowId("word ".repeat(30), new Date(2026, 0, 2, 3, 4), "ffff");
	assert.ok(isFlowId(long));
	assert.ok(long.length <= 14 + 40 + 5);
});

test("normalizeRemote", () => {
	assert.equal(normalizeRemote("git@github.com:Org/A.git"), "github.com/Org/A");
	assert.equal(normalizeRemote("https://user@GitHub.com/Org/A.git"), "github.com/Org/A");
	assert.equal(normalizeRemote("ssh://git@host:22/x/y"), "host:22/x/y");
});

test("parseStatus rejects malformed", () => {
	const ok = { v: 1, flowId: "20261015-0930-x-a1b2", rev: 2, updated: "2026-10-15T09:30:00Z", title: "x", stage: 2, delivery: "commit", done: ["S1"], repos: [{ remote: "h/x", branch: "main", primary: true }] };
	assert.deepEqual(parseStatus(JSON.stringify(ok)), ok);
	assert.equal(parseStatus(JSON.stringify({ ...ok, v: 2 })), null);
	assert.equal(parseStatus(JSON.stringify({ ...ok, flowId: "bad" })), null);
	assert.equal(parseStatus(JSON.stringify({ ...ok, done: "S1" })), null);
	assert.equal(parseStatus("not json"), null);
});

test("parseStatus keeps kind test and drops other kinds", () => {
	const ok = { v: 1, flowId: "20261015-0930-x-a1b2", rev: 1, updated: "2026-10-15T09:30:00Z", title: "x", done: [], repos: [] };
	assert.equal(parseStatus(JSON.stringify({ ...ok, kind: "test" }))?.kind, "test");
	assert.equal(parseStatus(JSON.stringify({ ...ok, kind: "other" }))?.kind, undefined);
});

test("pruneIds", () => {
	const DAY = 86_400_000;
	const now = 100 * DAY;
	const e = (flowId: string, ago: number, finished: boolean) => ({ flowId, updated: now - ago * DAY, finished });
	const three = [e("a", 3, true), e("b", 2, true), e("c", 1, true)];
	assert.deepEqual(pruneIds(three, { keepDays: 14, keepCount: 2, now }), ["a"]);
	assert.deepEqual(pruneIds([e("old", 20, false)], { keepDays: 14, keepCount: 50, now }), ["old"]);
	assert.deepEqual(pruneIds([e("old", 20, false)], { keepDays: 14, keepCount: 50, now, activeId: "old" }), []);
	assert.deepEqual(pruneIds([e("old", 90, true)], { keepDays: 0, keepCount: 50, now }), []);
	assert.deepEqual(pruneIds([...three, e("act", 0, false)], { keepDays: 0, keepCount: 0, now, activeId: "act" }).sort(), ["a", "b", "c"]);
});

test("planCard lists a pass-upheld plan flaw as an amendment", () => {
	const card = planCard(`${PLAN}\n\n## Plan choices upheld at a pass\na.ts:3 - minor - [plan-flaw] x`, [], undefined, undefined, "/p");
	assert.ok(card.includes("### Amendments"));
});

const item = (id: string, done: boolean, stage?: number) => ({ id, text: id, done, stage });
const TAIL = "Tick the finished ones with `plan_check`.";

test("openStepsReminder: none open", () => {
	assert.equal(openStepsReminder([item("S1", true)]), undefined);
	assert.equal(openStepsReminder(undefined), undefined);
	assert.equal(openStepsReminder([]), undefined);
});

test("openStepsReminder: lists open steps in order", () => {
	assert.equal(openStepsReminder([item("S1", true), item("S2", false), item("S3", false)]), `Open steps not ticked: S2, S3. ${TAIL}`);
});

test("openStepsReminder: singular", () => {
	assert.equal(openStepsReminder([item("S1", true), item("S2", false)]), `Open step not ticked: S2. ${TAIL}`);
});

test("openStepsReminder: only the current stage", () => {
	assert.equal(openStepsReminder([item("S1", false, 1), item("S2", false, 2), item("S3", false)], 2), `Open steps not ticked: S2, S3. ${TAIL}`);
});
