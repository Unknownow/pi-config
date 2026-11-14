// node --experimental-strip-types --test decide.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDecision, checkItemAnswer } from "./decide.ts";
import { close, countersOf, emptyItems, escalate, findItem, openItem, recordUserMessage, type Caps, type Item } from "./items.ts";

// the plan menu labels of the workflow (copied: orchestrate never imports workflow)
const PLAN_APPROVE = "Approve";
const PLAN_ARBITER = "Approve, arbiter solves plan flaws →";
const PLAN_FULL = "Full flow instead";
const PLAN_BACK = "Back to discussion";
const CAPS: Caps = { maxPlanRejections: 3, maxReplans: 2, maxAutoAnswers: 2, maxIdleAnswers: 3 };
let seq = 0;
function menu(key: string, options: string[], roles: Record<string, string>, f = emptyItems()): { f: ReturnType<typeof emptyItems>; item: Item } {
	const id = `f:${++seq}`;
	openItem(f, { sub: "a", type: "ask", id: `m${seq}`, text: "t", data: { id, key, kind: "menu", title: "t", options, roles } }, CAPS, 1000);
	return { f, item: findItem(f, "a", id)! };
}
const decide = (f: ReturnType<typeof emptyItems>, item: Item, a: Parameters<typeof checkDecision>[1]) => checkDecision(item, a, countersOf(f, "a"), CAPS);

test("plan-menu: approve (both labels) and discuss (both labels) are refused; other options pass", () => {
	const roles = { [PLAN_APPROVE]: "approve", [PLAN_ARBITER]: "approve", [PLAN_FULL]: "discuss", [PLAN_BACK]: "discuss" };
	const { f, item } = menu("plan-menu", [PLAN_APPROVE, PLAN_ARBITER, PLAN_FULL, PLAN_BACK, "Keep discussing"], roles);
	for (const c of [PLAN_APPROVE, PLAN_ARBITER]) {
		const d = decide(f, item, { choice: c });
		assert.equal(d.ok, false);
		assert.match(!d.ok ? d.reason : "", /orch_review_plan/);
	}
	for (const c of [PLAN_FULL, PLAN_BACK]) {
		const d = decide(f, item, { choice: c });
		assert.equal(d.ok, false);
		assert.match(!d.ok ? d.reason : "", /not available/);
	}
	assert.equal(decide(f, item, { choice: "Keep discussing", text: "tighten the steps" }).ok, true);
});

test("a choice outside the options, resume on a menu, and a missing choice are refused", () => {
	const { f, item } = menu("judge-error", ["Retry the judge", "Back to planning", "Stop"], { "Back to planning": "replan", Stop: "stop" });
	assert.equal(decide(f, item, { choice: "retry" }).ok, false);
	assert.equal(decide(f, item, {}).ok, false);
	assert.equal(decide(f, item, { resume: true }).ok, false);
	assert.deepEqual(decide(f, item, { choice: "Retry the judge" }), { ok: true, role: "other", byUser: false, outcome: "choice" });
});

test("'Wait' in stage-empty and steps-open needs text", () => {
	for (const key of ["stage-empty", "steps-open"]) {
		const { f, item } = menu(key, ["Continue", "Wait"], { Wait: "wait" });
		assert.equal(decide(f, item, { choice: "Wait" }).ok, false);
		assert.equal(decide(f, item, { choice: "Wait", text: "  " }).ok, false);
		assert.equal(decide(f, item, { choice: "Wait", text: "rebase first" }).ok, true);
		assert.equal(decide(f, item, { choice: "Continue" }).ok, true);
	}
});

test("Stop: refused without a quote and auto-escalated; accepted with a valid quote; a quote of no typed message is refused", () => {
	const { f, item } = menu("judge-cap", ["Keep fixing", "Stop"], { Stop: "stop" });
	const d = decide(f, item, { choice: "Stop" });
	assert.deepEqual(d.ok, false);
	assert.equal(!d.ok && d.escalate, true);
	escalate(item, 5, "x");
	recordUserMessage(f, "ok, please stop the flow", 6);
	const none = decide(f, item, { choice: "Stop" });
	assert.equal(none.ok, false);
	assert.match(!none.ok ? none.reason : "", /userQuote/);
	const wrong = decide(f, item, { choice: "Stop", userQuote: "something else" });
	assert.match(!wrong.ok ? wrong.reason : "", /matches no message/);
	assert.deepEqual(decide(f, item, { choice: "Stop", userQuote: "stop the flow" }), { ok: true, role: "stop", byUser: true, outcome: "choice" });
});

test("replan: a replan over the cap is allowed without a quote (the orchestrator steps back instead)", () => {
	const f = emptyItems();
	const opts = ["Back to planning", "Keep going"];
	const roles = { "Back to planning": "replan" };
	for (const key of ["judge-error", "executor-error"]) {
		const { item } = menu(key, opts, roles, f);
		const d = decide(f, item, { choice: "Back to planning" });
		assert.equal(d.ok && d.outcome, "replan");
		close(f, "a", item.ref, { how: "answered", outcome: "replan" });
		close(f, "a", item.ref, { how: "answered" });
	}
	assert.equal(countersOf(f, "a").replans, 2);
	const { item } = menu("plan-flaw", opts, roles, f);
	assert.equal(item.state, "open");
	const d = decide(f, item, { choice: "Back to planning" });
	assert.equal(d.ok && d.outcome, "replan");
});

test("waits: a resume without a quote is refused, with a valid one accepted; a choice on a wait is refused", () => {
	const f = emptyItems();
	const id = "f:wait";
	openItem(f, { sub: "a", type: "ask", id: "m", text: "t", data: { id, key: "wait", kind: "wait", title: "t", wait: { reason: "publish", manual: true } } }, CAPS, 1000);
	const item = findItem(f, "a", id)!;
	assert.equal(item.state, "escalated"); // escalated at once
	assert.equal(decide(f, item, { resume: true }).ok, false);
	assert.equal(decide(f, item, { choice: "x", userQuote: "q" }).ok, false);
	recordUserMessage(f, "published it, continue", 2000);
	assert.deepEqual(decide(f, item, { resume: true, userQuote: "continue" }), { ok: true, byUser: true, outcome: "choice" });
});

test("an escalated item's answer needs a valid quote for every tool kind", () => {
	const f = emptyItems();
	const kinds: Array<[string, Record<string, unknown>]> = [
		["question", {}],
		["idle", {}],
		["plan-review", { n: 3 }],
		["accept-request", { tree: "abc", repo: "" }],
	];
	for (const [type, data] of kinds) {
		const m = { sub: "a", type, id: `m-${type}`, text: type, data };
		openItem(f, m, CAPS, 1);
	}
	for (const item of f.items) {
		escalate(item, 5, "x");
		assert.match(checkItemAnswer(item, undefined) ?? "", /escalated to the user/);
		assert.match(checkItemAnswer(item, "nope") ?? "", /matches no message/);
	}
	recordUserMessage(f, "answer from the user", 6);
	for (const item of f.items) assert.equal(checkItemAnswer(item, "from the user"), null);
});

test("stale, answered and unknown items are refused", () => {
	assert.match(checkItemAnswer(undefined, undefined) ?? "", /unknown/);
	const { f, item } = menu("run-judge", ["Run the judge", "Skip"], {});
	close(f, "a", item.ref, { how: "answered", outcome: "choice" });
	assert.match(checkItemAnswer(item, undefined) ?? "", /already answered/);
	const b = menu("run-judge", ["Run the judge", "Skip"], {});
	close(b.f, "a", b.item.ref, { how: "stale" });
	assert.match(checkItemAnswer(b.item, undefined) ?? "", /stale/);
	assert.equal(decide(b.f, b.item, { choice: "Skip" }).ok, false);
});

test("orch_decide is for menus and waits only", () => {
	const f = emptyItems();
	openItem(f, { sub: "a", type: "question", id: "q1", text: "?" }, CAPS, 1);
	const d = decide(f, findItem(f, "a", "q1")!, { choice: "x" });
	assert.equal(d.ok, false);
	assert.match(!d.ok ? d.reason : "", /orch_send/);
});
