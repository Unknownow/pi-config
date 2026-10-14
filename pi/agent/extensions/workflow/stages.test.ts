// node --test stages.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { nextStage, parseStages, stageDelivery, stageNote, stageStart, stagesOutcome } from "./stages.ts";

test("parses stage headings", () => {
	assert.deepEqual(parseStages("## Plan: X\n### Stage 1: Core\ntext\n### Stage 2: UI (delivery: merge)\n"), [
		{ n: 1, title: "Core" },
		{ n: 2, title: "UI", delivery: "merge" },
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

test("stageDelivery", () => {
	assert.equal(stageDelivery("off", { n: 1, title: "a", delivery: "merge" }), "off");
	assert.equal(stageDelivery("commit", { n: 1, title: "a", delivery: "merge" }), "merge");
	assert.equal(stageDelivery("push", { n: 1, title: "a" }), "push");
	assert.equal(stageDelivery("pr", undefined), "pr");
});

test("stageStart and nextStage", () => {
	const s = parseStages("### Stage 1: A\n### Stage 2: B (delivery: merge)");
	const t = stageStart(s, 2, "commit");
	assert.ok(t.includes("Do stage 2 only"));
	assert.ok(t.includes('"B"'));
	assert.ok(t.includes("call `judge`"));
	assert.ok(t.includes("commit + push + pull request + merge"));
	assert.ok(t.includes("This is the last stage."));
	assert.ok(!stageStart(s, 1, "commit").includes("last stage"));
	assert.ok(nextStage(s, 2, "commit", "committed").startsWith('Stage 1 ("A") is delivered: committed'));
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
