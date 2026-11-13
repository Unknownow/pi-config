import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStartPlan, planReviewAction, acceptanceRefusal, ACCEPTANCE_NO_ANSWER, exactToolRegexes } from "./hooks.ts";

test("parseStartPlan accepts a good payload", () => {
	assert.deepEqual(parseStartPlan({ v: 1, title: "t", brief: "b", allowTools: ["x"] }), { title: "t", brief: "b", allowTools: ["x"] });
	assert.deepEqual(parseStartPlan({ v: 1, title: "t", brief: "b" }), { title: "t", brief: "b", allowTools: [] });
});

test("parseStartPlan rejects a wrong v, a missing brief, a bad allowTools", () => {
	for (const bad of [{ v: 2, title: "t", brief: "b" }, { v: 1, title: "t" }, { v: 1, title: "t", brief: "b", allowTools: "x" }, { v: 1, title: "t", brief: "b", allowTools: [1] }, null]) {
		assert.ok("error" in parseStartPlan(bad));
	}
});

test("planReviewAction", () => {
	assert.equal(planReviewAction({ approve: true }, true), "approve");
	assert.equal(planReviewAction({ approve: true }, false), "ignore");
	assert.equal(planReviewAction({ reject: "no" }, true), "reject");
	assert.equal(planReviewAction(null, true), "ignore");
	assert.equal(planReviewAction({ error: "x" }, true), "ignore");
});

test("acceptanceRefusal", () => {
	assert.equal(acceptanceRefusal({ problem: "wait" }), "wait");
	assert.equal(acceptanceRefusal({ error: "boom" }), ACCEPTANCE_NO_ANSWER);
	assert.equal(acceptanceRefusal(null), null);
});

test("exactToolRegexes matches only the exact name", () => {
	const [re] = exactToolRegexes(["ask_orchestrator"]);
	assert.ok(re.test("ask_orchestrator"));
	assert.ok(!re.test("xask_orchestrator"));
	assert.ok(!re.test("ask_orchestrator2"));
});

import { keepExtraTools, planReviewRoute } from "./hooks.ts";

test("keepExtraTools", () => {
	assert.equal(keepExtraTools("plan", "off"), false);
	assert.equal(keepExtraTools("execute", "discuss"), false);
	assert.equal(keepExtraTools("execute", "off"), false);
	assert.equal(keepExtraTools("off", "plan"), true);
	assert.equal(keepExtraTools("plan", "execute"), true);
	assert.equal(keepExtraTools("discuss", "plan"), true);
	assert.equal(keepExtraTools("execute", "plan"), true);
});

test("planReviewRoute: no claim goes to the menu, a claim to review", () => {
	assert.equal(planReviewRoute(true, false, false), "menu");
	assert.equal(planReviewRoute(true, false, true), "review");
	assert.equal(planReviewRoute(false, false, true), "menu");
	assert.equal(planReviewRoute(true, true, true), "menu");
});

test("acceptanceRefusal refuses answers outside the contract", () => {
	for (const bad of ["ok", {}, { problem: "" }, { problem: 5 }]) assert.equal(acceptanceRefusal(bad), ACCEPTANCE_NO_ANSWER);
});

import { flowEndKind, flowEndPayload, k11Payload, K11_SITES, withEndFlow } from "./hooks.ts";

test("flowEndKind: abandoned only when execute is left for discuss or off without endFlow", () => {
	assert.equal(flowEndKind({ from: "execute", to: "discuss", viaEndFlow: false }), "abandoned");
	assert.equal(flowEndKind({ from: "execute", to: "off", viaEndFlow: false }), "abandoned");
	assert.equal(flowEndKind({ from: "execute", to: "plan", viaEndFlow: false }), null);
	assert.equal(flowEndKind({ from: "execute", to: "off", viaEndFlow: true }), null);
	assert.equal(flowEndKind({ from: "execute", to: "discuss", viaEndFlow: true }), null);
	assert.equal(flowEndKind({ from: "plan", to: "off", viaEndFlow: false }), null);
	assert.equal(flowEndKind({ from: "discuss", to: "execute", viaEndFlow: false }), null);
});

test("withEndFlow emits first, marks the flag during the body and resets it", async () => {
	const flag = { on: false };
	const log: string[] = [];
	await withEndFlow(flag, "finished", (h) => log.push(`emit ${h} on=${flag.on}`), async () => {
		log.push(`body on=${flag.on}`);
		assert.equal(flowEndKind({ from: "execute", to: "execute", viaEndFlow: flag.on }), null); // quick flow: back to its start phase
	});
	assert.deepEqual(log, ["emit finished on=false", "body on=true"]);
	assert.equal(flag.on, false);
});

test("withEndFlow resets the flag when the body throws", async () => {
	const flag = { on: false };
	await assert.rejects(withEndFlow(flag, "stopped", () => {}, async () => { throw new Error("x"); }), /x/);
	assert.equal(flag.on, false);
});

test("k11Payload and K11_SITES", () => {
	assert.deepEqual(k11Payload("git-task", String.raw`C:\a\b`, null), { v: 1, kind: "merge", cwd: "C:/a/b", tree: null, ask: "pre" });
	assert.equal(K11_SITES["git-task"].ask, "pre");
	for (const s of ["merge", "protected-push", "publish"] as const) assert.equal(k11Payload(s, "/x", "t").ask, "gate");
	assert.equal(k11Payload("protected-push", "/x", "t").kind, "protected-push");
	assert.equal(k11Payload("publish", "/x", null).kind, "publish");
});

test("flowEndPayload", () => {
	assert.deepEqual(flowEndPayload("f1", "stopped"), { v: 1, flowId: "f1", how: "stopped" });
	assert.deepEqual(flowEndPayload(undefined, "abandoned"), { v: 1, how: "abandoned" });
});
