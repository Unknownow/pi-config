// node --test waits.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanCheck, waitCheckProblem, autopilotAmendment, autopilotReply, checkTitle, checkVerdict, humanChecks, parseVerifyStep, parseWaitStep, pollDecision, resumePrefix, verifyAmendment, waitAmendment } from "./waits.ts";

const CHECK = "git ls-remote --exit-code --tags origin com.iecgames.core/v0.17.0";
const plan = `## 5. Steps\n\n**S6.** Edit the code\n**S7.** Wait: publish core 0.17.0 (check: ${CHECK})\n- **S8.** Wait: open the Editor\n**S9.** Do it and write a long line that is more than one hundred and twenty characters long so the checklist text would cut it short, see?\n`;

test("parseWaitStep reads the reason and the check", () => {
	assert.deepEqual(parseWaitStep(plan, "S7"), { reason: "publish core 0.17.0", check: CHECK });
	assert.deepEqual(parseWaitStep(plan, "S8"), { reason: "open the Editor" });
});

test("parseWaitStep is null for other steps and unknown IDs", () => {
	assert.equal(parseWaitStep(plan, "S6"), null);
	assert.equal(parseWaitStep(plan, "S99"), null);
});

test("parseWaitStep keeps a check beyond 120 characters", () => {
	const long = `x`.repeat(130);
	const p = `**S1.** Wait: something (check: git ls-remote --exit-code --tags origin ${long})`;
	assert.equal(parseWaitStep(p, "S1")?.check, `git ls-remote --exit-code --tags origin ${long}`);
});

test("waitAmendment text", () => {
	assert.equal(waitAmendment(3, { reason: "publish core", step: "S7", check: "git ls-remote x" }), "## Amendment 3 (executor: wait)\npublish core (step S7) (check: git ls-remote x)");
	assert.equal(waitAmendment(1, { reason: "open Editor" }), "## Amendment 1 (executor: wait)\nopen Editor");
});

test("resumePrefix", () => {
	assert.equal(resumePrefix("x", "passed"), 'The wait for "x" is over (check passed).');
	assert.equal(resumePrefix("x", "forced"), 'The wait for "x" is over (you continued without the check passing).');
	assert.equal(resumePrefix("x", "plain"), 'The wait for "x" is over.');
});

test("pollDecision", () => {
	const base = { waiting: true, hasCheck: true, idle: true, elapsedMs: 0, maxMs: 100 };
	assert.equal(pollDecision(base), "run");
	assert.equal(pollDecision({ ...base, idle: false }), "hold");
	assert.equal(pollDecision({ ...base, elapsedMs: 100 }), "stop");
	assert.equal(pollDecision({ ...base, elapsedMs: 100, idle: false }), "stop");
	assert.equal(pollDecision({ ...base, hasCheck: false }), "stop");
	assert.equal(pollDecision({ ...base, waiting: false }), "stop");
});

test("checkVerdict pass, fail and timeout", () => {
	assert.deepEqual(checkVerdict({ code: 0, stderr: "", killed: false }, 30000), { status: "pass" });
	assert.deepEqual(checkVerdict({ code: 1, stderr: "", killed: false }, 30000), { status: "fail", detail: "exit 1" });
	assert.deepEqual(checkVerdict({ code: 1, stderr: "a\nlast line\n\n", killed: false }, 30000), { status: "fail", detail: "exit 1: last line" });
	assert.deepEqual(checkVerdict({ code: 1, stderr: "", killed: true }, 30000), { status: "fail", detail: "timed out after 30 s" });
});

test("checkVerdict broken", () => {
	assert.deepEqual(checkVerdict({ error: "no usable bash: x" }, 30000), { status: "broken", detail: "no usable bash: x" });
	assert.deepEqual(checkVerdict({ code: 127, stderr: "bash: gh: command not found", killed: false }, 30000), { status: "broken", detail: "exit 127: bash: gh: command not found" });
	assert.equal(checkVerdict({ code: 126, stderr: "", killed: false }, 30000).status, "broken");
	assert.equal(checkVerdict({ code: 1, stderr: "foo: command not found", killed: false }, 30000).status, "broken");
});

test("checkVerdict keeps \"No such file\" as not yet", () => {
	assert.equal(checkVerdict({ code: 2, stderr: "ls: cannot access 'x': No such file or directory", killed: false }, 30000).status, "fail");
});

test("checkVerdict cuts the stderr line to 200 characters", () => {
	const v = checkVerdict({ code: 1, stderr: "x".repeat(300), killed: false }, 30000);
	assert.equal((v.detail as string).slice("exit 1: ".length).length, 200);
});

test("checkTitle", () => {
	assert.ok(checkTitle({ status: "broken", detail: "d" }, "c").startsWith("Check can't run ("));
	assert.equal(checkTitle({ status: "fail", detail: "exit 1" }, "c"), "Check not passing (exit 1): c");
	assert.equal(checkTitle({ status: "fail" }, "c"), "Check not passing: c");
});

test("autopilotAmendment text", () => {
	assert.equal(autopilotAmendment(2, { reason: "R", step: "S3", kind: "approve" }), "## Amendment 2 (executor: autopilot)\nR (step S3, approve)");
	assert.equal(autopilotAmendment(2, { reason: "R", kind: "act" }), "## Amendment 2 (executor: autopilot)\nR (act)");
});

test("autopilotReply", () => {
	const a = autopilotReply("approve", "R", "gh x");
	assert.ok(a.startsWith("Autopilot is on: "));
	for (const s of ["(workflow autopilot)", "manual: true", "plan_check", "gh x"]) assert.ok(a.includes(s), s);
	const b = autopilotReply("act", "R");
	for (const s of ["AGENTS.md", "manual: true", "Never script around a confirmation"]) assert.ok(b.includes(s), s);
});

test("parseVerifyStep reads steps and look-for", () => {
	const p = "**S3.** Verify: play scene X — look for: no jitter\n- [ ] **S4.** Verify: open menu (look for: icons)\n**S5.** Verify: check it\n**S6.** Wait: publish\n";
	assert.deepEqual(parseVerifyStep(p, "S3"), { steps: "play scene X", lookFor: "no jitter" });
	assert.deepEqual(parseVerifyStep(p, "S4"), { steps: "open menu", lookFor: "icons" });
	assert.deepEqual(parseVerifyStep(p, "S5"), { steps: "check it" });
	assert.equal(parseVerifyStep(p, "S6"), null);
	assert.equal(parseVerifyStep(p, "S99"), null);
});

test("verifyAmendment format", () => {
	assert.equal(verifyAmendment(2, { steps: "tap X", lookFor: "glow", step: "S4" }), "## Amendment 2 (executor: verify)\ntap X — look for: glow (step S4)");
});

test("humanChecks lists Verify steps first and drops a duplicated step", () => {
	const p = "**S1.** Edit\n**S2.** Verify: play\n\n## Amendment 1 (executor: verify)\nlook at HUD\n\n## Amendment 2 (executor: verify)\nplay again (step S2)\n";
	const cl = [{ id: "S1", text: "Edit", done: false }, { id: "S2", text: "Verify: play", done: false, human: true as const }];
	assert.deepEqual(humanChecks(p, cl), [{ id: "S2", text: "play" }, { text: "look at HUD" }]);
});

test("cleanCheck strips wrapping backticks", () => {
	assert.equal(cleanCheck("`git ls-remote x`"), "git ls-remote x");
	assert.equal(cleanCheck("``a `b` c``"), "a `b` c");
	assert.equal(cleanCheck("  plain  "), "plain");
	for (const v of [undefined, "", "``"]) assert.equal(cleanCheck(v), undefined);
});

test("waitCheckProblem", () => {
	assert.equal(waitCheckProblem("git ls-remote --exit-code --tags origin x/v<new set version>"), "has a placeholder");
	assert.equal(waitCheckProblem("a `b`"), "uses command substitution");
	assert.equal(waitCheckProblem("echo $(x)"), "uses command substitution");
	assert.equal(waitCheckProblem("git -C D:/r ls-remote --exit-code --tags origin a/v1"), null);
	assert.equal(waitCheckProblem("git log 2>&1 | head"), null);
});

test("parseWaitStep backticked check", () => {
	assert.deepEqual(parseWaitStep("**S7.** Wait: open the Editor (check: `ls x`)", "S7"), { reason: "open the Editor", check: "ls x" });
});

test("parseWaitStep keeps a check with nested parentheses", () => {
	assert.deepEqual(parseWaitStep("**S4.** Wait: open the Editor (check: echo $(x))", "S4"), { reason: "open the Editor", check: "echo $(x)" });
});
