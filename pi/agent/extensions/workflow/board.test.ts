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
