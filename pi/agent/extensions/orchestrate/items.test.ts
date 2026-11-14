// node --experimental-strip-types --test items.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readItems, writeItems } from "./store.ts";
import {
	acceptRef, close, closeIdle, countersOf, emptyItems, ESCALATE_CEILING_MS, escalate, findItem, idleAllowed, isParkedWait, liveItems, markStale, openItem, orphanDue, planRef, quoteOk, recordUserMessage, setFingerprint, tick, waitingForUser,
	type Caps, type ItemsFile, type OpenMsg,
} from "./items.ts";

const CAPS: Caps = { maxPlanRejections: 3, maxReplans: 2, maxAutoAnswers: 2, maxIdleAnswers: 3 };
const T0 = 1_000_000;
const MIN = 60_000;
let seq = 0;
const ask = (key: string, o: Partial<OpenMsg> & { id?: string; kind?: string } = {}): OpenMsg => ({
	sub: o.sub ?? "a", type: "ask", id: `m${++seq}`, text: `title ${key}`, stage: o.stage,
	data: { id: o.id ?? `f:${++seq}`, key, kind: o.kind ?? "menu", title: `title ${key}`, options: ["Go", "Stop"], roles: { Stop: "stop" } },
});
const msg = (type: string, o: Partial<OpenMsg> = {}): OpenMsg => ({ sub: "a", type, id: `m${++seq}`, text: `${type} text`, ...o });
const planMsg = (n: number): OpenMsg => msg("plan-review", { data: { n } });
const open = (f: ItemsFile, m: OpenMsg, now = T0) => openItem(f, m, CAPS, now);
const refOf = (m: OpenMsg): string => String(m.data?.id ?? m.id);

test("openItem: one item per message kind, with its ref", () => {
	const f = emptyItems();
	const q = msg("question");
	const a = ask("judge-error");
	const w = ask("wait", { kind: "wait" });
	open(f, q);
	open(f, a);
	open(f, msg("idle"));
	open(f, planMsg(1));
	open(f, msg("accept-request", { data: { tree: "t".repeat(20), repo: "web" } }));
	const kinds = f.items.map((i) => i.kind);
	assert.deepEqual(kinds, ["question", "menu", "idle", "plan-review", "accept-request"]);
	assert.equal(findItem(f, "a", q.id)?.state, "open");
	assert.equal(findItem(f, "a", refOf(a))?.key, "judge-error");
	assert.ok(findItem(f, "a", planRef(1)));
	assert.ok(findItem(f, "a", acceptRef("web", "t".repeat(20))));
	assert.equal(open(f, a).length, 0); // a duplicate of an open item is ignored
	assert.equal(f.items.length, 5);
	assert.equal(open(f, msg("flow-ended")).length, 0);
	const act = open(f, w);
	assert.equal(act.length, 1); // a wait is escalated at once
	assert.equal(act[0].type === "escalate" && act[0].item.state, "escalated");
});

test("openItem: a new accept-request of the same sub and repo makes the old one stale; a plan review resets plan-menu", () => {
	const f = emptyItems();
	const acc = (tree: string, repo = "") => msg("accept-request", { data: { tree, repo } });
	open(f, acc("t1"));
	open(f, acc("t2", "web"));
	open(f, acc("t3"));
	assert.deepEqual(f.items.map((i) => i.state), ["stale", "open", "open"]);
	countersOf(f, "a").autoAnswers["plan-menu"] = { count: 2 };
	open(f, planMsg(1));
	assert.equal(countersOf(f, "a").autoAnswers["plan-menu"].count, 0);
	open(f, planMsg(2));
	assert.equal(findItem(f, "a", planRef(1))?.state, "stale");
});

test("tick: reminders at 60 s, 5 min and 10 min of orchestrator idle time, one overdue notice at 15 min (no escalation)", () => {
	const f = emptyItems();
	const q = msg("question");
	open(f, q);
	const it = findItem(f, "a", q.id)!;
	let now = T0;
	const step = (ms: number, idle = true) => tick(f, (now += ms), idle, ms);
	assert.deepEqual(step(30_000), []);
	assert.deepEqual(step(30_000).map((a) => a.type), ["remind"]);
	assert.equal(it.reminders, 1);
	assert.deepEqual(step(3 * MIN), []);
	assert.deepEqual(step(2 * MIN).map((a) => a.type), ["remind"]); // 5 min 60 s? idle is 6 min
	assert.equal(it.reminders, 2);
	assert.deepEqual(step(4 * MIN).map((a) => a.type), ["remind"]); // 10 min
	assert.equal(it.reminders, 3);
	assert.deepEqual(step(4 * MIN), []);
	assert.equal(it.state, "open");
	const overdue = step(MIN); // 15 min idle
	assert.deepEqual(overdue.map((a) => a.type), ["remind"]);
	assert.equal(overdue[0].type === "remind" && Boolean(overdue[0].overdue), true);
	assert.equal(it.state, "open");
	assert.deepEqual(step(20 * MIN), []); // the notice is sent once
});

test("tick: nothing counts while the orchestrator is busy; the 30 min ceiling gives the overdue notice anyway", () => {
	const f = emptyItems();
	const q = msg("question");
	open(f, q);
	const it = findItem(f, "a", q.id)!;
	assert.deepEqual(tick(f, T0 + 10 * MIN, false, 10 * MIN), []);
	assert.equal(it.idleMs, 0);
	assert.deepEqual(tick(f, T0 + 29 * MIN, false, 19 * MIN), []);
	const act = tick(f, T0 + ESCALATE_CEILING_MS, false, MIN);
	assert.deepEqual(act.map((a) => a.type), ["remind"]);
	assert.equal(it.state, "open");
});

test("tick: closing ends the counting; accept requests follow the same timing", () => {
	const f = emptyItems();
	const acc = msg("accept-request", { data: { tree: "tt", repo: "" } });
	open(f, acc);
	assert.deepEqual(tick(f, T0 + MIN, true, MIN).map((a) => a.type), ["remind"]);
	close(f, "a", acceptRef("", "tt"), { how: "answered", outcome: "accepted" });
	assert.deepEqual(tick(f, T0 + 20 * MIN, true, 19 * MIN), []);
	const q = msg("question");
	open(f, q, T0);
	assert.deepEqual(tick(f, T0 + 15 * MIN, true, 15 * MIN).map((a) => a.type), ["remind"]);
});

test("an idle item is closed by a message to its sub and by idle-end; an escalated one only by idle-end", () => {
	const f = emptyItems();
	open(f, msg("idle"));
	assert.equal(closeIdle(f, "a", false).length, 1);
	assert.equal(liveItems(f).length, 0);
	open(f, msg("idle"));
	escalate(liveItems(f)[0], T0, "x");
	assert.equal(closeIdle(f, "a", false).length, 0);
	assert.equal(closeIdle(f, "a", true).length, 1);
	assert.equal(liveItems(f).length, 0);
});

test("restart: items and counters survive a write and a read; a saved idleMs continues; an item past the ceiling gets the overdue notice on the first tick; a missing file is empty", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-items-")).replace(/\\/g, "/");
	const common = `${dir}/.git`;
	assert.deepEqual(readItems(common, "r1").file, emptyItems());
	const f = emptyItems();
	const q = msg("question");
	open(f, q);
	f.items[0].idleMs = 7 * MIN;
	countersOf(f, "a").replans = 2;
	writeItems(common, "r1", f);
	const back = readItems(common, "r1");
	assert.equal(back.corrupt, undefined);
	assert.deepEqual(back.file, JSON.parse(JSON.stringify(f)));
	assert.deepEqual(tick(back.file, T0 + 7 * MIN, true, 3 * MIN).map((a) => a.type), ["remind"]); // 7 + 3 = 10 min of saved idle time
	const old = emptyItems();
	open(old, msg("question"), T0);
	assert.deepEqual(tick(old, T0 + 40 * MIN, true, 0).map((a) => a.type), ["remind"]);
	fs.writeFileSync(`${common}/pi/orchestra/r1/items.json`, "{nope");
	const bad = readItems(common, "r1");
	assert.ok(bad.corrupt);
	assert.deepEqual(bad.file, emptyItems());
});

test("plan rejections: the 4th review is escalated; approval resets the count; the user's answer too", () => {
	const f = emptyItems();
	for (let n = 1; n <= 3; n++) {
		assert.deepEqual(open(f, planMsg(n)), []);
		close(f, "a", planRef(n), { how: "answered", outcome: "rejected" });
	}
	assert.equal(countersOf(f, "a").planRejections, 3);
	const act = open(f, planMsg(4));
	assert.equal(act.length, 1);
	close(f, "a", planRef(4), { how: "answered", byUser: true, outcome: "rejected" });
	assert.equal(countersOf(f, "a").planRejections, 0);
	open(f, planMsg(5));
	close(f, "a", planRef(5), { how: "answered", outcome: "rejected" });
	open(f, planMsg(6));
	close(f, "a", planRef(6), { how: "answered", outcome: "approved" });
	assert.equal(countersOf(f, "a").planRejections, 0);
});

test("loop keys (judge-cap): the 3rd ask in the same stage is escalated even when the fingerprint changes in between", () => {
	const f = emptyItems();
	for (let i = 0; i < 2; i++) {
		setFingerprint(f, "a", `fp${i}`);
		const m = ask("judge-cap", { stage: 1 });
		assert.deepEqual(open(f, m), []);
		close(f, "a", refOf(m), { how: "answered", outcome: "choice" });
	}
	setFingerprint(f, "a", "fp-other");
	const third = open(f, ask("judge-cap", { stage: 1 }));
	assert.equal(third.length, 1);
});

test("loop keys: a stage change resets, an approval does not; accept refusals count; an unstaged plan is per run", () => {
	const f = emptyItems();
	const loop = (key: string, stage: number | undefined) => {
		const m = ask(key, { stage });
		const act = open(f, m);
		if (!act.length) close(f, "a", refOf(m), { how: "answered", outcome: "choice" });
		return act.length;
	};
	assert.equal(loop("plan-flaw", 1), 0);
	assert.equal(loop("plan-flaw", 1), 0);
	open(f, planMsg(1));
	close(f, "a", planRef(1), { how: "answered", outcome: "approved" });
	assert.equal(loop("plan-flaw", 1), 1); // the approval did not reset it
	assert.equal(loop("plan-flaw", 2), 0); // a new stage did
	// unstaged: the cap is per run
	assert.equal(loop("merge-early", undefined), 0);
	assert.equal(loop("merge-early", undefined), 0);
	assert.equal(loop("merge-early", undefined), 1);
	// accept refusals
	const acc = (t: string) => msg("accept-request", { data: { tree: t, repo: "" }, stage: 1 });
	for (const t of ["t1", "t2"]) {
		assert.deepEqual(open(f, acc(t)), []);
		close(f, "a", acceptRef("", t), { how: "answered", outcome: "refused" });
	}
	assert.equal(open(f, acc("t3")).length, 1);
	const g = emptyItems();
	open(g, acc("ok1"));
	close(g, "a", acceptRef("", "ok1"), { how: "answered", outcome: "accepted" });
	assert.equal(countersOf(g, "a").autoAnswers.accept, undefined); // an acceptance is no loop
});

test("other keys escalate on 3 in a row; progress resets them", () => {
	const f = emptyItems();
	const one = (fp: string) => {
		setFingerprint(f, "a", fp);
		const m = ask("executor-error");
		const act = open(f, m);
		if (!act.length) close(f, "a", refOf(m), { how: "answered", outcome: "choice" });
		return act.length;
	};
	assert.equal(one("x"), 0);
	assert.equal(one("x"), 0);
	assert.equal(one("x"), 1);
	const g = emptyItems();
	const prog = (fp: string) => {
		setFingerprint(g, "a", fp);
		const m = ask("executor-error");
		const act = open(g, m);
		if (!act.length) close(g, "a", refOf(m), { how: "answered", outcome: "choice" });
		return act.length;
	};
	for (const fp of ["1", "2", "3", "4", "5"]) assert.equal(prog(fp), 0); // progress in between: never escalated
});

test("the user's answer resets the count of that cap, but not replans", () => {
	const f = emptyItems();
	for (let i = 0; i < 2; i++) {
		const m = ask("judge-cap", { stage: 1 });
		open(f, m);
		close(f, "a", refOf(m), { how: "answered", outcome: "choice" });
	}
	const m = ask("judge-cap", { stage: 1 });
	assert.equal(open(f, m).length, 1);
	countersOf(f, "a").replans = 2;
	close(f, "a", refOf(m), { how: "answered", byUser: true, outcome: "choice" });
	assert.equal(countersOf(f, "a").autoAnswers["judge-cap"].count, 0);
	assert.equal(countersOf(f, "a").replans, 2);
	assert.deepEqual(open(f, ask("judge-cap", { stage: 1 })), []);
});

test("replan answers count; a stale or withdrawn close changes no counter", () => {
	const f = emptyItems();
	const m = ask("plan-flaw", { stage: 1 });
	open(f, m);
	close(f, "a", refOf(m), { how: "answered", outcome: "replan" });
	assert.equal(countersOf(f, "a").replans, 1);
	const w = ask("executor-error");
	open(f, w);
	close(f, "a", refOf(w), { how: "withdrawn" });
	assert.equal(countersOf(f, "a").autoAnswers["executor-error"], undefined);
	assert.equal(findItem(f, "a", refOf(w))?.state, "stale");
	assert.equal(close(f, "a", refOf(w), { how: "answered" }), undefined); // already closed
});

test("idle: the 4th idle without progress is escalated; progress restarts the count", () => {
	const f = emptyItems();
	setFingerprint(f, "a", "same");
	const res: number[] = [];
	for (let i = 0; i < 4; i++) {
		const m = msg("idle");
		res.push(open(f, m).length);
		close(f, "a", m.id, { how: "answered" });
	}
	assert.deepEqual(res, [0, 0, 0, 1]);
	setFingerprint(f, "a", "moved");
	assert.equal(open(f, msg("idle")).length, 0);
	assert.equal(countersOf(f, "a").idleNoProgress, 1);
});

test("markStale: a new instance makes earlier menus and plan reviews stale, not questions or waits", () => {
	const f = emptyItems();
	countersOf(f, "a").instance = "i1";
	const q = msg("question");
	open(f, q);
	open(f, ask("run-judge"));
	open(f, planMsg(1));
	open(f, ask("wait", { kind: "wait" }));
	const stale = markStale(f, "a", "i2");
	assert.deepEqual(stale.map((i) => i.kind).sort(), ["menu", "plan-review"]);
	assert.equal(findItem(f, "a", q.id)?.state, "open");
	assert.equal(f.items.find((i) => i.kind === "wait")?.state, "escalated");
	assert.deepEqual(markStale(f, "a", "i2"), []);
	// an item opened by the new instance is kept
	open(f, ask("run-judge"));
	assert.deepEqual(markStale(f, "a", "i2"), []);
});

test("quotes: only an exact piece of a message typed after the escalation counts", () => {
	const f = emptyItems();
	const q = msg("question");
	open(f, q);
	const it = findItem(f, "a", q.id)!;
	recordUserMessage(f, "typed before", T0);
	escalate(it, T0, "x");
	assert.equal(quoteOk(it, "typed before"), false);
	recordUserMessage(f, "  yes, stop it now  ", T0 + 1);
	recordUserMessage(f, "   ", T0 + 2);
	assert.equal(it.userMsgs.length, 1);
	assert.equal(quoteOk(it, "stop it now"), true);
	assert.equal(quoteOk(it, "stop"), false); // too short a piece of a longer message
	assert.equal(quoteOk(it, "y"), false);
	assert.equal(quoteOk(it, " yes, stop it now "), true);
	assert.equal(quoteOk(it, "stop it please"), false);
	assert.equal(quoteOk(it, ""), false);
	assert.equal(quoteOk(it, undefined), false);
	assert.equal(waitingForUser(f).length, 1);
});

test("idleAllowed: no idle in awaiting-acceptance, merged or stopped, nor while a request is open", () => {
	const none = { plan: false, ask: false, question: false, accept: false };
	for (const s of ["spawned", "planning", "executing"]) assert.equal(idleAllowed(s, none), true);
	for (const s of ["awaiting-acceptance", "merged", "stopped", "planned", "spawning"]) assert.equal(idleAllowed(s, none), false);
	for (const k of ["plan", "ask", "question", "accept"] as const) assert.equal(idleAllowed("executing", { ...none, [k]: true }), false);
});

test("orphanDue (D10): same host, dead owner, older than 30 min, once per item", () => {
	const base = { ownerHost: "h", host: "h", ownerAlive: false, ageMs: 31 * MIN, alreadyNotified: false };
	assert.equal(orphanDue(base), true);
	assert.equal(orphanDue({ ...base, alreadyNotified: true }), false);
	assert.equal(orphanDue({ ...base, ownerAlive: true }), false);
	assert.equal(orphanDue({ ...base, ownerHost: "other" }), false);
	assert.equal(orphanDue({ ...base, ageMs: 29 * MIN }), false);
});

const waitAsk = (id: string, wait: Record<string, unknown>, sub = "a"): OpenMsg => ({ sub, type: "ask", id: `m${++seq}`, text: "w", data: { id, key: "wait", kind: "wait", title: "Waiting", wait: { reason: "other PR", manual: false, ...wait } } });
const EXT = { waitKind: "external", check: "gh pr list", checkStatus: "pending" };

test("an external pending wait with a check is parked: no escalation, no timers", () => {
	const f = emptyItems();
	assert.deepEqual(open(f, waitAsk("f:1", EXT)), []);
	assert.equal(f.items[0].parked, true);
	assert.equal(isParkedWait({ ...EXT, manual: true } as never), true);
	assert.deepEqual(tick(f, T0 + 31 * MIN, true, 31 * MIN), []);
	assert.equal(f.items[0].state, "open");
	assert.equal(f.items[0].idleMs, 0);
	assert.equal(liveItems(f, "a").length, 1);
	assert.equal(idleAllowed("executing", { plan: false, ask: true, question: false, accept: false }), false);
});

test("stopped, broken and passed external waits escalate with their reason", () => {
	for (const [st, re] of [["stopped", /stopped checking "gh pr list"/], ["broken", /can't run/], ["passed", /autoResume is off/]] as const) {
		const f = emptyItems();
		const acts = open(f, waitAsk("f:1", { ...EXT, checkStatus: st }));
		assert.equal(acts.length, 1);
		assert.match((acts[0] as { why: string }).why, re);
		assert.equal(f.items[0].parked, undefined);
	}
});

test("waits that are not external, pending and checked escalate as before", () => {
	for (const w of [{ check: "x", checkStatus: "pending" }, { waitKind: "external", checkStatus: "pending" }, { waitKind: "external", check: "x" }, { manual: true }]) {
		const acts = open(emptyItems(), waitAsk("f:1", w));
		assert.equal(acts.length, 1);
		assert.match((acts[0] as { why: string }).why, /always needs a person/);
	}
});

test("safety net: a new wait makes the sub's old wait stale; a menu leaves a wait live", () => {
	const f = emptyItems();
	open(f, waitAsk("f:4", {}));
	open(f, waitAsk("f:5", {}));
	assert.equal(findItem(f, "a", "f:4")?.state, "stale");
	assert.deepEqual(waitingForUser(f).map((i) => i.ref), ["f:5"]);
	open(f, ask("judge-error"));
	assert.equal(findItem(f, "a", "f:5")?.state, "escalated");
});

test("replay of run o11131503: raw waits all escalate, upgraded ones are all parked; nothing stays live", () => {
	const seqOps: [string, number][] = [["ask", 1], ["done", 1], ["ask", 2], ["ask", 3], ["done", 3], ["ask", 4], ["ask", 5], ["done", 5], ["ask", 6], ["ask", 7], ["done", 7], ["ask", 8], ["ask", 9], ["ask", 10], ["done", 10], ["ask", 11], ["ask", 12], ["done", 12], ["ask", 13], ["ask", 14], ["done", 14]];
	const play = (extra: Record<string, unknown>) => {
		const f = emptyItems();
		let esc = 0;
		for (const [op, n] of seqOps) {
			const ref = `f:${n}`;
			if (op === "ask") esc += open(f, waitAsk(ref, { manual: true, check: "gh pr list", ...extra })).filter((a) => a.type === "escalate").length;
			else close(f, "a", ref, { how: "answered" });
		}
		return { esc, live: liveItems(f).length };
	};
	assert.deepEqual(play({}), { esc: 14, live: 0 });
	assert.deepEqual(play({ waitKind: "external", checkStatus: "pending" }), { esc: 0, live: 0 });
});
