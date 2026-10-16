// node --experimental-strip-types --test prompts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXECUTE_PHASE, planPhase } from "./prompts.ts";

const BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, ctx_batch_execute, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;
const PLAN_BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, ctx_execute for read-only analysis, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;

test("plan phase keeps its batch line", () => {
	assert.ok(planPhase(true).includes(PLAN_BATCH));
	assert.ok(planPhase(false, "onRequest", "always").includes(PLAN_BATCH));
});

test("execute phase keeps its batch line", () => {
	assert.ok(EXECUTE_PHASE.includes(BATCH));
});
