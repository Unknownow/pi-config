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

import { deliverMergeOpen, isMergeDeliver, mergeAmendment, mergeDecisions, mergeDecisionsText } from "./checkpoints.ts";

test("deliverMergeOpen: scoped to the stage, ignores ticked, tag and no-merge steps", () => {
	const plan = "**S1.** Deliver: merge — core\n**S2.** Deliver: tag v1\n**S3.** Deliver: push — no merge\n**S4.** Deliver: merge — ui";
	assert.equal(isMergeDeliver(plan, "S1"), true);
	assert.equal(isMergeDeliver(plan, "S2"), false);
	assert.equal(isMergeDeliver(plan, "S3"), false);
	const list = [
		{ id: "S1", text: "Deliver: merge — core", done: false, stage: 1 },
		{ id: "S2", text: "Deliver: tag v1", done: false, stage: 1 },
		{ id: "S3", text: "Deliver: push — no merge", done: false, stage: 1 },
		{ id: "S4", text: "Deliver: merge — ui", done: false, stage: 2 },
	];
	assert.equal(deliverMergeOpen(plan, list, 1), true);
	assert.equal(deliverMergeOpen(plan, list, 2), true);
	assert.equal(deliverMergeOpen(plan, list, 3), false);
	assert.equal(deliverMergeOpen(plan, [{ ...list[0], done: true }, list[1], list[2]], 1), false);
	assert.equal(deliverMergeOpen(plan, list.slice(1, 3), undefined), false);
});

test("mergeDecisions reads amendments and round-trips mergeAmendment", () => {
	const plan = `## Plan: X\n\n${mergeAmendment(1, { by: "arbiter", allowed: true, stage: 2, reason: "S5 publishes\nthe code" })}\n\n${mergeAmendment(2, { by: "user", allowed: false, stage: 0, reason: "not needed" })}`;
	assert.deepEqual(mergeDecisions(plan), [
		{ allowed: true, by: "arbiter", stage: 2, reason: "S5 publishes the code" },
		{ allowed: false, by: "user", stage: 0, reason: "not needed" },
	]);
	assert.ok(plan.includes("## Amendment 1 (arbiter: merge)\nMerge allowed in stage 2:"));
	assert.ok(plan.includes("(user: no merge)\nMerge refused in this flow:"));
	assert.equal(mergeDecisionsText(plan), "mid-flow merge allowed by arbiter (stage 2): S5 publishes the code; mid-flow merge refused by user (whole flow): not needed");
	assert.deepEqual(mergeDecisions(undefined), []);
	assert.equal(mergeDecisionsText("no amendments"), "");
});
