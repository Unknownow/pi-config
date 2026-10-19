// node --experimental-strip-types --test prompts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXECUTE_PHASE, phaseSection, planPhase } from "./prompts.ts";

const BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, ctx_batch_execute, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;
const PLAN_BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, ctx_execute for read-only analysis, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;

test("plan phase keeps its batch line", () => {
	assert.ok(planPhase(true).includes(PLAN_BATCH));
	assert.ok(planPhase(false, "onRequest", "always").includes(PLAN_BATCH));
});

test("execute phase keeps its batch line", () => {
	assert.ok(EXECUTE_PHASE.includes(BATCH));
});

const SECTION_OPTS = { finalize: true, staging: "auto", recap: "changes" } as const;

test("phaseSection gives the plan prompt in the plan phase", () => {
	const text = phaseSection("plan", SECTION_OPTS);
	assert.equal(text, planPhase(true, "auto", "changes"));
	assert.ok(text?.includes("## Workflow: PLAN phase"));
});

test("phaseSection gives the execute prompt, with the stage line when staged", () => {
	assert.equal(phaseSection("execute", SECTION_OPTS), EXECUTE_PHASE);
	assert.equal(phaseSection("execute", { ...SECTION_OPTS, stage: "- Current stage: 1 of 2" }), `${EXECUTE_PHASE}
- Current stage: 1 of 2`);
});

test("phaseSection is null outside plan and execute", () => {
	assert.equal(phaseSection("off", SECTION_OPTS), null);
});
