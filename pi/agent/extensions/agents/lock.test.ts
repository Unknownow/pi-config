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

test("a stale lock is taken over: old heartbeat or dead pid", async () => {
	const dir = tmp();
	const file = lockFile("device:B", dir);
	fs.writeFileSync(file, JSON.stringify({ token: "old", pid: process.pid, at: Date.now() - 10 * 60_000 }));
	const l = await acquireLock("device:B", { dir, ...fast });
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, l.token);
	l.release();
	fs.writeFileSync(file, JSON.stringify({ token: "dead", pid: 424242, at: Date.now() }));
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
		fs.writeFileSync(file, JSON.stringify({ token: "stale", pid: 1, at: 0 }));
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
	fs.writeFileSync(file, JSON.stringify({ token: "stale", pid: 1, at: 0 }));
	fs.writeFileSync(`${file}.takeover`, "1");
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(`${file}.takeover`, old, old);
	const l = await acquireLock("device:E", { dir, ...fast, isAlive: () => true });
	assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).token, l.token);
	l.release();
});

test("an owner whose lock was taken over neither overwrites nor deletes the new owner's file", async () => {
	const dir = tmp();
	const old = await acquireLock("device:F", { dir, ...fast, heartbeatMs: 10 });
	// The old owner looks stale (its heartbeat is backdated); a new owner takes over.
	fs.writeFileSync(old.file, JSON.stringify({ token: old.token, pid: process.pid, at: 0 }));
	const fresh = await acquireLock("device:F", { dir, ...fast });
	await sleep(50); // several heartbeats of the old owner
	assert.equal(JSON.parse(fs.readFileSync(old.file, "utf8")).token, fresh.token, "the heartbeat did not write over the new owner");
	old.release();
	assert.equal(JSON.parse(fs.readFileSync(old.file, "utf8")).token, fresh.token, "release did not delete the new owner's file");
	fresh.release();
	assert.equal(fs.existsSync(fresh.file), false);
});

test("the heartbeat refreshes the owner's own file", async () => {
	const dir = tmp();
	const l = await acquireLock("device:G", { dir, ...fast, heartbeatMs: 10 });
	const at0 = JSON.parse(fs.readFileSync(l.file, "utf8")).at;
	await sleep(60);
	assert.ok(JSON.parse(fs.readFileSync(l.file, "utf8")).at > at0);
	l.release();
});
