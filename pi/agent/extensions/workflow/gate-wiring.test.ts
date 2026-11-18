// node --experimental-strip-types --test gate-wiring.test.ts
// Source scan of index.ts and flow/*.ts: the judge gates go through the pure helpers in gates.ts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

const flowDir = new URL("./flow/", import.meta.url);
const files = [
	fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8"),
	...fs
		.readdirSync(flowDir)
		.filter((f) => f.endsWith(".ts"))
		.sort()
		.map((f) => fs.readFileSync(new URL(f, flowDir), "utf8")),
];
const source = files.join("\n");

/** The text of a function from its header to the closing brace at the header's indent, in whichever file holds it. */
function body(header: string): string {
	const file = files.find((f) => f.includes(header));
	assert.ok(file, `${header} exists`);
	const a = file.indexOf(header);
	const indent = /^[ \t]*/.exec(file.slice(file.lastIndexOf("\n", a) + 1))![0];
	const b = file.indexOf(`\n${indent}}\n`, a);
	assert.ok(b > a, `${header} has a closing brace at its indent`);
	return file.slice(a, b);
}

test("runPlanGate passes the gate's signal to agents' runCritic and releases the Esc hook in a finally", () => {
	const fn = body("async function runPlanGate(");
	assert.match(fn, /runCritic\(\{[\s\S]*planCriticRequest\([\s\S]*signal: run\.controller\.signal/);
	assert.match(fn, /onTerminalInput\(/);
	const fin = fn.indexOf("} finally {");
	assert.ok(fin > 0);
	assert.ok(fn.indexOf("run.offEsc?.()", fin) > fin, "offEsc is called in the finally");
	assert.ok(fn.indexOf("fl.gateRun = undefined", fin) > fin);
});

test("an aborted run counts no round: the abort path returns before the round is counted", () => {
	const fn = body("async function runPlanGate(");
	assert.ok(fn.indexOf("if (run.reason)") > 0);
	assert.ok(fn.indexOf("if (run.reason)") < fn.indexOf("const rounds ="));
});

test("the local idle notice waits while a gate runs", () => {
	assert.match(source, /if \(fl\.gateRun \|\| fl\.notify\.notifiedSinceStart/);
});

test("K4 carries judging", () => {
	assert.match(source, /\.\.\.\(fl\.gateRun \? \{ judging: fl\.gateRun\.kind \} : \{\}\)/);
});

/** The text of the `/flow` command, from its registration to the end of the file that holds it (the last command there). */
function flowCommand(): string {
	const header = 'registerCommand("flow", {';
	const file = files.find((f) => f.includes(header));
	assert.ok(file, "/flow is registered");
	const text = file.slice(file.indexOf(header));
	assert.equal(text.indexOf("registerCommand(", 1), -1, "/flow is the last command in its file");
	return text;
}

test("the critic command handles cancel before the phase dispatch, reviews the plan in plan and points to the judge tool in execute", () => {
	const cmd = flowCommand();
	const a = cmd.indexOf('case "critic":');
	const cancel = cmd.indexOf('rest[0]?.toLowerCase() === "cancel"', a);
	const dispatch = cmd.indexOf('await runDiscussionGate(fl, ctx, "full", false)', a);
	assert.ok(a > 0 && cancel > a && cancel < dispatch);
	assert.match(cmd.slice(dispatch, dispatch + 400), /fl\.state\.phase === "plan"\) criticPlanNow\(fl, ctx\)[\s\S]*use the judge tool/);
	assert.equal(source.indexOf('case "judge":'), -1);
});

test("the plan branch decides with planGateDecide before offerPlan", () => {
	const a = source.indexOf("planGateDecide({ mode: fl.cfg.autoJudgePlan");
	assert.ok(a > 0);
	assert.ok(source.indexOf("offerPlan(fl, ctx, blocked", a) > a);
	assert.ok(source.indexOf("void runPlanGate(fl, ctx, emitted", a) > a);
});

test("the plan branch passes hasDisputes built from planDisputes", () => {
	const a = source.indexOf("planGateDecide({ mode: fl.cfg.autoJudgePlan");
	assert.ok(source.slice(a, a + 500).includes("hasDisputes: wasFixing && planDisputes(text) !== undefined"));
});

test("entering plan resets the gate", () => {
	assert.match(source, /planGateReset\(fl\.state\.planGate, "enter-plan"\)/);
});

test("setPhase aborts a running gate when the phase changes", () => {
	assert.ok(body("async function setPhase(").includes('abortGate(fl, "phase")'));
});

test("the input handler queues a go and cancels on other text while the plan judge runs", () => {
	const a = source.indexOf("fl.gateRun?.kind === \"plan\" || fl.planFixing");
	assert.ok(a > 0);
	const seg = source.slice(a, a + 900);
	assert.match(seg, /fl.planApproveQueued = true/);
	assert.match(seg, /abortGate\(fl, "message"\)/);
});

test("the three discuss-to-plan paths call startDiscussionGate", () => {
	assert.equal(source.split("startDiscussionGate(fl, ctx)").length - 1, 3);
});

test("runDiscussionGate passes the abort signal and clears Esc in a finally", () => {
	const b = body("async function runDiscussionGate(");
	assert.ok(b.includes("signal: run.controller.signal"));
	assert.match(b, /finally \{[\s\S]*run\.offEsc\?\.\(\)/);
});

test("the discuss agent_end branch uses discussionGateAfterFixReply", () => {
	const i = source.indexOf("discussionGateAfterFixReply({");
	assert.ok(i > 0 && source.indexOf('fl.state.phase === "discuss" && fl.state.discussionReview?.status === "awaiting-fix"') > 0);
});

test("/flow plan force moves to plan with the matching findings and never starts the gate", () => {
	const a = source.indexOf('rest[0]?.toLowerCase() === "force"');
	assert.ok(a > 0);
	const m = source.indexOf("moveToPlan(", a);
	const b = source.slice(a, source.indexOf("return;", m));
	assert.ok(b.includes("moveToPlan(fl, ctx, forcedOpenFindings("));
	assert.ok(!b.includes("startDiscussionGate("));
	assert.ok(fs.readFileSync(new URL("./commands.ts", import.meta.url), "utf8").includes('plan: [{ value: "force"'));
});
