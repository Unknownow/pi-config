// node --experimental-strip-types --test gate-wiring.test.ts
// Source scan of index.ts: the judge gates go through the pure helpers in gates.ts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** The text of a function from its header to the next function of the same indent. */
function body(header: string): string {
	const a = source.indexOf(header);
	assert.ok(a >= 0, `${header} exists`);
	const b = source.indexOf("\n\t}\n", a);
	return source.slice(a, b);
}

test("runPlanGate passes the gate's signal to runRole and releases the Esc hook in a finally", () => {
	const fn = body("async function runPlanGate(");
	assert.match(fn, /runRole\("judge", "plan review"[\s\S]*signal: run\.controller\.signal/);
	assert.match(fn, /onTerminalInput\(/);
	const fin = fn.indexOf("} finally {");
	assert.ok(fin > 0);
	assert.ok(fn.indexOf("run.offEsc?.()", fin) > fin, "offEsc is called in the finally");
	assert.ok(fn.indexOf("gateRun = undefined", fin) > fin);
});

test("an aborted run counts no round: the abort path returns before the round is counted", () => {
	const fn = body("async function runPlanGate(");
	assert.ok(fn.indexOf("if (run.reason)") > 0);
	assert.ok(fn.indexOf("if (run.reason)") < fn.indexOf("const rounds ="));
});

test("idleDue gets judging, and the local notice waits while a gate runs", () => {
	assert.match(source, /idleDue\(\{[^}]*judging: !!gateRun/);
	assert.match(source, /if \(gateRun \|\| notifiedSinceStart/);
});

test("K4 carries judging", () => {
	assert.match(source, /\.\.\.\(gateRun \? \{ judging: gateRun\.kind \} : \{\}\)/);
});

test("the judge command handles cancel before the phase dispatch and judges the plan in plan", () => {
	const a = source.indexOf('case "judge":');
	const cancel = source.indexOf('rest[0]?.toLowerCase() === "cancel"', a);
	const dispatch = source.indexOf('state.phase === "discuss") await runDiscussionGate', a);
	assert.ok(a > 0 && cancel > a && cancel < dispatch);
	assert.match(source.slice(dispatch, dispatch + 300), /state\.phase === "plan"\) judgePlanNow\(ctx\)/);
});

test("the plan branch decides with planGateDecide before offerPlan", () => {
	const a = source.indexOf("planGateDecide({ mode: cfg.autoJudgePlan");
	assert.ok(a > 0);
	assert.ok(source.indexOf("offerPlan(ctx, text, blocked", a) > a);
	assert.ok(source.indexOf("void runPlanGate(ctx, emitted", a) > a);
});

test("the plan branch passes hasDisputes built from planDisputes", () => {
	const a = source.indexOf("planGateDecide({ mode: cfg.autoJudgePlan");
	assert.ok(source.slice(a, a + 500).includes("hasDisputes: wasFixing && planDisputes(text) !== undefined"));
});

test("the orchestrator's rejection resets the plan gate before the revise message", () => {
	const a = source.indexOf('planGateReset(state.planGate, "rejected")');
	assert.ok(a > 0);
	assert.ok(source.indexOf('customType: "workflow-plan-review"', a) > a);
});

test("entering plan resets the gate; start-plan sets the brief as the spec", () => {
	assert.match(source, /planGateReset\(state\.planGate, "enter-plan"\)/);
	assert.match(source, /state\.planSpec = \{ kind: "brief", text: req\.brief \}/);
});

test("setPhase aborts a running gate when the phase changes", () => {
	const a = source.indexOf("async function setPhase(");
	assert.ok(source.indexOf('abortGate("phase")', a) > a);
});

test("the input handler queues a go and cancels on other text while the plan judge runs", () => {
	const a = source.indexOf("gateRun?.kind === \"plan\" || planFixing");
	assert.ok(a > 0);
	const seg = source.slice(a, a + 900);
	assert.match(seg, /planApproveQueued = true/);
	assert.match(seg, /abortGate\("message"\)/);
});

test("the three discuss-to-plan paths call startDiscussionGate", () => {
	assert.equal(source.split("startDiscussionGate(ctx)").length - 1, 3);
});

test("runDiscussionGate passes the abort signal and clears Esc in a finally", () => {
	const b = body("async function runDiscussionGate(");
	assert.ok(b.includes("signal: run.controller.signal"));
	assert.match(b, /finally \{[\s\S]*run\.offEsc\?\.\(\)/);
});

test("the discuss agent_end branch uses discussionGateAfterFixReply", () => {
	const i = source.indexOf("discussionGateAfterFixReply({");
	assert.ok(i > 0 && source.indexOf('state.phase === "discuss" && state.discussionReview?.status === "awaiting-fix"') > 0);
});

test("/flow plan force moves to plan with the matching findings and never starts the gate", () => {
	const a = source.indexOf('rest[0]?.toLowerCase() === "force"');
	assert.ok(a > 0);
	const m = source.indexOf("moveToPlan(", a);
	const b = source.slice(a, source.indexOf("return;", m));
	assert.ok(b.includes("moveToPlan(ctx, forcedOpenFindings("));
	assert.ok(!b.includes("startDiscussionGate("));
	assert.ok(source.includes('{ value: "plan force"'));
});

// K16: relay and workflow never own a session together.
test("setPhase has exactly 18 call sites (a new one must decide whether it can start from off)", () => {
	const calls = [...source.matchAll(/setPhase\(ctx,/g)];
	assert.equal(calls.length, 18);
});

test("the call sites that can start a flow from off check setPhase's result", () => {
	const checked = (header: string, call: RegExp) => assert.match(body(header), call, header);
	checked("async function startQuick(", /if \(!\(await setPhase\(ctx, "plan", "quick"\)\)\) return;/);
	checked("async function resumeFlow(", /if \(!\(await setPhase\(ctx, "execute"\)\)\) return;/);
	assert.match(source, /if \(start === "off" \|\| !\(await setPhase\(ctx, start\)\)\) updateStatus\(ctx\);/);
	assert.match(source, /if \(!\(await setPhase\(ctx, "plan"\)\)\) \{\s*state\.extraPlanTools = undefined;\s*return \{ error: "workflow:start-plan: relay is active in this session" \};/);
	assert.match(source, /if \(!\(await setPhase\(ctx, sub\.toLowerCase\(\) as Phase\)\)\) return;/);
});

test("resumeFlow asks relayOwns before it touches git", () => {
	const fn = body("async function resumeFlow(");
	const owns = fn.indexOf("relayOwns(");
	assert.ok(owns > 0);
	for (const git of ["gitRoot(", "planChain", '"switch"', "gitEnv("]) {
		const at = fn.indexOf(git);
		if (at >= 0) assert.ok(owns < at, `relayOwns( comes before ${git}`);
	}
});

test("setPhase refuses only off to a flow phase while relay owns the session", () => {
	const fn = body("async function setPhase(");
	assert.match(fn, /if \(state\.phase === "off" && phase !== "off" && \(await relayOwns\(\)\)\) \{\s*ctx\.ui\.notify\(RELAY_ACTIVE, "warning"\);\s*return false;/);
	assert.match(source, /const RELAY_ACTIVE = "workflow: relay is active in this session; \/relay off first";/);
});
