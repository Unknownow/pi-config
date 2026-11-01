// node --test plan-tools.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { refilterPlanTools } from "./plan-tools.ts";
import { planToolRefused } from "./readonly-tools.ts";

function fakePi(initial: string[]) {
	const pi = {
		active: [...initial],
		calls: 0,
		getActiveTools: () => [...pi.active],
		setActiveTools: (t: string[]) => {
			pi.calls++;
			pi.active = [...t];
		},
	};
	return pi;
}

const allowed = [/^(read|bash)$/];
const refused = (name: string) => planToolRefused(name, allowed, ["edit"]) !== null;

test("a tool registered after the phase started is filtered out, once", () => {
	const pi = fakePi(["read", "bash"]);
	const before = ["read", "bash", "edit"];
	pi.active = ["read", "bash"];
	pi.active.push("mcp__knowledge__propose_entry");
	assert.equal(refilterPlanTools(pi, before, refused), true);
	assert.deepEqual(pi.active, ["read", "bash"]);
	assert.ok(before.includes("mcp__knowledge__propose_entry"));
	assert.equal(refilterPlanTools(pi, before, refused), false);
	assert.equal(pi.calls, 1);
});

test("restoring brings the late tool back", () => {
	const pi = fakePi(["read", "bash", "late"]);
	const before = ["read", "bash"];
	refilterPlanTools(pi, before, refused);
	assert.deepEqual(before, ["read", "bash", "late"]);
	pi.setActiveTools([...before]);
	assert.ok(pi.active.includes("late"));
});

test("no change, no call", () => {
	const pi = fakePi(["read", "bash"]);
	assert.equal(refilterPlanTools(pi, ["read", "bash"], refused), false);
	assert.equal(pi.calls, 0);
});

import { hiddenInPhase, syncFlowOnlyTools, KEPT_TOOLS } from "./plan-tools.ts";

test("phases never hide explore, advisor or test_run; the hook refuses test_run while planning", () => {
	const planRefused = (n: string) => planToolRefused(n, [/^(read|bash|explore|advisor|judge)$/], ["edit", "write"]) !== null;
	for (const phase of ["off", "discuss", "plan", "execute"] as const) {
		for (const t of KEPT_TOOLS) assert.equal(hiddenInPhase(phase, t, planRefused), false, `${phase} ${t}`);
	}
	assert.equal(hiddenInPhase("plan", "edit", planRefused), true);
	assert.equal(hiddenInPhase("plan", "git_task", planRefused), true);
	assert.equal(hiddenInPhase("execute", "edit", planRefused), false);
	assert.equal(hiddenInPhase("off", "plan_check", planRefused), true);
	assert.equal(hiddenInPhase("off", "judge", planRefused), false);
	assert.equal(hiddenInPhase("off", "git_task", planRefused), false);
	// The tool_call hook still refuses test_run in discuss and plan.
	assert.notEqual(planToolRefused("test_run", [/^(read|bash|explore|advisor|judge)$/], ["edit", "write"]), null);
});

test("flow-only tools leave the active set in normal mode and return with a flow", () => {
	const pi = { active: ["read", "plan_check", "deliver", "judge"], getActiveTools: () => [...pi.active], setActiveTools: (t: string[]) => { pi.active = [...t]; }, getAllTools: () => ["read", "plan_check", "deliver", "judge"].map((name) => ({ name })) };
	assert.equal(syncFlowOnlyTools(pi, "off"), true);
	assert.deepEqual(pi.active, ["read", "judge"]);
	assert.equal(syncFlowOnlyTools(pi, "off"), false);
	assert.equal(syncFlowOnlyTools(pi, "execute"), true);
	assert.deepEqual(pi.active, ["read", "judge", "plan_check", "deliver"]);
	assert.equal(syncFlowOnlyTools(pi, "plan"), false);
});
