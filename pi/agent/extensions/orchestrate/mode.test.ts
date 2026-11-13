// node --experimental-strip-types --test mode.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS } from "./config.ts";
import { isProposalReady, modeFromEntries, onTyped, toolRefusal } from "./mode.ts";
import { PROPOSE_KICKOFF, RUN_KICKOFF, section } from "./prompts.ts";

const go = new RegExp(DEFAULTS.approvePattern, "i");

test("onTyped: the transitions", () => {
	assert.equal(onTyped("off", "go", true, go), null);
	assert.deepEqual(onTyped("discuss", "go", false, go), { mode: "propose", append: PROPOSE_KICKOFF });
	assert.equal(onTyped("discuss", "ok go", false, go)?.mode, "propose");
	assert.equal(onTyped("propose", "go", false, go), null);
	assert.deepEqual(onTyped("propose", "go", true, go), { mode: "run", append: RUN_KICKOFF });
	assert.equal(onTyped("run", "go", true, go), null);
	assert.equal(onTyped("discuss", "fix it", true, go), null);
});

test("isProposalReady", () => {
	assert.equal(isProposalReady("## Packages: x\n### a", true), true);
	assert.equal(isProposalReady("## Packages: x\n### a\nOk?", true), false);
	assert.equal(isProposalReady("### a only", true), false);
	assert.equal(isProposalReady("## Packages: x", false), false);
});

test("toolRefusal", () => {
	assert.equal(toolRefusal("off", "edit", {}), null);
	assert.ok(toolRefusal("discuss", "edit", {}));
	assert.ok(toolRefusal("discuss", "bash", { command: "git commit -m x" }));
	assert.equal(toolRefusal("discuss", "bash", { command: "git status" }), null);
	assert.match(toolRefusal("discuss", "orch_run", {}) ?? "", /\/orch off/);
	assert.ok(toolRefusal("propose", "orch_spawn", {}));
	assert.equal(toolRefusal("run", "orch_run", {}), null);
	assert.ok(toolRefusal("run", "write", {}));
	assert.equal(toolRefusal("propose", "orch_status", {}), null);
	assert.equal(toolRefusal("discuss", "ask_orchestrator", {}), null);
	for (const m of ["discuss", "propose", "run"] as const) assert.ok(toolRefusal(m, "powershell", { command: "ls" }));
	assert.equal(toolRefusal("off", "powershell", {}), null);
});

test("modeFromEntries: newest wins, bad payload is off", () => {
	const e = (mode: unknown, v: unknown = 1) => ({ type: "custom", customType: "orchestrate-mode", data: { v, mode } });
	assert.equal(modeFromEntries([]), "off");
	assert.equal(modeFromEntries([e("discuss"), { type: "message" }, e("run")]), "run");
	assert.equal(modeFromEntries([e("run"), e("nope")]), "off");
	assert.equal(modeFromEntries([e("run", 2)]), "off");
});

test("section is empty only when off", () => {
	assert.equal(section("off"), "");
	assert.match(section("discuss"), /DISCUSS/);
	assert.match(section("propose", "repos: x"), /repos: x/);
	assert.match(section("run"), /orch_run/);
});

test("orch_decide and orch_escalate are always allowed in an orchestrator mode", () => {
	for (const m of ["discuss", "propose", "run"] as const) for (const t of ["orch_decide", "orch_escalate"]) assert.equal(toolRefusal(m, t, {}), null);
});
