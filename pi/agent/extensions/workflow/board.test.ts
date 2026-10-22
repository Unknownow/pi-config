// node --experimental-strip-types --test board.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { addToRegistry, ago, type LiveInfo, liveEvents, parseLive, progressBar, readRegistry } from "./board.ts";

const live = (o: Partial<LiveInfo> = {}): LiveInfo => ({
	v: 1,
	flowId: "20261022-1402-flow-visualizer-d9cf",
	title: "Flow visualizer",
	pid: 1,
	host: "h",
	cwd: "D:/x",
	updated: "2026-10-22T10:00:00.000Z",
	phase: "execute",
	steps: [
		{ id: "S1", text: "one", done: false },
		{ id: "S2", text: "two", done: false },
	],
	judgeRound: 0,
	autopilot: false,
	runs: [],
	events: [],
	...o,
});

test("parseLive accepts a full snapshot and rejects broken ones", () => {
	const l = live({ stage: 1, stages: 2, waiting: "x", runs: [{ role: "judge", label: "r", activity: "a" }], events: [{ at: "t", text: "e" }] });
	assert.deepEqual(parseLive(JSON.stringify(l)), l);
	assert.equal(parseLive("{"), null);
	assert.equal(parseLive(JSON.stringify({ ...l, v: 2 })), null);
	const { steps: _s, ...noSteps } = l;
	assert.equal(parseLive(JSON.stringify(noSteps)), null);
	assert.equal(parseLive(JSON.stringify({ ...l, pid: "1" })), null);
	assert.equal(parseLive(JSON.stringify({ ...l, flowId: "bad id" })), null);
});

test("liveEvents reports changes in order", () => {
	const prev = live();
	const next = live({
		steps: [
			{ id: "S1", text: "one", done: true },
			{ id: "S2", text: "two", done: false },
		],
		judgeRound: 1,
		waiting: "review",
		runs: [{ role: "judge", label: "round 1", activity: "" }],
	});
	assert.deepEqual(liveEvents(prev, next), ["S1 done", "judge round 1", "waiting: review", "judge started: round 1"]);
});

test("liveEvents: first snapshot, no-op and endings", () => {
	assert.deepEqual(liveEvents(undefined, live()), ["flow started"]);
	assert.deepEqual(liveEvents(live(), live({ updated: "2026-10-22T11:00:00.000Z" })), []);
	const busy = live({ judgeRound: 1, waiting: "review", runs: [{ role: "judge", label: "round 1", activity: "" }] });
	assert.deepEqual(liveEvents(busy, live({ judgeRound: 1 })), ["wait over", "judge finished: round 1"]);
	assert.equal(liveEvents(live(), live({ phase: "test" }))[0], "phase execute → test");
});

test("progressBar", () => {
	assert.equal(progressBar(7, 10, 10), "███████░░░");
	assert.equal(progressBar(0, 0, 10), "░░░░░░░░░░");
	assert.equal(progressBar(10, 10, 10), "██████████");
});

test("ago", () => {
	assert.equal(ago(12_000), "12s");
	assert.equal(ago(300_000), "5m");
	assert.equal(ago(3 * 3_600_000), "3h");
	assert.equal(ago(2 * 86_400_000), "2d");
});

test("registry keeps newest first, dedupes, caps at 50, survives a broken file", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "board-"));
	const file = path.join(d, "sub", "board.json");
	assert.deepEqual(readRegistry(file), []);
	addToRegistry(file, "/a", new Date(1));
	addToRegistry(file, "/b", new Date(2));
	addToRegistry(file, "/a", new Date(3));
	assert.deepEqual(readRegistry(file), ["/a", "/b"]);
	for (let i = 0; i < 55; i++) addToRegistry(file, `/d${i}`, new Date(10 + i));
	const dirs = readRegistry(file);
	assert.equal(dirs.length, 50);
	assert.equal(dirs[0], "/d54");
	addToRegistry(file, "C:\\x\\y", new Date(100));
	assert.equal(readRegistry(file)[0], "C:/x/y");
	fs.writeFileSync(file, "x");
	assert.deepEqual(readRegistry(file), []);
});

// ---- stage 2: board rows

import { boardLines, boardRows, type BoardEntry, detailLines } from "./board.ts";
import type { PlanStatus } from "./plan-doc.ts";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();
const st = (title: string, o: Partial<PlanStatus> = {}): PlanStatus => ({ v: 1, flowId: "20261022-1402-x-d9cf", rev: 1, updated: iso(0), title, done: [], ...o }) as PlanStatus;
const ent = (title: string, o: Partial<BoardEntry> = {}): BoardEntry => ({ flowId: "20261022-1402-x-d9cf", dir: "/r/.git/pi/plans", status: st(title), live: null, mtime: 0, ...o });
const alive = () => true;

test("boardRows classifies and sorts", () => {
	const old = (ms: number) => st("o", { updated: iso(ms) });
	const entries: BoardEntry[] = [
		ent("finished-old", { status: st("fo", { updated: iso(2 * 86_400_000), finished: { at: iso(2 * 86_400_000), ok: true, text: "x" } }) }),
		ent("stalled-status", { status: old(86_400_000) }),
		ent("dropped", { status: old(8 * 86_400_000) }),
		ent("finished", { status: st("f", { updated: iso(3_600_000), finished: { at: iso(3_600_000), ok: true, text: "x" } }) }),
		ent("other-host", { status: old(60_000), live: live({ host: "x", updated: iso(1000), title: "oh" }) }),
		ent("dead", { status: old(60_000), live: live({ pid: 99, updated: iso(1000), title: "dead", host: "h" }) }),
		ent("stale", { status: old(600_000), live: live({ updated: iso(600_000), host: "h", title: "stale" }) }),
		ent("waiting", { live: live({ updated: iso(1000), host: "h", waiting: "w", title: "waiting" }) }),
		ent("running", { live: live({ updated: iso(1000), host: "h", title: "running" }) }),
	];
	const rows = boardRows(entries, NOW, "h", (pid) => pid !== 99);
	assert.deepEqual(rows.map((r) => r.cls), ["running", "waiting", "stalled", "stalled", "stalled", "stalled", "finished"]);
	const stalled = rows.filter((r) => r.cls === "stalled");
	for (let i = 1; i < stalled.length; i++) assert.ok(stalled[i - 1].at >= stalled[i].at);
});

test("boardRows caps at 30", () => {
	const entries = Array.from({ length: 40 }, () => ent("r", { live: live({ updated: iso(1000), host: "h" }) }));
	assert.equal(boardRows(entries, NOW, "h", alive).length, 30);
});

test("boardLines marks the selection and shows progress", () => {
	const steps = Array.from({ length: 10 }, (_, i) => ({ id: `S${i + 1}`, text: "t", done: i < 7 }));
	const rows = boardRows([ent("a", { live: live({ updated: iso(1000), host: "h", steps }) }), ent("b", { status: st("b", { updated: iso(1000) }) })], NOW, "h", alive);
	const lines = boardLines(rows, 0, 200, NOW);
	assert.ok(lines[0].startsWith("▶ "));
	assert.ok(lines[1].startsWith("  "));
	assert.ok(lines[0].includes("7/10"));
	assert.ok(lines[1].includes("no live data"));
	assert.deepEqual(boardLines([], 0, 80, NOW), ["No flows in the last 7 days."]);
});

test("detailLines lists the checklist with the current step and the last 10 events", () => {
	const events = Array.from({ length: 15 }, (_, i) => ({ at: iso(i * 1000), text: `e${i}` }));
	const l = live({
		updated: iso(1000),
		host: "h",
		steps: [
			{ id: "S1", text: "one", done: true },
			{ id: "S2", text: "two", done: false },
			{ id: "S3", text: "three", done: false },
		],
		waiting: "review",
		runs: [{ role: "judge", label: "r1", activity: "reading" }],
		events,
	});
	const [row] = boardRows([ent("a", { live: l })], NOW, "h", alive);
	const lines = detailLines(row, 200, NOW);
	assert.ok(lines.find((x) => x.includes("S2"))?.includes("▶"));
	assert.ok(!lines.find((x) => x.includes("S3"))?.includes("▶"));
	assert.ok(lines.some((x) => x.startsWith("waiting:")));
	assert.ok(lines.some((x) => x.startsWith("running:")));
	assert.equal(lines.length - lines.indexOf("recent:") - 1, 10);
});
