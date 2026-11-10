// node --experimental-strip-types --test monitor.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, type CheckCtx, type Snapshot } from "./monitor.ts";

const T0 = 1_000_000_000;
const snap = (o: Partial<Snapshot> = {}): Snapshot => ({
	head: "h1", porcelainHash: "p1", done: 0, files: [], heartbeat: T0, phase: "execute", waiting: false, changedAt: T0,
	reported: { drift: [], overlap: [], offline: false, stalled: false }, ...o,
});
const ctx = (o: Partial<CheckCtx> = {}): CheckCtx => ({ now: T0, owns: ["src/a/**"], forbids: [], otherFiles: new Map(), cfg: { stallMinutes: 20 }, ...o });
const types = (r: ReturnType<typeof check>) => r.events.map((e) => e.type);

test("drift is reported once and again only for new files", () => {
	const r1 = check(undefined, snap({ files: ["src/a/x.ts", "docs/y.md"] }), ctx());
	assert.deepEqual(types(r1), ["drift"]);
	assert.deepEqual(r1.events[0].files, ["docs/y.md"]);
	const r2 = check(r1.next, snap({ files: ["src/a/x.ts", "docs/y.md"] }), ctx());
	assert.deepEqual(r2.events, []);
	const r3 = check(r2.next, snap({ files: ["src/a/x.ts", "docs/y.md", "lib/z.ts"] }), ctx());
	assert.deepEqual(r3.events[0].files, ["lib/z.ts"]);
	const r4 = check(r3.next, snap({ files: [] }), ctx());
	const r5 = check(r4.next, snap({ files: ["docs/y.md"] }), ctx());
	assert.deepEqual(types(r5), ["drift"]);
});

test("forbidden files drift even inside owns", () => {
	const r = check(undefined, snap({ files: ["src/a/secret/k.ts"] }), ctx({ forbids: ["src/a/secret/**"] }));
	assert.deepEqual(types(r), ["drift"]);
});

test("overlap with another sub-session, once", () => {
	const c = ctx({ otherFiles: new Map([["b", ["src/a/x.ts"]]]) });
	const r1 = check(undefined, snap({ files: ["src/a/x.ts"] }), c);
	assert.deepEqual(types(r1), ["overlap"]);
	assert.match(r1.events[0].text, /also changed by b/);
	assert.deepEqual(check(r1.next, snap({ files: ["src/a/x.ts"] }), c).events, []);
});

test("offline after 180 s, once, and again after it came back", () => {
	const r1 = check(undefined, snap(), ctx({ now: T0 + 179_000 }));
	assert.deepEqual(r1.events, []);
	const r2 = check(r1.next, snap(), ctx({ now: T0 + 181_000 }));
	assert.deepEqual(types(r2), ["offline"]);
	assert.deepEqual(check(r2.next, snap(), ctx({ now: T0 + 400_000 })).events, []);
	const back = check(r2.next, snap({ heartbeat: T0 + 400_000 }), ctx({ now: T0 + 400_000 }));
	assert.equal(back.next.reported.offline, false);
	assert.deepEqual(types(check(back.next, snap({ heartbeat: T0 + 400_000 }), ctx({ now: T0 + 700_000 }))), ["offline"]);
});

test("stalled after stallMinutes without change, not while waiting or outside execute", () => {
	const beat = (now: number) => ({ heartbeat: now });
	const first = check(undefined, snap(), ctx());
	const min = (m: number) => T0 + m * 60_000;
	assert.deepEqual(check(first.next, snap(beat(min(19))), ctx({ now: min(19) })).events, []);
	const s = check(first.next, snap(beat(min(20))), ctx({ now: min(20) }));
	assert.deepEqual(types(s), ["stalled"]);
	assert.deepEqual(check(s.next, snap(beat(min(30))), ctx({ now: min(30) })).events, []);
	assert.deepEqual(check(first.next, snap({ ...beat(min(30)), waiting: true }), ctx({ now: min(30) })).events, []);
	assert.deepEqual(check(first.next, snap({ ...beat(min(30)), phase: "plan" }), ctx({ now: min(30) })).events, []);
});

test("a change resets the stall", () => {
	const min = (m: number) => T0 + m * 60_000;
	const first = check(undefined, snap(), ctx());
	const c = check(first.next, snap({ heartbeat: min(15), head: "h2" }), ctx({ now: min(15) }));
	assert.equal(c.next.changedAt, min(15));
	assert.deepEqual(check(c.next, snap({ heartbeat: min(30), head: "h2" }), ctx({ now: min(30) })).events, []);
	assert.deepEqual(types(check(c.next, snap({ heartbeat: min(35), head: "h2" }), ctx({ now: min(35) }))), ["stalled"]);
	const d = check(first.next, snap({ heartbeat: min(19), done: 1 }), ctx({ now: min(19) }));
	assert.equal(d.next.changedAt, min(19));
});
