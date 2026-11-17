// node --experimental-strip-types --test lock.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { acquireLock, lockFile, normaliseResource } from "./lock.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-lock-test-"));
const fast = { pollMs: 5 };
/** Sets a file's mtime `ms` into the past. */
const age = (file: string, ms: number) => {
	const t = new Date(Date.now() - ms);
	fs.utimesSync(file, t, t);
};

test("normaliseResource: forward slashes, lowercase path on win32, no trailing slash", () => {
	assert.equal(normaliseResource("Unity:D:\\Proj\\", "win32"), "unity:d:/proj");
	assert.equal(normaliseResource("unity:/home/Proj/", "linux"), "unity:/home/Proj");
	assert.equal(lockFile("unity:D:\\P", "x", "win32"), lockFile("UNITY:d:/p/", "x", "win32"));
});

test("two independent lock instances on one dir run one after another", async () => {
	const dir = tmp();
	const order: string[] = [];
	let inside = 0;
	let max = 0;
	const job = async (name: string) => {
		const l = await acquireLock("device:A", { dir, ...fast });
		inside++;
		max = Math.max(max, inside);
		order.push(`${name}+`);
		await sleep(30);
		order.push(`${name}-`);
		inside--;
		l.release();
	};
	await Promise.all([job("a"), job("b"), job("c")]);
	assert.equal(max, 1);
	assert.equal(order.length, 6);
	assert.equal(fs.existsSync(lockFile("device:A", dir)), false, "released");
});

test("a stale lock is taken over: old mtime (heartbeat) or dead pid", async () => {
	const dir = tmp();
	const file = lockFile("device:B", dir);
	fs.writeFileSync(file, JSON.stringify({ token: "old", pid: process.pid }));
	age(file, 10 * 60_000);
	const l = await acquireLock("device:B", { dir, ...fast });
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, l.token);
	l.release();
	fs.writeFileSync(file, JSON.stringify({ token: "dead", pid: 424242 }));
	const m = await acquireLock("device:B", { dir, ...fast, isAlive: (pid) => pid !== 424242 });
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, m.token);
	m.release();
});

test("a live lock is not taken over", async () => {
	const dir = tmp();
	const first = await acquireLock("device:C", { dir, ...fast });
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 60);
	await assert.rejects(acquireLock("device:C", { dir, ...fast, signal: ac.signal }), /aborted/);
	assert.equal(JSON.parse(fs.readFileSync(first.file, "utf8")).token, first.token);
	first.release();
});

test("two concurrent takers of one stale lock end with exactly one holder", async () => {
	for (let round = 0; round < 5; round++) {
		const dir = tmp();
		const file = lockFile("device:D", dir);
		fs.writeFileSync(file, JSON.stringify({ token: "stale", pid: 1 }));
		age(file, 10 * 60_000);
		let holders = 0;
		let max = 0;
		const take = async () => {
			const l = await acquireLock("device:D", { dir, ...fast, isAlive: () => true });
			holders++;
			max = Math.max(max, holders);
			await sleep(20);
			holders--;
			l.release();
		};
		await Promise.all([take(), take(), take()]);
		assert.equal(max, 1);
		assert.equal(fs.existsSync(`${file}.takeover`), false, "the guard is removed");
	}
});

test("a stale takeover guard does not block forever", async () => {
	const dir = tmp();
	const file = lockFile("device:E", dir);
	fs.writeFileSync(file, JSON.stringify({ token: "stale", pid: 1 }));
	age(file, 10 * 60_000);
	fs.writeFileSync(`${file}.takeover`, "1");
	age(`${file}.takeover`, 60_000);
	const l = await acquireLock("device:E", { dir, ...fast, isAlive: () => true });
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, l.token);
	l.release();
});

test("an owner whose lock was taken over neither overwrites nor deletes the new owner's file", async () => {
	const dir = tmp();
	const old = await acquireLock("device:F", { dir, ...fast, heartbeatMs: 10 });
	// The old owner looks stale (its mtime is backdated); a new owner takes over.
	age(old.file, 10 * 60_000);
	const fresh = await acquireLock("device:F", { dir, ...fast });
	await sleep(50); // several heartbeats of the old owner
	assert.equal(JSON.parse(fs.readFileSync(old.file, "utf8")).token, fresh.token, "the heartbeat did not write over the new owner");
	assert.equal(old.lost, true, "the old owner learnt it lost the lock");
	assert.equal(old.signal.aborted, true);
	old.release();
	assert.equal(JSON.parse(fs.readFileSync(old.file, "utf8")).token, fresh.token, "release did not delete the new owner's file");
	fresh.release();
	assert.equal(fs.existsSync(fresh.file), false);
});

test("the heartbeat refreshes the owner's file by its mtime only; the content is written once", async () => {
	const dir = tmp();
	const l = await acquireLock("device:G", { dir, ...fast, heartbeatMs: 10 });
	const text = fs.readFileSync(l.file, "utf8");
	age(l.file, 60_000);
	const before = fs.statSync(l.file).mtimeMs;
	await sleep(60);
	assert.ok(fs.statSync(l.file).mtimeMs > before, "mtime refreshed");
	assert.equal(fs.readFileSync(l.file, "utf8"), text, "content unchanged");
	assert.equal(l.lost, false);
	l.release();
	assert.equal(fs.existsSync(l.file), false);
});

test("race 1: a stale guard is not deleted when another taker replaced it between the staleness check and the removal", async () => {
	const dir = tmp();
	const file = lockFile("device:H", dir);
	const guard = `${file}.takeover`;
	fs.writeFileSync(file, JSON.stringify({ token: "stale", pid: 1 }));
	age(file, 10 * 60_000);
	fs.writeFileSync(guard, "crashed-taker");
	age(guard, 60_000);
	let fired = 0;
	const ac = new AbortController();
	const waiting = acquireLock("device:H", {
		dir,
		...fast,
		isAlive: () => true,
		signal: ac.signal,
		testHooks: {
			// another process removes the stale guard and takes a fresh one of its own, right after this one judged it stale
			staleGuard: (g) => {
				if (fired++) return;
				fs.rmSync(g);
				fs.writeFileSync(g, "other-taker");
			},
		},
	});
	await sleep(80);
	ac.abort();
	await assert.rejects(waiting, /aborted/);
	assert.equal(fired, 1);
	assert.equal(fs.readFileSync(guard, "utf8"), "other-taker", "the other taker's fresh guard is still there");
	assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".stale")), [], "no renamed guard is left behind");
});

test("race 1b: a guard that is still the stale one is removed, and the stale lock taken over", async () => {
	const dir = tmp();
	const file = lockFile("device:I", dir);
	fs.writeFileSync(file, JSON.stringify({ token: "stale", pid: 1 }));
	age(file, 10 * 60_000);
	fs.writeFileSync(`${file}.takeover`, "crashed-taker");
	age(`${file}.takeover`, 60_000);
	let fired = 0;
	const l = await acquireLock("device:I", { dir, ...fast, isAlive: () => true, testHooks: { staleGuard: () => void fired++ } });
	assert.equal(fired, 1);
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, l.token);
	assert.equal(fs.existsSync(`${file}.takeover`), false);
	l.release();
});

test("race 2: a takeover between the heartbeat's token check and its refresh is not overwritten; the old owner is told it lost the lock", async () => {
	const dir = tmp();
	const l = await acquireLock("device:J", { dir, ...fast, heartbeatMs: 10, testHooks: { beat: (f) => {
		// another process takes the lock over inside the heartbeat's window
		fs.rmSync(f);
		fs.writeFileSync(f, JSON.stringify({ token: "new-owner", pid: process.pid }));
	} } });
	await sleep(60);
	assert.equal(JSON.parse(fs.readFileSync(l.file, "utf8")).token, "new-owner", "the heartbeat did not write over the new owner");
	assert.equal(l.lost, true);
	assert.equal(l.signal.aborted, true);
	l.release();
	assert.equal(JSON.parse(fs.readFileSync(l.file, "utf8")).token, "new-owner", "a lost lock's release deletes nothing");
});
