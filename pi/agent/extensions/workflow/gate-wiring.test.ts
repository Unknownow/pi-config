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
	const dispatch = source.indexOf('state.phase === "discuss") await reviewDiscussion', a);
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
	assert.match(source.slice(a, a + 300), /hasDisputes: wasFixing && planDisputes(text) !== undefined/);
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
