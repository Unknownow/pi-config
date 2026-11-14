// node --experimental-strip-types --test lock.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { JobLock, type LockFs, realFs } from "./lock.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-lock-"));
const me = (n: number) => ({ pid: 1000 + n, sessionId: `s${n}`, host: "h" });
const sleepNone = async () => {};

function stale(dir: string, n = 1, heartbeat = 0) {
	fs.writeFileSync(path.join(dir, `owner.${n}.lock`), JSON.stringify({ ...me(0), heartbeat }));
}

test("after acquire a second acquire fails; takeover of a fresh lock is refused", async () => {
	const d = tmp();
	const a = new JobLock(d, { pid: process.pid, sessionId: "s1", host: "h" });
	assert.equal(a.acquire(), true);
	assert.equal(a.isOwner(), true);
	const b = new JobLock(d, me(2));
	assert.equal(b.acquire(), false);
	assert.equal(await b.takeOver(), false);
	assert.equal(b.isOwner(), false);
});

test("takeover of a stale lock (old heartbeat): generation 2 owns, generation 1 is deleted", async () => {
	const d = tmp();
	stale(d);
	const b = new JobLock(d, me(2), { now: () => 10 * 60_000 });
	assert.equal(await b.takeOver(), true);
	assert.deepEqual(fs.readdirSync(d), ["owner.2.lock"]);
	assert.equal(b.isOwner(), true);
});

test("a dead pid on the same host is stale at once; a live one on another host is not", async () => {
	const d = tmp();
	fs.writeFileSync(path.join(d, "owner.1.lock"), JSON.stringify({ pid: 5, sessionId: "x", host: "h", heartbeat: 1000 }));
	const dead = new JobLock(d, me(2), { now: () => 2000, pidAlive: () => false });
	assert.equal(dead.isStale(1), true);
	const alive = new JobLock(d, me(2), { now: () => 2000, pidAlive: () => true });
	assert.equal(alive.isStale(1), false);
	const other = new JobLock(d, { ...me(2), host: "other" }, { now: () => 2000, pidAlive: () => false });
	assert.equal(other.isStale(1), false);
});

test("two takeovers of a stale lock: B decided on a stale listing; A completed first; exactly one owns", async () => {
	const d = tmp();
	stale(d);
	const now = () => 10 * 60_000;
	const old = fs.readFileSync(path.join(d, "owner.1.lock"), "utf8");
	const A = new JobLock(d, me(2), { now });
	assert.equal(await A.takeOver(), true);
	// B's first listing and first read still show generation 1 (the state before A's takeover).
	let listed = false;
	let read = false;
	const stalefs: LockFs = {
		...realFs,
		readdirSync: (dir) => (listed ? realFs.readdirSync(dir) : ((listed = true), ["owner.1.lock"])),
		readFileSync: (file) => (!read && file.endsWith("owner.1.lock") ? ((read = true), old) : realFs.readFileSync(file)),
	};
	const B = new JobLock(d, me(3), { now, fs: stalefs });
	assert.equal(await B.takeOver(), false);
	assert.equal(A.isOwner(), true);
	assert.equal(B.isOwner(), false);
	assert.deepEqual(fs.readdirSync(d), ["owner.2.lock"]);
});

test("concurrent takeovers started together: at most one passes isOwner at any point", async () => {
	const d = tmp();
	stale(d);
	const now = () => 10 * 60_000;
	const A = new JobLock(d, me(2), { now });
	const B = new JobLock(d, me(3), { now });
	const results = await Promise.all([A.takeOver(), B.takeOver()]);
	assert.equal(results.filter(Boolean).length, 1);
	assert.equal([A.isOwner(), B.isOwner()].filter(Boolean).length, 1);
});

test("stale read: B reads generation 1; A moves on to generation 3; B creates 2 and fails its recheck, its file is removed", async () => {
	const d = tmp();
	stale(d);
	const now = () => 10 * 60_000;
	const b = new JobLock(d, me(2), {
		now,
		beforeCreate: () => {
			fs.writeFileSync(path.join(d, "owner.3.lock"), JSON.stringify({ ...me(1), heartbeat: now() }));
			fs.rmSync(path.join(d, "owner.1.lock"));
		},
	});
	assert.equal(await b.takeOver(), false);
	assert.deepEqual(fs.readdirSync(d).sort(), ["owner.3.lock"]);
	assert.equal(b.isOwner(), false);
});

test("same sessionId but a different pid: only the pid in the file passes", () => {
	const d = tmp();
	const a = new JobLock(d, { pid: 1, sessionId: "same", host: "h" });
	assert.equal(a.acquire(), true);
	const other = new JobLock(d, { pid: 2, sessionId: "same", host: "h" });
	other.gen = 1;
	assert.equal(a.isOwner(), true);
	assert.equal(other.isOwner(), false);
});

test("heartbeat: interrupted between temp write and rename leaves the lock readable", async () => {
	const d = tmp();
	const failing: LockFs = { ...realFs, renameSync: () => { throw Object.assign(new Error("x"), { code: "EXDEV" }); } };
	const a = new JobLock(d, me(1), { fs: failing, sleep: sleepNone });
	assert.equal(a.acquire(), true);
	assert.equal(await a.heartbeat(), "not-written");
	assert.equal(a.read(1) !== "unreadable" && a.read(1) !== undefined, true);
	assert.equal(fs.existsSync(path.join(d, "owner.1.lock.tmp")), false);
	assert.equal(a.isOwner(), true);
});

test("heartbeat rename with EPERM twice then success: written; five failures: not written, still owned, no temp file", async () => {
	const d = tmp();
	let fails = 2;
	const flaky: LockFs = { ...realFs, renameSync: (x, y) => { if (fails-- > 0) throw Object.assign(new Error("busy"), { code: "EPERM" }); realFs.renameSync(x, y); } };
	const a = new JobLock(d, me(1), { fs: flaky, sleep: sleepNone, now: () => 5000 });
	a.acquire();
	assert.equal(await a.heartbeat(), "written");
	assert.equal((a.read(1) as { heartbeat: number }).heartbeat, 5000);
	fails = 99;
	const b = new JobLock(d, me(1), { fs: flaky, sleep: sleepNone });
	b.gen = 1;
	assert.equal(await b.heartbeat(), "not-written");
	assert.equal(b.isOwner(), true);
	assert.equal(fs.existsSync(path.join(d, "owner.1.lock.tmp")), false);
});

test("a takeover link with EBUSY once still succeeds", async () => {
	const d = tmp();
	stale(d);
	let once = true;
	const flaky: LockFs = { ...realFs, linkSync: (x, y) => { if (once) { once = false; throw Object.assign(new Error("busy"), { code: "EBUSY" }); } realFs.linkSync(x, y); } };
	const b = new JobLock(d, me(2), { fs: flaky, sleep: sleepNone, now: () => 10 * 60_000 });
	assert.equal(await b.takeOver(), true);
	assert.equal(b.isOwner(), true);
});

test("an unreadable lock with a fresh mtime is not stale; an old one is", () => {
	const d = tmp();
	fs.writeFileSync(path.join(d, "owner.1.lock"), "{garbage");
	const fresh = new JobLock(d, me(2));
	assert.equal(fresh.isStale(1), false);
	const old = new JobLock(d, me(2), { now: () => Date.now() + 10 * 60_000 });
	assert.equal(old.isStale(1), true);
});

test("a heartbeat after losing the lock returns lost", async () => {
	const d = tmp();
	const a = new JobLock(d, me(1));
	a.acquire();
	fs.writeFileSync(path.join(d, "owner.2.lock"), JSON.stringify({ ...me(2), heartbeat: Date.now() }));
	assert.equal(a.isOwner(), false);
	assert.equal(await a.heartbeat(), "lost");
	a.release();
	assert.equal(fs.existsSync(path.join(d, "owner.1.lock")), true, "a lead that lost the job does not delete the new owner's files");
});
