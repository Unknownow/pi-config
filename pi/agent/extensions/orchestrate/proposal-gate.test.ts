// node --experimental-strip-types --test proposal-gate.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODE_ENTRY } from "./mode.ts";
import { roleOnRestore, roleSwitch, roleWarnText } from "./proposal-gate.ts";

const base = { from: "off", to: "discuss", isSub: false, hasRole: true, hasPrev: false } as const;

test("roleSwitch", () => {
	assert.equal(roleSwitch(base), "apply");
	assert.equal(roleSwitch({ ...base, from: "discuss", to: "propose" }), "none");
	assert.equal(roleSwitch({ ...base, from: "run", to: "off", hasPrev: true }), "restore");
	assert.equal(roleSwitch({ ...base, from: "run", to: "off", hasPrev: false }), "none");
	assert.equal(roleSwitch({ ...base, isSub: true }), "none");
	assert.equal(roleSwitch({ ...base, workflowPhase: "plan" }), "warn");
	assert.equal(roleSwitch({ ...base, workflowPhase: "off" }), "apply");
	assert.equal(roleSwitch({ ...base, hasRole: false }), "none");
	assert.equal(roleSwitch({ ...base, from: "run", to: "off", hasPrev: true, workflowPhase: "execute" }), "warn");
});

test("roleWarnText", () => {
	assert.match(roleWarnText("on", "plan"), /was not switched/);
	const t = roleWarnText("off", "plan", { model: "a/b", thinking: "low" });
	assert.ok(t.includes("/model a/b") && t.includes("thinking low"));
	assert.ok(!roleWarnText("off", "plan").includes("/model"));
});

const entry = (mode: string, prevModel?: unknown) => ({ type: "custom", customType: MODE_ENTRY, data: { v: 1, mode, prevModel } });

test("roleOnRestore", () => {
	const P = { model: "a/b", thinking: "high" };
	assert.deepEqual(roleOnRestore([entry("off"), entry("discuss", P), entry("propose", P)]), P);
	assert.equal(roleOnRestore([entry("discuss", P), entry("off")]), undefined);
	assert.equal(roleOnRestore([entry("discuss")]), undefined);
	assert.equal(roleOnRestore([]), undefined);
});
