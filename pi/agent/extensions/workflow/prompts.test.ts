// node --experimental-strip-types --test prompts.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { ARBITER, COMMIT, EXECUTE_PHASE, FIX_MESSAGE, FIX_TESTS, JUDGE, JUDGE_KNOWLEDGE_ONLY, NO_SLEEP, NO_WORKFLOW, PACE, deliveryGuidance, JUDGE_MAJOR_ONLY, minorFixMessage, phaseSection, PLAN_KICKOFF, planPhase, workspaceSection } from "./prompts.ts";
import { ADVISOR, EXPLORE, RUNNER } from "../agents/prompts.ts";

const BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, run_code, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;
const PLAN_BATCH = `- Batch tool calls. Each call re-sends the whole conversation, so ten small calls at 150k context re-send 1.5M tokens. Put independent reads and commands in one call (a codemode script, run_code for read-only analysis, or one bash command joined with && or ;) and print only what you need. Don't spend a call on something you could have added to the previous one.`;

test("plan phase keeps its batch line", () => {
	assert.ok(planPhase().includes(PLAN_BATCH));
	assert.ok(planPhase("onRequest").includes(PLAN_BATCH));
});

test("execute phase keeps its batch line", () => {
	assert.ok(EXECUTE_PHASE.includes(BATCH));
});

const SECTION_OPTS = { staging: "auto" } as const;

test("discuss prompt asks for no plan; the plan prompt no longer calls the planner a discussion partner", () => {
	const d = phaseSection("discuss", SECTION_OPTS) ?? "";
	assert.ok(d.includes("## Workflow: DISCUSS phase") && d.includes("Agreed so far"));
	assert.ok(!/end the reply with a short `Plan:`|propose the plan in a short/.test(d));
	const p = phaseSection("plan", SECTION_OPTS) ?? "";
	assert.ok(p.includes("## Workflow: PLAN phase") && p.includes("Staged delivery") && !p.includes("partner in discussion"));
	assert.ok(PLAN_KICKOFF.includes("## Plan:"));
});

test("phaseSection gives the plan prompt in the plan phase", () => {
	const text = phaseSection("plan", SECTION_OPTS);
	assert.equal(text, planPhase("auto"));
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

test("workspaceSection with no folders still gives the working folder", () => {
	const text = workspaceSection("/w", [], [], []);
	assert.ok(text.startsWith("Working folder: /w"));
	assert.ok(!text.includes("Added folders"));
});

test("execute prompt names deliver and wait_for_user", () => {
	assert.ok(EXECUTE_PHASE.includes("deliver"));
	assert.ok(EXECUTE_PHASE.includes("wait_for_user"));
	assert.ok(!EXECUTE_PHASE.includes("even when the plan says to"));
});

test("planner prompts teach Deliver and Wait steps", async () => {
	for (const text of [planPhase("auto")]) {
		assert.ok(text.includes("Deliver:"));
		assert.ok(text.includes("Wait:"));
		assert.ok(text.includes("(after:"));
		assert.ok(text.includes("no backticks around it"));
		assert.ok(text.includes("never for a merge or publish that an earlier stage does itself"));
	}
});

test("every role carries the keep-working and parallel rule", () => {
	for (const [name, text] of Object.entries({ plan: planPhase(), execute: EXECUTE_PHASE, JUDGE, ARBITER, EXPLORE, ADVISOR, RUNNER, JUDGE_KNOWLEDGE_ONLY })) assert.ok(text.includes(PACE), name);
	assert.ok(!COMMIT.includes(PACE));
});

test("the execute prompt forbids fixed long sleeps", () => {
	assert.ok(EXECUTE_PHASE.includes(NO_SLEEP));
});

test("slow suites run once and rerun only when touched", async () => {
	for (const x of ["While fixing, run the narrowest check that covers the change", "Run each slow suite in full once, before your first judge call", "After a judge round, rerun a slow suite only if the fix changed files it builds or reads; otherwise cite its last passing run", "then call `judge`"])
		assert.ok(EXECUTE_PHASE.includes(x), x);
	assert.ok(planPhase().includes("Mark each suite slower than about 2 minutes as slow"));
	assert.ok(planPhase("onRequest").includes("Mark each suite slower than about 2 minutes as slow"));
	assert.ok(EXECUTE_PHASE.includes("When done, run the plan's tests as above"));
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
	assert.ok(planPhase().includes("Publish: <package>"));
	assert.ok(planPhase().includes("Mirror: <folder>|all"));
	assert.ok(!planPhase().includes("publish with `updates.bat`"));
	assert.ok(phaseSection("execute", { ...SECTION_OPTS, publish: true }).includes("publish_packages {step}"));
});

test("the publish syntax is sent only when a flow repo can publish", () => {
	assert.ok(!planPhase("auto", false).includes("Publish: <package>"));
	assert.ok(!planPhase("auto", false).includes("Mirror: <folder>|all"));
	assert.ok(!phaseSection("execute", SECTION_OPTS).includes("publish_packages {step}"));
	assert.ok(planPhase("auto", false).length < planPhase("auto", true).length);
});

test("fix messages scope the tests to what the fix touched", () => {
	assert.match(FIX_TESTS, /Test only what the fix touched/);
	assert.match(FIX_TESTS, /cite its last passing run/);
	assert.match(EXECUTE_PHASE, /never the full suite after each edit/);
	assert.ok(FIX_MESSAGE.includes(FIX_TESTS));
	assert.ok(minorFixMessage("**Judge: PASS**", 2).includes(FIX_TESTS));
});

test("the major-only note for the review after a minor-fix round", () => {
	assert.match(JUDGE_MAJOR_ONLY, /only blocker and major/);
});
