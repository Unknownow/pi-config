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

import { deliverHint, deliverHintsBlock, deliverStepSpec, deliverStepWarnings, publishRefusal } from "./checkpoints.ts";

const PLAN = ["**S1.** Edit the code.", "**S2.** Deliver: push — the branch", "**S3.** Deliver: open a pull request and tag v1", "**S4.** Deliver: tag foo", "**S5.** Deliver: git push origin x"].join("\n");

test("deliverStepSpec", () => {
	assert.equal(deliverStepSpec(PLAN, "S1"), null);
	assert.deepEqual(deliverStepSpec(PLAN, "S2"), { mode: "push", tag: false });
	assert.deepEqual(deliverStepSpec(PLAN, "S3"), { mode: "pr", tag: true });
	assert.deepEqual(deliverStepSpec(PLAN, "S4"), { mode: undefined, tag: true });
});

test("deliverHint", () => {
	assert.equal(deliverHint("S2", { mode: "push", tag: false }, "merge"), '→ call deliver {mode: "push", step: "S2"}');
	assert.match(deliverHint("S2", { mode: "merge", tag: false }, "push"), /beyond this flow's delivery \(push\)/);
	assert.match(deliverHint("S2", { mode: "push", tag: false }, "off"), /delivery is off/);
	assert.match(deliverHint("S4", { tag: true }, "pr"), /tag: …, step: "S4"/);
});

test("deliverHintsBlock lists open Deliver steps of the stage only", () => {
	const list = [
		{ id: "S1", text: "Edit the code.", done: false },
		{ id: "S2", text: "Deliver: push — the branch", done: false },
		{ id: "S3", text: "Deliver: open a pull request and tag v1", done: true },
	];
	assert.equal(deliverHintsBlock(PLAN, list, undefined, "pr"), 'Deliver steps:\n- S2 → call deliver {mode: "push", step: "S2"}');
	assert.equal(deliverHintsBlock(PLAN, [list[0]], undefined, "pr"), undefined);
});

test("publishRefusal", () => {
	const withNext = publishRefusal("git push", { id: "S2", hint: '→ call deliver {mode: "push", step: "S2"}' }, "a PR");
	assert.match(withNext, /^Refused: git push\. To publish now, call deliver \{mode: "push", step: "S2"\}/);
	assert.match(withNext, /Never ask the user to run it for you\.$/);
	assert.match(publishRefusal("x", null, "a PR"), /end your turn: the workflow delivers it as a PR after the judge passes\. Never ask/);
});

test("deliverStepWarnings", () => {
	const w = deliverStepWarnings(PLAN, "push");
	assert.equal(w.length, 2);
	assert.match(w[0], /S3: Deliver pr is beyond/);
	assert.match(w[1], /S5: .*raw publish command/);
});

test("deliverStepSpec infers modes", () => {
	const p = ["**S1.** Deliver: pr — push and open the PR", "**S2.** Deliver: push and open the PR", "**S3.** Deliver: merge (D4)", "**S4.** Deliver: commit the LFS change", "**S5.** Deliver: push"].join("\n");
	assert.equal(deliverStepSpec(p, "S1")?.mode, "pr");
	assert.equal(deliverStepSpec(p, "S2")?.mode, "pr");
	assert.equal(deliverStepSpec(p, "S3")?.mode, "merge");
	assert.equal(deliverStepSpec(p, "S4")?.mode, "commit");
	assert.equal(deliverStepSpec(p, "S5")?.mode, "push");
});

test("deliverHintsBlock filters by stage and skips human items", () => {
	const list = [
		{ id: "S2", text: "Deliver: push — a", done: false, stage: 1 },
		{ id: "S3", text: "Deliver: pr — b", done: false, stage: 2 },
		{ id: "S4", text: "Deliver: push — c", done: true, stage: 2 },
		{ id: "S5", text: "Deliver: merge — d", done: false, stage: 2, human: true as const },
	];
	const p = "**S2.** Deliver: push — a\n**S3.** Deliver: pr — b\n**S4.** Deliver: push — c\n**S5.** Deliver: merge — d";
	assert.equal(deliverHintsBlock(p, list, 2, "pr"), 'Deliver steps:\n- S3 → call deliver {mode: "pr", step: "S3"}');
});

test("deliverStepWarnings per-step cap and publishRefusal with delivery off", () => {
	const w = deliverStepWarnings("**S1.** Deliver: push — a\n**S2.** Deliver: push — b", (id) => (id === "S1" ? "commit" : "push"));
	assert.equal(w.length, 1);
	assert.match(w[0], /^S1:/);
	assert.match(publishRefusal("x", null, "don't commit"), /Delivery is off/);
});
