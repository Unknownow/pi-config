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

test("toolRefusal for relay runs: relay tools allowed in run, workflow-only orch tools refused", () => {
	for (const t of ["relay_status", "relay_approve", "relay_send", "relay_resume", "relay_stop", "relay_replan", "relay_deliver"]) assert.equal(toolRefusal("run", t, {}, "relay"), null, t);
	for (const t of ["relay_followup", "relay_dispatch"]) assert.ok(toolRefusal("run", t, {}, "relay"), t);
	for (const t of ["orch_spawn", "orch_send", "orch_review_plan", "orch_accept", "orch_merge"]) {
		assert.match(toolRefusal("run", t, {}, "relay") ?? "", /workflow runs/, t);
		assert.match(toolRefusal("off", t, {}, "relay") ?? "", /held PR is merged by hand/, `${t} also with the guard off`);
		assert.equal(toolRefusal("run", t, {}, "workflow"), null, `${t} stays for workflow runs`);
	}
	assert.equal(toolRefusal("run", "orch_run", {}, "relay"), null);
	assert.equal(toolRefusal("run", "orch_status", {}, "relay"), null);
	assert.ok(toolRefusal("run", "write", {}, "relay"));
	assert.ok(toolRefusal("run", "relay_stop", {}, "workflow"), "relay tools stay refused for workflow runs");
	assert.ok(toolRefusal("propose", "relay_stop", {}, "relay"));
	assert.match(toolRefusal("propose", "orch_run", {}, "relay") ?? "", /proposal judge/);
});

test("onTyped (relay): the first go proposes; a go on a ready proposal sends the relay kickoff", async () => {
	const { RELAY_RUN_KICKOFF } = await import("./prompts.ts");
	assert.deepEqual(onTyped("discuss", "go", false, go, "relay"), { mode: "propose", append: PROPOSE_KICKOFF });
	assert.deepEqual(onTyped("propose", "go", true, go, "relay"), { mode: "run", append: RELAY_RUN_KICKOFF });
	assert.ok(!/user approved/i.test(RELAY_RUN_KICKOFF), "the relay kickoff does not claim the user approved the packages");
});

test("section: relay propose and run texts", () => {
	assert.match(section("propose", undefined, "relay"), /## Authority/);
	assert.match(section("propose", undefined, "relay"), /2 to 10/);
	assert.match(section("propose", undefined, "workflow"), /2 to 4/);
	const run = section("run", undefined, "relay", ["publish"]);
	assert.match(run, /relay_approve/);
	assert.match(run, /in publish: ask the user/);
	assert.match(run, /relay_resume once/);
	assert.match(run, /relay_replan/);
	assert.match(run, /relay_deliver once/);
	assert.ok(!section("run", undefined, "relay", []).includes("ask the user in the chat"));
	assert.match(section("discuss", undefined, "relay"), /Authority/);
});
