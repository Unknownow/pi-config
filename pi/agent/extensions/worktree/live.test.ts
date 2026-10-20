// node --experimental-strip-types --test live.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { footerText, readLive, removeLive, setInUse, writeLive, type LiveEntry } from "./live.ts";

const NOW = Date.parse("2026-10-21T10:00:00Z");
const entry = (o: Partial<LiveEntry>): LiveEntry => ({
	v: 1, pid: 1, started: "2026-10-21T09:00:00Z", updated: "2026-10-21T09:59:30Z", sessionFile: null, cwd: "D:/p/game", folders: [], set: null, busy: false, flow: null, ...o,
});

test("readLive keeps fresh live entries and deletes dead pids", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
	writeLive(dir, entry({ pid: 11 }));
	writeLive(dir, entry({ pid: 12 }));
	writeLive(dir, entry({ pid: 13, updated: "2026-10-21T09:00:00Z" }));
	fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
	const got = readLive(dir, NOW, (pid) => pid !== 12);
	assert.deepEqual(got.map((e) => e.pid), [11]);
	assert.ok(!fs.existsSync(path.join(dir, "12.json")));
	assert.ok(fs.existsSync(path.join(dir, "13.json")));
	removeLive(dir, 11);
	assert.deepEqual(readLive(dir, NOW, () => true).map((e) => e.pid), []);
	assert.deepEqual(readLive(path.join(dir, "missing"), NOW, () => true), []);
});

test("setInUse finds another session in the set by cwd or folder, not itself", () => {
	const a = entry({ pid: 5, cwd: "D:/wt/w1/game" });
	const b = entry({ pid: 6, cwd: "D:/p/game", folders: ["D:/wt/w2/docs"] });
	assert.equal(setInUse([a, b], "D:/wt/w1", 9)?.pid, 5);
	assert.equal(setInUse([a, b], "D:/wt/w2", 9)?.pid, 6);
	assert.equal(setInUse([a, b], "D:/wt/w1", 5), null);
	assert.equal(setInUse([a, b], "D:/wt/w", 9), null);
});

test("footerText", () => {
	assert.equal(footerText([entry({ pid: 1 })], 1), undefined);
	const list = [
		entry({ pid: 1 }),
		entry({ pid: 2, set: "D:/wt/w1", busy: true, flow: { phase: "execute", stage: 2, stages: 5 } }),
		entry({ pid: 3, cwd: "D:/p/game", flow: { phase: "plan" } }),
		entry({ pid: 4, set: "D:/wt/w3" }),
	];
	assert.equal(footerText([entry({ pid: 2, cwd: "D:/p/game/src", repo: "D:/p/game" })], 1), "game: idle");
	assert.equal(footerText(list, 1), "w1: working execute 2/5 · game: needs you · w3: idle");
	const many = [1, 2, 3, 4, 5, 6].map((n) => entry({ pid: n + 10, set: `D:/wt/s${n}` }));
	assert.equal(footerText(many, 1), "s1: idle · s2: idle · s3: idle · s4: idle +2");
});
