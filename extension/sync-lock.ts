/**
 * Cross-window lock: one file, `<dir>/sync.lock`, guards every git and sync operation of the
 * extension across pi windows (processes).
 *
 *  - The file holds `{ pid, token }`, written once with the `wx` flag. Its mtime is the heartbeat,
 *    refreshed every 15 s while held. Before each heartbeat the owner re-reads the token; when it
 *    is not its own the lock is marked lost (`lock.lost`) and the heartbeat stops.
 *  - A lock whose pid is dead, or whose mtime is older than 2 minutes, is stale. It is taken over
 *    under a short mutex, `<dir>/sync.lock.takeover` (created with `wx`, itself stale after 30 s):
 *    under the mutex the lock is re-read and must still hold the same token and still be stale;
 *    only then is it renamed away, the new lock created with `wx`, the mutex released and the
 *    token re-read to confirm ownership.
 *  - acquire() polls for up to `waitMs`, then gives up (null).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export const HEARTBEAT_MS = 15_000;
export const STALE_MS = 120_000;
export const MUTEX_STALE_MS = 30_000;

export interface AcquireOptions {
	/** How long to wait for a busy lock; 0 tries once. */
	waitMs: number;
	pollMs?: number;
	heartbeatMs?: number;
	staleMs?: number;
	mutexStaleMs?: number;
	/** Test hook: runs after a lock was judged stale, before the takeover starts. */
	beforeTakeover?: () => void;
}

export interface Lock {
	readonly path: string;
	readonly token: string;
	/** True once another process replaced the lock file. */
	readonly lost: boolean;
	/** Stop the heartbeat and remove the lock file if it is still ours. */
	release(): void;
}

interface LockInfo {
	pid: number | null;
	token: string | null;
	raw: string;
	mtimeMs: number;
}

export const lockPath = (dir: string) => path.join(dir, "sync.lock");

function readInfo(file: string): LockInfo | null {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const mtimeMs = fs.statSync(file).mtimeMs;
		try {
			const j = JSON.parse(raw);
			return { pid: typeof j.pid === "number" ? j.pid : null, token: typeof j.token === "string" ? j.token : null, raw, mtimeMs };
		} catch {
			return { pid: null, token: null, raw, mtimeMs }; // being written, or damaged
		}
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isStale(info: LockInfo, staleMs: number): boolean {
	if (info.pid !== null && !pidAlive(info.pid)) return true;
	return Date.now() - info.mtimeMs > staleMs;
}

/** Who holds the lock and how old its heartbeat is; null when nobody does. For `/pi-config status`. */
export function lockHolder(dir: string): { pid: number | null; ageMs: number; stale: boolean } | null {
	const info = readInfo(lockPath(dir));
	if (!info) return null;
	return { pid: info.pid, ageMs: Math.max(0, Date.now() - info.mtimeMs), stale: isStale(info, STALE_MS) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tryCreate(file: string, token: string): boolean {
	try {
		fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
		return true;
	} catch {
		return false;
	}
}

/** One attempt to replace a stale lock. True when this process now holds `file`. */
function takeOver(file: string, token: string, seen: LockInfo, o: Required<Pick<AcquireOptions, "staleMs" | "mutexStaleMs">>): boolean {
	const mutex = `${file}.takeover`;
	try {
		fs.writeFileSync(mutex, token, { flag: "wx" });
	} catch {
		// Someone else is taking over. A mutex that outlived its owner is cleared; we retry next poll.
		try {
			if (Date.now() - fs.statSync(mutex).mtimeMs > o.mutexStaleMs) fs.unlinkSync(mutex);
		} catch {
			// gone already
		}
		return false;
	}
	try {
		const now = readInfo(file);
		// Still the lock we judged stale, and still stale: nobody took over in between.
		if (now && (now.token !== seen.token || now.raw !== seen.raw || !isStale(now, o.staleMs))) return false;
		if (now) {
			try {
				fs.renameSync(file, `${file}.stale-${process.pid}-${randomUUID().slice(0, 8)}`);
			} catch {
				return false;
			}
		}
		if (!tryCreate(file, token)) return false;
	} finally {
		try {
			fs.unlinkSync(mutex);
		} catch {
			// already cleared
		}
	}
	const confirm = readInfo(file);
	return confirm?.token === token;
}

function cleanStaleCopies(file: string): void {
	const dir = path.dirname(file);
	const base = path.basename(file) + ".stale-";
	try {
		for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) fs.rmSync(path.join(dir, f), { force: true });
	} catch {
		// best effort
	}
}

function makeLock(file: string, token: string, heartbeatMs: number): Lock {
	let lost = false;
	let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
		const info = readInfo(file);
		if (!info || info.token !== token) {
			lost = true;
			if (timer) clearInterval(timer);
			timer = null;
			return;
		}
		try {
			const now = new Date();
			fs.utimesSync(file, now, now);
		} catch {
			// next tick tries again
		}
	}, heartbeatMs);
	timer.unref?.();
	return {
		path: file,
		token,
		get lost() {
			return lost;
		},
		release() {
			if (timer) clearInterval(timer);
			timer = null;
			if (readInfo(file)?.token === token) {
				try {
					fs.unlinkSync(file);
				} catch {
					// already gone
				}
			}
		},
	};
}

/** Take the lock in `dir`, waiting up to `opts.waitMs`. Null when it stays busy. */
export async function acquire(dir: string, opts: AcquireOptions): Promise<Lock | null> {
	const file = lockPath(dir);
	const token = randomUUID();
	const o = { staleMs: opts.staleMs ?? STALE_MS, mutexStaleMs: opts.mutexStaleMs ?? MUTEX_STALE_MS };
	fs.mkdirSync(dir, { recursive: true });
	const deadline = Date.now() + opts.waitMs;
	for (;;) {
		let mine = tryCreate(file, token);
		if (!mine) {
			const info = readInfo(file);
			if (info && isStale(info, o.staleMs)) {
				opts.beforeTakeover?.();
				mine = takeOver(file, token, info, o);
			}
		}
		if (mine) {
			cleanStaleCopies(file);
			return makeLock(file, token, opts.heartbeatMs ?? HEARTBEAT_MS);
		}
		if (Date.now() >= deadline) return null;
		await sleep(opts.pollMs ?? 200);
	}
}
