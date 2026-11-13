// node --experimental-strip-types --test asks.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type MenuDeps, type OpenAsk, askAnswer, askMenu, idleDue, idlePayload, nextAskId, restoreAsks, waitPayload } from "./asks.ts";

interface Harness {
	deps: MenuDeps;
	events: { channel: string; data: any }[];
	selects: string[];
	notices: string[];
	texts: string[];
	opens: (OpenAsk | undefined)[];
	/** The listener: gets each K12 payload; returns the claim answer or "no claim". */
	listener: { fn: ((d: any) => unknown | "no-claim") | undefined };
	localChoice: { value: string | undefined };
}

function harness(): Harness {
	const h = { events: [] as { channel: string; data: any }[], selects: [] as string[], notices: [] as string[], texts: [] as string[], opens: [] as (OpenAsk | undefined)[], listener: { fn: undefined as Harness["listener"]["fn"] }, localChoice: { value: "Local" as string | undefined } };
	let seq = 0;
	const deps: MenuDeps = {
		newId: () => nextAskId("f1", ++seq),
		setOpen: (o) => void h.opens.push(o),
		emit: (channel, data) => {
			h.events.push({ channel, data });
			if (channel === "workflow:ask" && h.listener.fn) {
				const r = h.listener.fn(data);
				if (r !== "no-claim") (data as { claim: (a: unknown) => void }).claim(r);
			}
		},
		select: async (title) => {
			h.selects.push(title);
			return h.localChoice.value;
		},
		notify: (t) => void h.notices.push(t),
		deliverText: (t) => void h.texts.push(t),
	};
	return { ...h, deps };
}

const req = { key: "judge-cap" as const, title: "Judge failed 5 rounds", options: ["Keep fixing", "Stop"], roles: { Stop: "stop" as const }, detail: "report" };

test("a claimed choice is returned without any local menu or notification", async () => {
	const h = harness();
	h.listener.fn = () => ({ choice: "Keep fixing" });
	assert.equal(await askMenu(h.deps, req), "Keep fixing");
	assert.deepEqual(h.selects, []);
	assert.deepEqual(h.notices, []);
	const ask = h.events.find((e) => e.channel === "workflow:ask")?.data;
	assert.equal(ask.key, "judge-cap");
	assert.equal(ask.id, "f1:1");
	assert.deepEqual(ask.roles, { Stop: "stop" });
	assert.equal(ask.detail, "report");
	assert.deepEqual(h.events.at(-1), { channel: "workflow:ask-done", data: { v: 1, id: "f1:1", how: "answered" } });
	assert.equal(h.opens[0]?.id, "f1:1");
	assert.equal(h.opens.at(-1), undefined);
});

test("a choice with text delivers the text", async () => {
	const h = harness();
	h.listener.fn = () => ({ choice: "Keep fixing", text: " fix the lint first " });
	await askMenu(h.deps, req);
	assert.deepEqual(h.texts, ["fix the lint first"]);
});

test("null, an error or no listener shows the menu locally, notifying only then", async () => {
	for (const fn of [() => null, () => ({ error: "boom" }), () => "no-claim" as const]) {
		const h = harness();
		h.listener.fn = fn;
		assert.equal(await askMenu(h.deps, req), "Local");
		assert.deepEqual(h.selects, [req.title]);
		assert.deepEqual(h.notices, [req.title]);
		assert.ok(!h.events.some((e) => e.channel === "workflow:ask-done"));
		assert.equal(h.opens.at(-1), undefined);
	}
});

test("an invalid choice is asked again with the same id", async () => {
	const h = harness();
	let n = 0;
	h.listener.fn = () => (++n === 1 ? { choice: "Nonsense" } : { choice: "Stop" });
	assert.equal(await askMenu(h.deps, req), "Stop");
	const asks = h.events.filter((e) => e.channel === "workflow:ask");
	assert.equal(asks.length, 2);
	assert.equal(asks[0].data.id, asks[1].data.id);
});

test("a listener that never gives a valid choice falls back to the local menu", async () => {
	const h = harness();
	h.listener.fn = () => ({ choice: "Nonsense" });
	assert.equal(await askMenu(h.deps, req), "Local");
});

test("localNotice runs only when shown locally; skipLocal shows no menu", async () => {
	const claimed = harness();
	claimed.listener.fn = () => ({ choice: "Stop" });
	let shown = 0;
	await askMenu(claimed.deps, { ...req, localNotice: () => void shown++ });
	assert.equal(shown, 0);
	const local = harness();
	assert.equal(await askMenu(local.deps, { ...req, localNotice: () => void shown++, skipLocal: true }), undefined);
	assert.equal(shown, 1);
	assert.deepEqual(local.selects, []);
	assert.deepEqual(local.notices, []);
});

test("askAnswer classifies menu and wait answers", () => {
	const opts = ["a", "b"];
	assert.deepEqual(askAnswer({ choice: "a" }, opts, "menu"), { kind: "choice", choice: "a" });
	assert.deepEqual(askAnswer({ choice: "b", text: "x" }, opts, "menu"), { kind: "choice", choice: "b", text: "x" });
	assert.deepEqual(askAnswer({ choice: "c" }, opts, "menu"), { kind: "invalid" });
	assert.deepEqual(askAnswer({ resume: true }, opts, "menu"), { kind: "invalid" });
	assert.deepEqual(askAnswer({ resume: true, text: "go" }, undefined, "wait"), { kind: "resume", text: "go" });
	assert.deepEqual(askAnswer({ choice: "a" }, opts, "wait"), { kind: "invalid" });
	assert.deepEqual(askAnswer(null, opts, "menu"), { kind: "local" });
	assert.deepEqual(askAnswer({ error: "x" }, opts, "wait"), { kind: "local" });
	assert.deepEqual(askAnswer("a", opts, "menu"), { kind: "invalid" });
});

test("the wait payload carries the reason, the check and the manual flag", () => {
	assert.deepEqual(waitPayload("f:2", { reason: "publish core", check: "npm view x", manual: true }, "not yet"), { v: 1, id: "f:2", key: "wait", kind: "wait", title: "Waiting: publish core", wait: { reason: "publish core", check: "npm view x", manual: true }, detail: "not yet" });
	assert.deepEqual((waitPayload("f:3", { reason: "r" }) as { wait: object }).wait, { reason: "r", manual: false });
});

test("restoreAsks: a saved menu is withdrawn, a saved wait is asked again under its id", () => {
	const open: OpenAsk = { id: "f:1", key: "plan-menu", kind: "menu", title: "t", options: ["a"] };
	assert.deepEqual(restoreAsks({ openAsk: open }), { withdraw: "f:1" });
	assert.deepEqual(restoreAsks({ waiting: { askId: "f:2", reason: "r", check: "c", manual: true } }), { resendWait: { id: "f:2", wait: { reason: "r", check: "c", manual: true } } });
	assert.deepEqual(restoreAsks({ waiting: { reason: "r" } }), {});
	assert.deepEqual(restoreAsks({}), {});
});

test("K13 is due only in plan or execute, idle and not busy", () => {
	const ok = { phase: "execute", idle: true, compacting: false, compactPending: false, pendingHandover: false };
	assert.equal(idleDue(ok), true);
	assert.equal(idleDue({ ...ok, phase: "plan" }), true);
	for (const phase of ["off", "discuss"]) assert.equal(idleDue({ ...ok, phase }), false);
	assert.equal(idleDue({ ...ok, idle: false }), false);
	assert.equal(idleDue({ ...ok, compacting: true }), false);
	assert.equal(idleDue({ ...ok, compactPending: true }), false);
	assert.equal(idleDue({ ...ok, pendingHandover: true }), false);
	assert.equal(idleDue({ ...ok, judging: true }), false);
	assert.equal(idleDue({ ...ok, phase: "plan", judging: true }), false);
	assert.equal(idleDue({ ...ok, phase: "execute", judging: true }), false);
	assert.equal(idleDue({ ...ok, judging: false }), true);
});

test("the idle payload truncates the last text", () => {
	const p = idlePayload("f1", "execute", "x".repeat(5000)) as { lastText: string; flowId: string; v: number };
	assert.equal(p.lastText.length, 4000);
	assert.equal(p.flowId, "f1");
	assert.equal(p.v, 1);
	assert.ok(!("flowId" in (idlePayload(undefined, "plan", "t") as object)));
});

test("plan-menu request: key, options and roles for blocked, unblocked, quick and planPrompt off", async () => {
	const { planMenuRequest, PLAN_APPROVE, PLAN_ARBITER, PLAN_BACK, PLAN_FULL } = await import("./asks.ts");
	const base = { blocked: false, quick: false, planFlawAsk: true, planPrompt: true };
	const open = planMenuRequest(base);
	assert.equal(open.key, "plan-menu");
	assert.deepEqual(open.options, [PLAN_APPROVE, PLAN_ARBITER, PLAN_BACK, "Keep discussing"]);
	assert.equal(open.roles[PLAN_ARBITER], "approve");
	assert.equal(open.roles[PLAN_BACK], "discuss");
	assert.equal(open.skipLocal, false);
	const blocked = planMenuRequest({ ...base, blocked: true });
	assert.equal(blocked.key, "plan-menu");
	assert.deepEqual(blocked.options, [PLAN_BACK, "Keep discussing"]);
	assert.deepEqual(planMenuRequest({ ...base, quick: true }).options, [PLAN_APPROVE, PLAN_FULL, "Keep discussing"]);
	assert.equal(planMenuRequest({ ...base, planPrompt: false }).skipLocal, true);
});

test("the plan menu is sent with its key when the plan is blocked and when planPrompt is off", async () => {
	const { planMenuRequest } = await import("./asks.ts");
	for (const o of [{ blocked: true, planPrompt: true }, { blocked: false, planPrompt: false }]) {
		const h = harness();
		h.listener.fn = () => ({ choice: "Keep discussing" });
		const r = planMenuRequest({ quick: false, planFlawAsk: false, ...o });
		assert.equal(await askMenu(h.deps, { key: r.key, title: "Plan phase", options: r.options, roles: r.roles, skipLocal: r.skipLocal }), "Keep discussing");
		assert.equal(h.events.find((e) => e.channel === "workflow:ask")?.data.key, "plan-menu");
	}
});

test("waitResumeOutcome: a failing check sends a new ask, no check or a passing one ends the wait", async () => {
	const { waitResumeOutcome, resumeContent } = await import("./asks.ts");
	assert.equal(waitResumeOutcome({}, undefined), "end");
	assert.equal(waitResumeOutcome({ check: "c" }, { status: "pass" }), "end");
	assert.equal(waitResumeOutcome({ check: "c", checkPassed: true }, undefined), "end");
	assert.equal(waitResumeOutcome({ check: "c" }, { status: "fail" }), "reask");
	assert.equal(waitResumeOutcome({ check: "c" }, { status: "broken" }), "reask");
	assert.equal(resumeContent("done.", "held.", "go"), "done.\n\nheld.\n\ngo");
	assert.equal(resumeContent("done.", undefined, undefined), "done.\n\nContinue with the open steps of the plan.");
});

test("the idle notice is suppressed while K13 handled the period or its claim is open", async () => {
	const { idleNoticeAllowed } = await import("./asks.ts");
	assert.equal(idleNoticeAllowed({ handled: false, pending: false }), true);
	assert.equal(idleNoticeAllowed({ handled: true, pending: false }), false);
	assert.equal(idleNoticeAllowed({ handled: false, pending: true }), false);
});

test("bumpAskId persists the sequence in the state; waitDonePayload needs an askId", async () => {
	const { bumpAskId, waitDonePayload } = await import("./asks.ts");
	const st: { askSeq?: number; planDoc?: { flowId: string } } = { planDoc: { flowId: "f9" } };
	assert.equal(bumpAskId(st), "f9:1");
	assert.equal(bumpAskId(st), "f9:2");
	assert.equal(st.askSeq, 2);
	assert.equal(bumpAskId({ askSeq: 4 }), "flow:5");
	assert.deepEqual(waitDonePayload({ askId: "f9:2" }), { v: 1, id: "f9:2", how: "answered" });
	assert.equal(waitDonePayload({}), undefined);
	assert.equal(waitDonePayload(undefined), undefined);
});

test("waitPayload carries waitKind and checkStatus (only with a check); restoreAsks keeps waitKind", () => {
	const p = waitPayload("f:7", { reason: "r", check: "c", waitKind: "external" }, undefined, "pending") as { wait: object };
	assert.deepEqual(p.wait, { reason: "r", check: "c", manual: false, waitKind: "external", checkStatus: "pending" });
	assert.deepEqual((waitPayload("f:8", { reason: "r" }, undefined, "pending") as { wait: object }).wait, { reason: "r", manual: false });
	assert.deepEqual(restoreAsks({ waiting: { askId: "f:2", reason: "r", check: "c", waitKind: "external" } }), { resendWait: { id: "f:2", wait: { reason: "r", check: "c", waitKind: "external" } } });
});

test("a resumed external wait is asked again with waitKind and checkStatus pending", () => {
	const saved = { askId: "f:9", reason: "r", check: "c", waitKind: "external" as const };
	const r = restoreAsks({ waiting: saved }).resendWait;
	assert.equal(r?.wait.waitKind, "external");
	assert.equal(((waitPayload(r!.id, r!.wait, undefined, "pending") as { wait: { checkStatus?: string; waitKind?: string } }).wait).checkStatus, "pending");
});
