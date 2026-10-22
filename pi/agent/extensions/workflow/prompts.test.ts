// node --experimental-strip-types --test prompts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVISOR, ARBITER, COMMIT, EXECUTE_PHASE, EXPLORE, JUDGE, JUDGE_KNOWLEDGE_ONLY, NO_SLEEP, PACE, phaseSection, planPhase, RUNNER, TEST_PHASE } from "./prompts.ts";

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

test("phaseSection gives the test supervisor prompt in the test phase", () => {
	const text = phaseSection("test", SECTION_OPTS) ?? "";
	for (const s of ["test_run", "[ask]", "VERDICT: CLEAN | BUGS", "unity:", "device:"]) assert.ok(text.includes(s), s);
});

test("the runner prompt names its reply format", () => {
	assert.ok(RUNNER.includes("RESULT: PASS | FAIL | ERROR"));
});

test("phaseSection is null outside plan, execute and test", () => {
	assert.equal(phaseSection("off", SECTION_OPTS), null);
});

test("the test report template parses", async () => {
	const { TEST_PHASE } = await import("./prompts.ts");
	const { parseTestReport } = await import("./test-report.ts");
	const tpl = TEST_PHASE.slice(TEST_PHASE.indexOf("## Test report:")).split("\n  (one line")[0].replace("VERDICT: CLEAN | BUGS", "VERDICT: BUGS");
	const r = parseTestReport(tpl, { nextId: 1, known: [], mustReport: [] } as never);
	assert.ok(r);
	assert.deepEqual(r.problems, []);
	assert.equal(r.items.length, 5);
});

test("fix round prompts", async () => {
	const p = await import("./prompts.ts");
	const opts = { finalize: false, staging: "off", recap: "off" } as never;
	assert.ok(!p.phaseSection("execute", opts)!.includes("Fix round of a test flow"));
	assert.ok(p.phaseSection("execute", { ...(opts as object), testFix: true } as never)!.includes("regression test"));
	assert.ok(!p.JUDGE.includes("test flow"));
	assert.match(p.JUDGE_TEST, /weakened, deleted or rewritten/);
	assert.match(p.ARBITER_TEST, /ASK_USER/);
	const msg = p.testRoundMessage({ why: "retest", fixed: [{ id: "S1", repro: "run it" }], ran: ["unity run-tests"], answers: ["D2. S3: yes"], nextId: 5 });
	for (const t of ["S1: run it", "unity run-tests", "D2. S3: yes", "S5"]) assert.ok(msg.includes(t), t);
	assert.match(p.fixRoundMessage(["S1", "S2"], ["repo: ?? x"]), /S1, S2[\s\S]*repo: \?\? x/);
});

test("execute prompt names deliver and wait_for_user", () => {
	assert.ok(EXECUTE_PHASE.includes("deliver"));
	assert.ok(EXECUTE_PHASE.includes("wait_for_user"));
	assert.ok(!EXECUTE_PHASE.includes("even when the plan says to"));
});

test("planner prompts teach Deliver and Wait steps", async () => {
	const { finalize } = await import("./prompts.ts");
	for (const text of [planPhase(true, "auto"), finalize(false)]) {
		assert.ok(text.includes("Deliver:"));
		assert.ok(text.includes("Wait:"));
		assert.ok(text.includes("(after:"));
	}
});

test("every role carries the keep-working and parallel rule", () => {
	for (const [name, text] of Object.entries({ plan: planPhase(true), execute: EXECUTE_PHASE, test: TEST_PHASE, JUDGE, ARBITER, EXPLORE, ADVISOR, RUNNER, JUDGE_KNOWLEDGE_ONLY })) assert.ok(text.includes(PACE), name);
	assert.ok(!COMMIT.includes(PACE));
});

test("execute and test prompts forbid fixed long sleeps", () => {
	assert.ok(EXECUTE_PHASE.includes(NO_SLEEP));
	assert.ok(TEST_PHASE.includes(NO_SLEEP));
});
