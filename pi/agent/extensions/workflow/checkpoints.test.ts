import assert from "node:assert/strict";
import test from "node:test";
import { checkpointAmendment, checkpointNote, checkpointOutcome, checkpointText, deliverHint, deliverHintsBlock, deliverStepSpec, hasCheckpointAmendment, isPlannedTag, parseDeliverStep, publishRefusal, withCheckpoints } from "./checkpoints.ts";

test("parseDeliverStep", () => {
	const plan = "**S1.** Edit code\n**S2.** Deliver: push, move tag unity-build/v1\n- [ ] **S3.** deliver: commit";
	assert.equal(parseDeliverStep(plan, "S2"), "push, move tag unity-build/v1");
	assert.equal(parseDeliverStep(plan, "S3"), "commit");
	assert.equal(parseDeliverStep(plan, "S1"), null);
	assert.equal(parseDeliverStep(plan, "S9"), null);
});

test("isPlannedTag", () => {
	assert.equal(isPlannedTag("push, tag a/v1", "a/v1", false), true);
	assert.equal(isPlannedTag("push, tag a/v1", "a/v1", true), false);
	assert.equal(isPlannedTag("move a/v1 to main", "a/v1", true), true);
	assert.equal(isPlannedTag(null, "a/v1", false), false);
});

test("checkpoint texts", () => {
	assert.equal(checkpointAmendment(2, { tag: "a/v1", reason: "core needed" }), "## Amendment 2 (executor: checkpoint)\ntag a/v1 — core needed");
	assert.equal(checkpointText("S4", "pushed"), "checkpoint S4: pushed");
	assert.equal(checkpointText(undefined, "pushed"), "checkpoint unplanned: pushed");
	assert.equal(withCheckpoints(["checkpoint S4: pushed"], "committed (2 commits)"), "checkpoint S4: pushed; committed (2 commits)");
	assert.equal(checkpointNote([]), "");
	assert.ok(checkpointNote([{ text: "checkpoint S4: pushed" }]).startsWith("## Checkpoints already delivered\n\ncheckpoint S4: pushed."));
});

test("checkpointOutcome", () => {
	assert.equal(checkpointOutcome([]), null);
	assert.deepEqual(checkpointOutcome([{ text: "checkpoint S4: pushed", ok: true }]), { text: "checkpoint S4: pushed; no further changes", ok: true });
	assert.equal(checkpointOutcome([{ text: "a", ok: true }, { text: "b", ok: false }])?.ok, false);
});

test("hasCheckpointAmendment", () => {
	const c = { tag: "a/v1", reason: "core needed" };
	const plan = `## Plan\n\n${checkpointAmendment(1, c)}\n`;
	assert.equal(hasCheckpointAmendment(plan, c), true);
	assert.equal(hasCheckpointAmendment(plan, { ...c, reason: "other" }), false);
	assert.equal(hasCheckpointAmendment("## Plan", c), false);
});

const PLAN = ["**S1.** Edit the code.", "**S2.** Deliver: merge — the branch", "**S3.** Deliver: tag v1 after the pull request", "**S4.** Deliver: tag foo"].join("\n");

test("deliverStepSpec", () => {
	assert.equal(deliverStepSpec(PLAN, "S1"), null);
	assert.deepEqual(deliverStepSpec(PLAN, "S2"), { tag: false });
	assert.deepEqual(deliverStepSpec(PLAN, "S3"), { tag: true });
});

test("deliverHint: only tag steps get a call", () => {
	assert.equal(deliverHint("S2", { tag: false }), "");
	assert.match(deliverHint("S4", { tag: true }), /tag: …, step: "S4"/);
});

test("a Deliver merge step gives no deliver hint, a tag step does", () => {
	const list = [
		{ id: "S1", text: "Edit the code.", done: false },
		{ id: "S2", text: "Deliver: merge — the branch", done: false },
		{ id: "S3", text: "Deliver: tag v1 after the pull request", done: false },
		{ id: "S4", text: "Deliver: tag foo", done: true },
	];
	const block = deliverHintsBlock(PLAN, list, undefined) ?? "";
	assert.doesNotMatch(block, /S2/);
	assert.match(block, /- S3 → call deliver \{tag: …, step: "S3"\}/);
	assert.equal(deliverHintsBlock(PLAN, [list[0], list[1]], undefined), undefined);
});

test("deliverHintsBlock filters by stage and skips human items", () => {
	const list = [
		{ id: "S2", text: "Deliver: tag a", done: false, stage: 1 },
		{ id: "S3", text: "Deliver: tag b", done: false, stage: 2 },
		{ id: "S5", text: "Deliver: tag c", done: false, stage: 2, human: true as const },
	];
	const p = "**S2.** Deliver: tag a\n**S3.** Deliver: tag b\n**S5.** Deliver: tag c";
	assert.equal(deliverHintsBlock(p, list, 2), 'Deliver steps:\n- S3 → call deliver {tag: …, step: "S3"} as the step names it');
});

test("publishRefusal never sends the executor to the user", () => {
	assert.equal(publishRefusal("git push --force is never allowed"), "Refused: git push --force is never allowed.");
	assert.doesNotMatch(publishRefusal("x"), /user/i);
});
