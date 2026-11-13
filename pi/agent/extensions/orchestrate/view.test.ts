// node --experimental-strip-types --test view.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run, Sub } from "./brief.ts";
import type { Item } from "./items.ts";
import type { Message } from "./store.ts";
import { boardLines, buildView, pendingFromItems, pendingMark, pendingOf, widgetLines, type SubInput } from "./view.ts";

const msg = (id: string, type: string, o: Partial<Message> = {}): Message => ({ v: 1, id, ts: `2026-01-01T00:00:0${id.length}Z`, type, text: `${type} ${id}`, ...o });
const sub = (id: string, o: Partial<Sub> = {}): Sub => ({ id, goal: `goal of ${id}`, criteria: ["c1"], owns: [`api:src/${id}/**`], forbids: [], dependsOn: [], decisions: [], name: `n-${id}`, state: "executing", ...o });
const run = (subs: Sub[]): Run => ({ v: 1, id: "r1", title: "T", created: "", owner: { pid: 1, host: "h", session: "s" }, state: "active", repos: [{ key: "api", top: "D:/a" }, { key: "web", top: "D:/w" }], subs });

test("pendingOf: questions, plans, accepts", () => {
	const out = [msg("q1", "question"), msg("p1", "plan-review", { data: { n: 1 } }), msg("p2", "plan-review", { data: { n: 2 } }), msg("a1", "accept-request", { data: { tree: "t1", repo: "web" } })];
	assert.deepEqual(pendingOf(out, []).map((p) => p.kind), ["question", "plan", "accept"]);
	const inb = [msg("x", "answer", { replyTo: "q1" }), msg("y", "plan-verdict", { data: { n: 1 } })];
	const left = pendingOf(out, inb);
	assert.deepEqual(left.map((p) => p.kind + p.ref), ["plan2", "acceptt1"]);
	assert.equal(pendingOf(out, [...inb, msg("z", "accept-verdict", { data: { tree: "t1", repo: "api" } })]).length, 2);
	assert.equal(pendingOf(out, [...inb, msg("z", "accept-verdict", { data: { tree: "t1", repo: "web" } })]).length, 1);
});

test("pendingOf: superseded requests and plans are not pending", () => {
	const acc = (id: string, tree: string) => msg(id, "accept-request", { data: { tree, repo: "web" } });
	assert.deepEqual(pendingOf([acc("a1", "t1"), acc("a2", "t2")], [msg("z", "accept-verdict", { data: { tree: "t2", repo: "web" } })]), []);
	assert.deepEqual(pendingOf([msg("p1", "plan-review", { data: { n: 1 } }), msg("p2", "plan-review", { data: { n: 2 } })], [msg("y", "plan-verdict", { data: { n: 2 } })]), []);
	const merged = buildView(run([sub("a", { state: "merged" })]), 1, 4, new Map([["a", { outbox: [msg("q1", "question")], inbox: [], accepted: [] }]]), 180);
	assert.deepEqual(merged.subs[0].pending, []);
});

test("buildView groups canonical files per repo", () => {
	const inputs = new Map<string, SubInput>([["a", { files: ["api:src/a/x.ts", "api:src/a/y.ts", "web:z.ts"], drift: ["web:z.ts"], outbox: [], inbox: [], accepted: [], prs: new Map([["web", "merged" as const]]) }]]);
	const v = buildView(run([sub("a", { repos: ["api", "web"] })]), 1000, 4, inputs, 180);
	const r = v.subs[0].repos;
	assert.deepEqual(r.map((x) => [x.key, x.files, x.drift, x.pr]), [["api", 2, [], undefined], ["web", 1, ["z.ts"], "merged"]]);
});

test("widgetLines", () => {
	assert.equal(widgetLines(null, "discuss", 0).length, 1);
	assert.match(widgetLines(null, "propose", 0)[0], /propose/);
	assert.deepEqual(widgetLines(null, "off", 0), []);
	const inputs = new Map<string, SubInput>([["a", { outbox: [msg("a1", "accept-request", { data: { tree: "abcdef0123", repo: "web" } })], inbox: [], accepted: [] }]]);
	const v = buildView(run([sub("a"), sub("b", { state: "planned", dependsOn: ["a"] })]), 1000, 4, inputs, 180);
	const lines = widgetLines(v, "run", 1000);
	assert.equal(lines.length, 3);
	assert.match(lines[1], /accept web abcdef0/);
	assert.match(lines[2], /\(after a\)/);
	for (const l of widgetLines(v, "run", 1000, undefined, 20)) assert.ok(l.length <= 20);
});

test("boardLines detail has goal and owns", () => {
	const v = buildView(run([sub("a")]), 1000, 4, new Map(), 180);
	const detail = boardLines(v, 0, true, 100, 1000).join("\n");
	assert.match(detail, /goal of a/);
	assert.match(detail, /api:src\/a\/\*\*/);
	assert.match(boardLines(v, 0, false, 100, 1000)[0], /│.*a: executing/);
});

test("escalated items: marker, header count and board mark", () => {
	const item = (o: Partial<Item>): Item => ({ ref: "r", sub: "a", kind: "question", postedAt: 0, state: "open", reminders: 0, idleMs: 0, userMsgs: [], summary: "s", ...o });
	const items = [item({ ref: "q1" }), item({ ref: "f:3", kind: "menu", key: "judge-cap" }), item({ ref: "f:4", kind: "wait", state: "escalated" }), item({ ref: "i1", kind: "idle" }), item({ ref: "plan-2", kind: "plan-review", n: 2 }), item({ ref: "x", state: "answered" })];
	const v = buildView(run([sub("a")]), 1000, 4, new Map([["a", { outbox: [], inbox: [], accepted: [], items }]]), 180);
	assert.deepEqual(v.subs[0].pending.map((p) => p.kind), ["question", "menu", "wait", "idle", "plan"]);
	assert.equal(v.waitingForUser, 1);
	const lines = widgetLines(v, "run", 1000, undefined, 200);
	assert.match(lines[0], /1 waiting for you/);
	assert.match(lines[1], /\? question menu judge-cap ‼ you: f:4 idle plan 2 review/);
	assert.match(boardLines(v, 0, false, 100, 1000)[0], /‼/);
	assert.equal(buildView(run([sub("a")]), 1000, 4, new Map(), 180).waitingForUser, undefined);
});

test("a parked wait is pending with its own mark and does not wait for the user", () => {
	const it: Item = { ref: "f:1", sub: "a", kind: "wait", postedAt: 0, state: "open", reminders: 0, idleMs: 0, userMsgs: [], summary: "s", waitKind: "external", checkStatus: "pending", parked: true };
	const [p] = pendingFromItems([it]);
	assert.equal(p.parked, true);
	assert.equal(pendingMark(p), "wait (resumes itself)");
	assert.equal(p.escalated, undefined);
});
