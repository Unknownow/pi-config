// node --test stages.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStage, parseStages, planWaitProblems, stageNote, stageStart, stagesOutcome } from "./stages.ts";

test("parses stage headings", () => {
	assert.deepEqual(parseStages("## Plan: X\n### Stage 1: Core\ntext\n### Stage 2: UI (delivery: merge)\n"), [
		{ n: 1, title: "Core" },
		{ n: 2, title: "UI" },
	]);
	const s = parseStages("#### **Stage 1** \u2014 A\n## Stage 2. B");
	assert.deepEqual(s.map((x) => x.title), ["A", "B"]);
});

test("not staged", () => {
	assert.deepEqual(parseStages("### Stage 1: A"), []);
	assert.deepEqual(parseStages("### Stage 1: A\n### Stage 3: C"), []);
	assert.deepEqual(parseStages("### Stage 2: B\n### Stage 1: A"), []);
	assert.deepEqual(parseStages(undefined), []);
	assert.deepEqual(parseStages("Stage 1: A\nStage 2: B"), []);
});

test("duplicates count once", () => {
	const s = parseStages("### Stage 1: A\n### Stage 2: B\n### Stage 2: other");
	assert.equal(s.length, 2);
	assert.equal(s[1].title, "B");
});

test("unknown tag", () => {
	const s = parseStages("### Stage 1: A (delivery: off)\n### Stage 2: B (delivery: ship)");
	assert.deepEqual(s, [
		{ n: 1, title: "A" },
		{ n: 2, title: "B" },
	]);
});

test("a delivery tag in a heading is stripped and ignored", () => {
	const s = parseStages("### Stage 1: A (delivery: push)\n### Stage 2: B");
	assert.deepEqual(s[0], { n: 1, title: "A" });
});

test("stageStart and nextStage", () => {
	const s = parseStages("### Stage 1: A\n### Stage 2: B (delivery: merge)");
	const t = stageStart(s, 2);
	assert.ok(t.includes("Do stage 2 only"));
	assert.ok(t.includes('"B"'));
	assert.ok(t.includes("call `judge`"));
	assert.ok(t.includes("deliver the stage yourself") && t.includes("merge"));
	assert.ok(!t.includes("once the judge has passed"));
	assert.ok(!t.includes("the workflow delivers"));
	assert.ok(t.includes("This is the last stage."));
	assert.ok(!stageStart(s, 1).includes("last stage"));
	assert.ok(nextStage(s, 2, "committed").startsWith('Stage 1 ("A") is delivered: committed'));
});

test("stageNote", () => {
	const s = parseStages("### Stage 1: A\n### Stage 2: B\n### Stage 3: C");
	const first = stageNote(s, 1);
	assert.ok(first.includes("Stages 2-3 are not started"));
	assert.ok(!first.includes("already done"));
	const last = stageNote(s, 3);
	assert.ok(last.includes("Stages 1-2 are already done") && last.includes("is not a finding"));
	assert.ok(!last.includes("not started"));
});

test("stagesOutcome", () => {
	assert.deepEqual(stagesOutcome([{ text: "a", ok: true }, { text: "b", ok: true }], 2), { text: "stage 1: a; stage 2: b", ok: true });
	const part = stagesOutcome([{ text: "a", ok: true }], 3);
	assert.ok(part.text.startsWith("stopped after stage 1 of 3: "));
	assert.equal(part.ok, false);
	assert.equal(stagesOutcome([{ text: "a", ok: true }, { text: "b", ok: false }], 2).ok, false);
});

test("parseStages reads an after tag", () => {
	const check = "git ls-remote --exit-code --tags origin com.iecgames.core/v0.15.0";
	const stages = parseStages(`### Stage 1: core\n### Stage 2: game-template (after: publish core 0.15.0; check: ${check})\n`);
	assert.equal(stages[1].title, "game-template");
	assert.deepEqual(stages[1].after, { reason: "publish core 0.15.0", check });
});

test("parseStages reads a delivery tag and after in either order", () => {
	for (const tags of ["(delivery: merge) (after: x; check: y)", "(after: x; check: y) (delivery: merge)"]) {
		const s = parseStages(`### Stage 1: a\n### Stage 2: b ${tags}\n`)[1];
		assert.equal(s.title, "b");
		assert.equal((s as { delivery?: string }).delivery, undefined);
		assert.deepEqual(s.after, { reason: "x", check: "y" });
	}
});

test("parseStages: an after tag without a check", () => {
	const s = parseStages("### Stage 1: a\n### Stage 2: b (after: open the Editor)\n")[1];
	assert.equal(s.after?.reason, "open the Editor");
	assert.equal(s.after?.check, undefined);
});

test("parseStages strips backticks from an after check", () => {
	const s = parseStages("### Stage 1: a\n### Stage 2: b (after: published; check: `git ls-remote --exit-code --tags origin p/v1`)\n");
	assert.equal(s[1].after?.check, "git ls-remote --exit-code --tags origin p/v1");
});

test("planWaitProblems reports the reward-ads checks", () => {
	const plan = [
		"### Stage 1: core",
		"### Stage 2: set (after: Stage 1 published; check: `git -C D:/r ls-remote --exit-code --tags origin s/v<new set version>`)",
		"### Stage 3: template (after: Stage 1 published; check: the same `ls-remote` as Stage 2)",
	].join("\n");
	const out = planWaitProblems(plan, (c) => (c.startsWith("the") ? "not read-only" : null));
	assert.equal(out.length, 2);
	assert.ok(out[0].startsWith("Stage 2 check: has a placeholder"));
	assert.ok(out[1].startsWith("Stage 3 check:"));
});

test("planWaitProblems checks Wait steps", () => {
	const out = planWaitProblems("**S4.** Wait: open the Editor (check: echo a`b`)", () => null);
	assert.equal(out.length, 1);
	assert.ok(out[0].startsWith("S4 check: uses command substitution"));
});

test("planWaitProblems clean plan", () => {
	const plan = "### Stage 1: a\n### Stage 2: b (after: x; check: git ls-remote --exit-code --tags origin p/v1)\n**S3.** Wait: y (check: git ls-remote origin q)";
	assert.deepEqual(planWaitProblems(plan, () => null), []);
});
