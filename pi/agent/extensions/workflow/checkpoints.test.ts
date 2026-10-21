import assert from "node:assert/strict";
import test from "node:test";
import { checkpointAmendment, checkpointNote, checkpointText, isPlannedTag, modeAllowed, parseDeliverStep, withCheckpoints } from "./checkpoints.ts";

test("modeAllowed", () => {
	assert.equal(modeAllowed("push", "pr"), true);
	assert.equal(modeAllowed("merge", "push"), false);
	for (const m of ["commit", "push", "pr", "merge"]) assert.equal(modeAllowed(m, "off"), false);
});

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
	assert.equal(checkpointAmendment(2, { mode: "push", tag: "a/v1", reason: "core needed" }), "## Amendment 2 (executor: checkpoint)\nDeliver push, tag a/v1 — core needed");
	assert.equal(checkpointAmendment(1, { tag: "a/v1", reason: "r" }), "## Amendment 1 (executor: checkpoint)\ntag a/v1 — r");
	assert.equal(checkpointText("S4", "pushed"), "checkpoint S4: pushed");
	assert.equal(checkpointText(undefined, "pushed"), "checkpoint unplanned: pushed");
	assert.equal(withCheckpoints(["checkpoint S4: pushed"], "committed (2 commits)"), "checkpoint S4: pushed; committed (2 commits)");
	assert.equal(checkpointNote([]), "");
	assert.ok(checkpointNote([{ text: "checkpoint S4: pushed" }]).startsWith("## Checkpoints already delivered\n\ncheckpoint S4: pushed."));
});

test("checkpointOutcome", async () => {
	const { checkpointOutcome } = await import("./checkpoints.ts");
	assert.equal(checkpointOutcome([]), null);
	assert.deepEqual(checkpointOutcome([{ text: "checkpoint S4: pushed", ok: true }]), { text: "checkpoint S4: pushed; no further changes", ok: true });
	assert.equal(checkpointOutcome([{ text: "a", ok: true }, { text: "b", ok: false }])?.ok, false);
});

test("hasCheckpointAmendment", async () => {
	const { hasCheckpointAmendment } = await import("./checkpoints.ts");
	const c = { mode: "push", tag: "a/v1", reason: "core needed" };
	const plan = `## Plan\n\n${checkpointAmendment(1, c)}\n`;
	assert.equal(hasCheckpointAmendment(plan, c), true);
	assert.equal(hasCheckpointAmendment(plan, { ...c, reason: "other" }), false);
	assert.equal(hasCheckpointAmendment("## Plan", c), false);
});
