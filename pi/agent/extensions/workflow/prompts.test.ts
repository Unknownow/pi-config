// node --experimental-strip-types --test prompts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

// prompts.ts reads PACE and knowledgeTools from agents/api.ts, which loads the pi packages: stub them first.
await import("./test-hooks.ts");
const { ARBITER, COMMIT, DISCUSSION_CRITERIA, EXECUTE_PHASE, FIX_MESSAGE, FIX_TESTS, JUDGE_CRITERIA, MERGE_ARBITER, NO_SLEEP, NO_WORKFLOW, PACE, PLAN_CRITERIA, deliveryGuidance, JUDGE_MAJOR_ONLY, minorFixMessage, phaseSection, PLAN_KICKOFF, planPhase, workflowReposSection } = await import("./prompts.ts");
const { ADVISOR, CRITIC, EXPLORE, JUDGE, JUDGE_INCREMENTAL, RUNNER } = await import("../agents/api.ts");

const BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, run_code, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;
const PLAN_BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, run_code for read-only analysis, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;

test("plan phase keeps its batch line", () => {
	assert.ok(planPhase().includes(PLAN_BATCH));
});

test("execute phase keeps its batch line", () => {
	assert.ok(EXECUTE_PHASE.includes(BATCH));
});

const SECTION_OPTS = {} as const;

test("discuss prompt asks for no plan; the plan prompt no longer calls the planner a discussion partner", () => {
	const d = phaseSection("discuss", SECTION_OPTS) ?? "";
	assert.ok(d.includes("## Workflow: DISCUSS phase") && d.includes("Agreed so far"));
	assert.ok(!/end the reply with a short `Plan:`|propose the plan in a short/.test(d));
	const p = phaseSection("plan", SECTION_OPTS) ?? "";
	assert.ok(p.includes("## Workflow: PLAN phase") && p.includes("Stages: the workflow") && !p.includes("partner in discussion"));
	assert.ok(PLAN_KICKOFF.includes("## Plan:"));
});

test("phaseSection gives the plan prompt in the plan phase", () => {
	const text = phaseSection("plan", SECTION_OPTS);
	assert.equal(text, planPhase());
	assert.ok(text?.includes("## Workflow: PLAN phase"));
});

test("phaseSection gives the execute prompt, with the stage line when staged", () => {
	assert.equal(phaseSection("execute", SECTION_OPTS), EXECUTE_PHASE);
	assert.equal(phaseSection("execute", { ...SECTION_OPTS, stage: "- Current stage: 1 of 2" }), `${EXECUTE_PHASE}
- Current stage: 1 of 2`);
});

test("the runner prompt names its reply format", () => {
	assert.ok(RUNNER.includes("RESULT: PASS | FAIL | ERROR"));
});

test("phaseSection gives the inactive note outside discuss, plan and execute", () => {
	assert.ok(NO_WORKFLOW.length > 0);
	assert.equal(phaseSection("off", SECTION_OPTS), NO_WORKFLOW);
	assert.equal(phaseSection("", SECTION_OPTS), NO_WORKFLOW);
});

test("phaseSection is never empty, so the workflow section is never deleted", () => {
	for (const phase of ["off", "discuss", "plan", "execute"]) assert.ok(phaseSection(phase, SECTION_OPTS).length > 0);
});

test("workflowReposSection lists the edited repos, and is never empty (pi drops empty sections)", () => {
	assert.equal(workflowReposSection([]), "Repos edited in this flow: none");
	assert.equal(workflowReposSection(["/t", "/u"]), "Repos edited in this flow (the judge reviews them too):\n- /t\n- /u");
	assert.ok(!workflowReposSection(["/t"]).includes("Working folder"), "the working folder and added folders are the workspace extension's section");
});

test("execute prompt names deliver and wait_for_user", () => {
	assert.ok(EXECUTE_PHASE.includes("deliver"));
	assert.ok(EXECUTE_PHASE.includes("wait_for_user"));
	assert.ok(!EXECUTE_PHASE.includes("even when the plan says to"));
});

test("planner prompts teach Deliver and Wait steps", async () => {
	for (const text of [planPhase()]) {
		assert.ok(text.includes("Deliver:"));
		assert.ok(text.includes("Wait:"));
		assert.ok(text.includes("(after:"));
		assert.ok(text.includes("no backticks around it"));
		assert.ok(text.includes("never for a merge or publish that an earlier stage does itself"));
	}
});

test("every role carries the keep-working and parallel rule", () => {
	for (const [name, text] of Object.entries({ plan: planPhase(), execute: EXECUTE_PHASE, JUDGE, CRITIC, ARBITER, EXPLORE, ADVISOR, RUNNER })) assert.ok(text.includes(PACE), name);
	assert.ok(!COMMIT.includes(PACE));
});

test("the execute prompt forbids fixed long sleeps", () => {
	assert.ok(EXECUTE_PHASE.includes(NO_SLEEP));
});

test("the execute prompt runs tests only when the user asked", async () => {
	for (const x of ["Run no tests or suites unless the plan's Tests runs lists ones the user asked for", "after a fix only those covering the fix", "When done, call `judge`"])
		assert.ok(EXECUTE_PHASE.includes(x), x);
	assert.ok(planPhase().includes("mark each suite slower than about 2 minutes as slow"));
});

test("human checks are Verify steps, never Wait", () => {
	assert.ok(planPhase().includes("Verify:") && planPhase().includes("Wait:"));
	assert.ok(EXECUTE_PHASE.includes('kind: "verify"'));
});

test("delivery guidance in the prompts", () => {
	assert.match(planPhase(), /Deliver: <what>/);
	assert.match(planPhase(), /never contains .*git push/);
	assert.match(planPhase(), /Delivery: no merge/);
	assert.match(planPhase(), /Deliver: <what>/);
	assert.doesNotMatch(planPhase(), /\(delivery:/);
});

test("the execute prompt ticks steps as they finish", () => {
	assert.ok(EXECUTE_PHASE.includes("as soon as it is implemented"));
	assert.ok(EXECUTE_PHASE.includes("not judged"));
	assert.ok(EXECUTE_PHASE.includes("`undone`"));
	assert.match(EXECUTE_PHASE, /Tick a `Deliver:`, `Publish:`/);
	assert.doesNotMatch(EXECUTE_PHASE, /tick the finished steps/);
});

test("the execute prompt makes delivery the executor's job and never the user's", () => {
	assert.ok(!EXECUTE_PHASE.includes("Never commit, push"));
	assert.doesNotMatch(EXECUTE_PHASE, /When the judge passes, end your turn/);
	assert.match(EXECUTE_PHASE, /When the judge passes, tick any finished steps not ticked yet with `plan_check`, then commit and push and open the pull request; merge it only when the flow ends or at a `Deliver: merge` step \(unless the plan says/);
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

test("Publish and Mirror steps are in the planner and executor prompts", () => {
	assert.ok(planPhase().includes("Publish: <package>"));
	assert.ok(planPhase().includes("Mirror: <folder>|all"));
	assert.ok(!planPhase().includes("publish with `updates.bat`"));
	assert.ok(phaseSection("execute", { ...SECTION_OPTS, publish: true }).includes("publish_packages {step}"));
});

test("the publish syntax is sent only when a flow repo can publish", () => {
	assert.ok(!planPhase(false).includes("Publish: <package>"));
	assert.ok(!planPhase(false).includes("Mirror: <folder>|all"));
	assert.ok(!phaseSection("execute", SECTION_OPTS).includes("publish_packages {step}"));
	assert.ok(planPhase(false).length < planPhase(true).length);
});

test("fix messages scope the tests to what the fix touched", () => {
	assert.match(FIX_TESTS, /Run none unless the user asked for runs/);
	assert.match(FIX_TESTS, /only the test files that cover the fix/);
	assert.ok(FIX_MESSAGE.includes(FIX_TESTS));
	assert.ok(minorFixMessage("**Judge: PASS**", 2).includes(FIX_TESTS));
});

test("the major-only note for the review after a minor-fix round", () => {
	assert.match(JUDGE_MAJOR_ONLY, /only blocker and major/);
});

test("phaseSection: the plan prompt in plan, the execute prompt alone in execute", () => {
	assert.equal(phaseSection("plan", SECTION_OPTS), planPhase());
	assert.ok(planPhase().includes(PLAN_BATCH));
	assert.equal(phaseSection("execute", { publish: false }), EXECUTE_PHASE);
});

test("flow's judge and critic rules are criteria for agents' reviewers, not a copy of their prompts", () => {
	for (const [name, text] of Object.entries({ JUDGE_CRITERIA, PLAN_CRITERIA, DISCUSSION_CRITERIA })) {
		assert.ok(!text.includes("VERDICT: PASS or VERDICT: FAIL"), `${name} leaves the verdict line to agents`);
		assert.ok(!/Report findings only, one block each/.test(text), `${name} leaves the findings format to agents`);
		assert.ok(!text.includes(JUDGE_INCREMENTAL.slice(0, 40)), name);
	}
	assert.match(JUDGE_CRITERIA, /`\[plan\]`/);
	assert.match(JUDGE_CRITERIA, /do not count toward the verdict/);
	assert.match(EXECUTE_PHASE, /\[plan\] finding/);
	assert.ok(!EXECUTE_PHASE.includes("[plan-flaw]"));
});

test("merge points: the planner lists them, the executor asks request_merge, the arbiter has a decision line", () => {
	const p = planPhase();
	assert.ok(p.includes("Merge points") && p.includes("Propose stages yourself") && !p.includes("delivered in parts"));
	assert.ok(EXECUTE_PHASE.includes("request_merge"));
	assert.ok(MERGE_ARBITER.includes("DECISION: MERGE | NO_MERGE | ASK_USER"));
});
test("the discussion criteria and the discuss prompt name the critic review", () => {
	assert.ok(DISCUSSION_CRITERIA.includes("Agreed so far") && DISCUSSION_CRITERIA.includes("fix: auto"));
	assert.ok((phaseSection("discuss", SECTION_OPTS) ?? "").includes("`/flow critic`"));
});
