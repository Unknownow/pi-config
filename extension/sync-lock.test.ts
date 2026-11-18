// node --experimental-strip-types --test extension/sync-lock.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquire, lockPath, lockHolder } from "./sync-lock.ts";

const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-lock-"));
const CHILD = path.join(import.meta.dirname, "sync-lock-child.ts");

function child(dir: string, waitMs: number, holdMs: number): Promise<{ got: boolean; start?: number; end?: number; pid?: number }> {
	return new Promise((resolve, reject) => {
		const p = spawn(process.execPath, [...process.execArgv, CHILD, dir, String(waitMs), String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.on("error", reject);
		p.on("close", () => {
			try {
				resolve(JSON.parse(out.trim().split("\n").pop() ?? ""));
			} catch {
				reject(new Error(`child output: ${out}`));
			}
		});
	});
}

/** The pid of a process that has already exited. */
function deadPid(): number {
	const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
	return Number(r.stdout);
}

test("acquire creates the lock with our pid and release removes it", async () => {
	const dir = dirOf();
	const lock = await acquire(dir, { waitMs: 0 });
	assert.ok(lock);
	const content = JSON.parse(fs.readFileSync(lockPath(dir), "utf8"));
	assert.equal(content.pid, process.pid);
	assert.equal(content.token, lock.token);
	assert.equal(lockHolder(dir)?.pid, process.pid);
	assert.equal(await acquire(dir, { waitMs: 0 }), null);
	lock.release();
	assert.equal(fs.existsSync(lockPath(dir)), false);
	assert.equal(lockHolder(dir), null);
});

test("a busy lock is waited for, then given up", async () => {
	const dir = dirOf();
	const first = await acquire(dir, { waitMs: 0 });
	assert.ok(first);
	const t0 = Date.now();
	assert.equal(await acquire(dir, { waitMs: 300, pollMs: 20 }), null);
	assert.ok(Date.now() - t0 >= 280);
	setTimeout(() => first.release(), 100);
	const second = await acquire(dir, { waitMs: 2000, pollMs: 20 });
	assert.ok(second);
	second.release();
});

test("two processes taking the lock at once: one waits, nothing overlaps", async () => {
	const dir = dirOf();
	const results = await Promise.all([child(dir, 10_000, 600), child(dir, 10_000, 600), child(dir, 10_000, 600)]);
	assert.ok(results.every((r) => r.got));
	const spans = results.map((r) => [r.start!, r.end!]).sort((a, b) => a[0] - b[0]);
	for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] >= spans[i - 1][1], `overlap: ${JSON.stringify(spans)}`);
	assert.equal(fs.existsSync(lockPath(dir)), false);
});

test("a lock whose pid is dead is taken over", async () => {
	const dir = dirOf();
	fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid(), token: "old" }));
	const lock = await acquire(dir, { waitMs: 0 });
	assert.ok(lock);
	assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).token, lock.token);
	assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes(".stale-") || f.endsWith(".takeover")), []);
	lock.release();
});

test("a lock with a live pid but an old heartbeat is taken over; a fresh one is not", async () => {
	const dir = dirOf();
	fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, token: "old" }));
	assert.equal(await acquire(dir, { waitMs: 0 }), null);
	const old = new Date(Date.now() - 3 * 60_000);
	fs.utimesSync(lockPath(dir), old, old);
	const lock = await acquire(dir, { waitMs: 0 });
	assert.ok(lock);
	lock.release();
});

test("a takeover mutex that outlived its owner is cleared", async () => {
	const dir = dirOf();
	fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid(), token: "old" }));
	fs.writeFileSync(`${lockPath(dir)}.takeover`, "x");
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(`${lockPath(dir)}.takeover`, old, old);
	assert.equal(await acquire(dir, { waitMs: 0 }), null); // clears the mutex, retries next poll
	const lock = await acquire(dir, { waitMs: 0 });
	assert.ok(lock);
	lock.release();
});

test("a process racing a takeover on a lock another process just took over loses it", async () => {
	const dir = dirOf();
	fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid(), token: "old" }));
	let b: ReturnType<typeof acquire> | null = null;
	// A has judged the old lock stale; before its takeover starts, B takes it over. With waitMs 0 and a
	// free lock, acquire() finishes all its file work before its first await, so B is done inside the hook.
	const aLock = await acquire(dir, {
		waitMs: 0,
		beforeTakeover: () => {
			b = acquire(dir, { waitMs: 0 });
		},
	});
	const bLock = await b!;
	assert.equal(aLock, null);
	assert.ok(bLock);
	assert.equal(JSON.parse(fs.readFileSync(lockPath(dir), "utf8")).token, bLock.token);
	bLock.release();
});

test("several processes racing one stale lock: only one holds it", async () => {
	const dir = dirOf();
	fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: deadPid(), token: "old" }));
	const results = await Promise.all(Array.from({ length: 6 }, () => child(dir, 0, 1500)));
	assert.equal(results.filter((r) => r.got).length, 1);
});

test("the heartbeat refreshes the mtime, and a replaced lock file marks the lock lost", async () => {
	const dir = dirOf();
	const lock = await acquire(dir, { waitMs: 0, heartbeatMs: 40 });
	assert.ok(lock);
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(lockPath(dir), old, old);
	await new Promise((r) => setTimeout(r, 120));
	assert.ok((lockHolder(dir)?.ageMs ?? Infinity) < 5000);
	assert.equal(lock.lost, false);
	fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, token: "someone else" }));
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(lock.lost, true);
	lock.release(); // not ours any more: must not remove the other lock
	assert.ok(fs.existsSync(lockPath(dir)));
});
