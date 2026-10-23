// node --experimental-strip-types --test prompts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVISOR, ARBITER, COMMIT, EXECUTE_PHASE, EXPLORE, FIX_ROUND, JUDGE, JUDGE_KNOWLEDGE_ONLY, NO_SLEEP, PACE, deliveryGuidance, finalize, phaseSection, PLAN_KICKOFF, planPhase, RUNNER, TEST_PHASE, workspaceSection } from "./prompts.ts";

const BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, run_code, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;
const PLAN_BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, run_code for read-only analysis, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;

test("plan phase keeps its batch line", () => {
	assert.ok(planPhase(true).includes(PLAN_BATCH));
	assert.ok(planPhase(false, "onRequest", "always").includes(PLAN_BATCH));
});

test("execute phase keeps its batch line", () => {
	assert.ok(EXECUTE_PHASE.includes(BATCH));
});

const SECTION_OPTS = { finalize: true, staging: "auto", recap: "changes" } as const;

test("discuss prompt asks for no plan; the plan prompt no longer calls the planner a discussion partner", () => {
	const d = phaseSection("discuss", SECTION_OPTS) ?? "";
	assert.ok(d.includes("## Workflow: DISCUSS phase") && d.includes("Agreed so far"));
	assert.ok(!/end the reply with a short `Plan:`|propose the plan in a short/.test(d));
	const p = phaseSection("plan", SECTION_OPTS) ?? "";
	assert.ok(p.includes("## Workflow: PLAN phase") && p.includes("Staged delivery") && !p.includes("partner in discussion"));
	assert.ok(PLAN_KICKOFF.includes("Plan:"));
});

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
		assert.ok(text.includes("no backticks around it"));
		assert.ok(text.includes("never for a merge or publish that an earlier stage does itself"));
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

test("slow suites run once and rerun only when touched", async () => {
	const { finalize } = await import("./prompts.ts");
	for (const x of ["While fixing, run the narrowest check that covers the change", "Run each slow suite in full once, before your first judge call", "After a judge round, rerun a slow suite only if the fix changed files it builds or reads; otherwise cite its last passing run", "then call `judge`"])
		assert.ok(EXECUTE_PHASE.includes(x), x);
	assert.ok(finalize(false).includes("Mark each suite slower than about 2 minutes as slow"));
	assert.ok(planPhase(false, "onRequest", "always").includes("Mark each suite slower than about 2 minutes as slow"));
	assert.ok(EXECUTE_PHASE.includes("When done, run the plan's tests as above"));
	assert.ok(FIX_ROUND.includes("rerun a slow suite only if the fix changed files it builds or reads"));
});

test("human checks are Verify steps, never Wait", () => {
	assert.ok(planPhase(true).includes("Verify:") && planPhase(true).includes("Wait:"));
	assert.ok(EXECUTE_PHASE.includes('kind: "verify"'));
	assert.ok(TEST_PHASE.includes("after the flow"));
});

test("delivery guidance in the prompts", () => {
	assert.match(finalize(false), /Deliver: <what>/);
	assert.match(finalize(false), /never contains .*git push/);
	assert.match(finalize(false), /Delivery: no merge/);
	assert.match(planPhase(false), /Deliver: <what>/);
	assert.doesNotMatch(finalize(true), /\(delivery:/);
});

test("the execute prompt makes delivery the executor's job and never the user's", () => {
	assert.ok(!EXECUTE_PHASE.includes("Never commit, push"));
	assert.doesNotMatch(EXECUTE_PHASE, /When the judge passes, end your turn/);
	assert.match(EXECUTE_PHASE, /When the judge passes, finish the delivery \(push, pull request, and the merge unless the plan says/);
	assert.ok(EXECUTE_PHASE.includes("git_task"));
	assert.ok(EXECUTE_PHASE.includes("call `judge`"));
	assert.doesNotMatch(EXECUTE_PHASE, /ask the user to (push|merge|open)/i);
	assert.doesNotMatch(EXECUTE_PHASE, /the workflow delivers/i);
});

test("deliveryGuidance names the configured settings", () => {
	const t = deliveryGuidance({ splitCommits: true, mergeMethod: "squash", deleteBranch: true, base: "", branchPrefix: "flow/" });
	assert.ok(t.includes("flow/<slug>") && t.includes("--squash --delete-branch") && t.includes("default branch"));
	assert.ok(phaseSection("execute", { ...SECTION_OPTS, delivery: t })?.includes(t));
});

test("EXPLORE sets a budget of tool calls", () => {
	assert.ok(EXPLORE.includes("about 10 tool calls"));
});

test("workspaceSection lists rules files sorted by path, after the rule line", () => {
	const rule = "Rules files of the added folders (not loaded): read a folder's files before you plan or change anything in it.";
	const text = workspaceSection("/w", ["/a"], [], [{ path: "/b/AGENTS.md", size: 20 }, { path: "/a/AGENTS.md", size: 5 }]);
	const lines = text.split("\n");
	const i = lines.indexOf(rule);
	assert.ok(i > 0);
	assert.equal(lines[i + 1], "- /a/AGENTS.md (5 characters)");
	assert.equal(lines[i + 2], "- /b/AGENTS.md (20 characters)");
});

test("workspaceSection without rules equals the three-argument output", () => {
	assert.equal(workspaceSection("/w", ["/a"], ["/t"], []), workspaceSection("/w", ["/a"], ["/t"]));
	assert.ok(!workspaceSection("/w", ["/a"], []).includes("Rules files"));
});

test("Publish and Mirror steps are in the planner and executor prompts", () => {
	assert.ok(planPhase(true).includes("Publish: <package>"));
	assert.ok(planPhase(true).includes("Mirror: <folder>|all"));
	assert.ok(!planPhase(true).includes("publish with `updates.bat`"));
	assert.ok(EXECUTE_PHASE.includes("publish_packages {step}"));
});
