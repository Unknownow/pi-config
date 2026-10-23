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
