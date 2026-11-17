/**
 * Cross-process resource lock for test_run: one file per resource under `os.tmpdir()/pi-agents-locks/`,
 * so runners of different pi processes (sessions, workers) never share a device or a Unity project.
 *
 * Protocol: the lock file is created with `wx` and written once: the owner token (pid + random) and its pid.
 * Waiters poll every 250-500 ms (jittered). The heartbeat never rewrites the file: every 30 s it checks the
 * file still holds the owner's token and only then touches its mtime. A lock whose token is no longer the
 * owner's is lost: `HeldLock.lost` is set, its `signal` aborts and the heartbeat stops. Release skips a lost
 * lock and re-checks the token right before deleting. A stale lock (owner pid dead, or mtime older than
 * 2 min) is taken over under a `<name>.takeover` guard file created with `wx` (content: the taker's token,
 * stale after 30 s): holding the guard, the taker re-reads the lock and only if it still has the stale token
 * deletes it and creates its own with `wx`. A stale guard is removed only by renaming it to a unique name and
 * checking the renamed file is the guard judged stale (same content and mtime); a guard taken meanwhile is
 * put back with `linkSync` (which fails if yet another guard exists) and the renamed name is unlinked.
 */

import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LOCK_DIR = path.join(os.tmpdir(), "pi-agents-locks");

export interface LockOptions {
	/** Folder of the lock files; default LOCK_DIR. */
	dir?: string;
	signal?: AbortSignal;
	/** Poll interval: a wait of `pollMs` to `2 × pollMs` between tries. Default 250. */
	pollMs?: number;
	/** Heartbeat refresh (the lock file's mtime). Default 30 s. */
	heartbeatMs?: number;
	/** A lock file whose mtime is older than this is stale. Default 2 min. */
	staleMs?: number;
	/** A takeover guard older than this is stale. Default 30 s. */
	guardStaleMs?: number;
	/** Whether a pid runs; default `process.kill(pid, 0)`. */
	isAlive?: (pid: number) => boolean;
	/** Test hook: the owner's pid written into the token. */
	pid?: number;
	/** Test hooks that run inside the race windows, to simulate another process acting there. */
	testHooks?: {
		/** After a takeover guard was judged stale, before it is removed. */
		staleGuard?: (guard: string) => void;
		/** In a heartbeat, after the token check, before the mtime is touched. */
		beat?: (file: string) => void;
	};
}

export interface HeldLock {
	/** The lock file. */
	file: string;
	token: string;
	/** Set once the heartbeat found another token in the file (the lock was taken over); the holder must stop. */
	readonly lost: boolean;
	/** Aborts when the lock is lost. */
	signal: AbortSignal;
	/** Stops the heartbeat and, unless the lock was lost, deletes the file if it still holds this token. */
	release(): void;
}

interface LockContent {
	token: string;
	pid: number;
}

/** The key a resource is locked under: kind lowercased, the path part with forward slashes (lowercased on win32), no trailing slash. */
export function normaliseResource(resource: string, platform: NodeJS.Platform = process.platform): string {
	const r = resource.trim();
	const at = r.indexOf(":");
	const kind = at > 0 ? r.slice(0, at).toLowerCase() : "";
	let rest = (at > 0 ? r.slice(at + 1) : r).trim().replaceAll("\\", "/");
	if (rest.length > 1) rest = rest.replace(/\/+$/, "");
	if (platform === "win32") rest = rest.toLowerCase();
	return kind ? `${kind}:${rest}` : rest;
}

/** The lock file of a resource: a hash of its normalised key. */
export function lockFile(resource: string, dir = LOCK_DIR, platform: NodeJS.Platform = process.platform): string {
	return path.join(dir, `${createHash("sha1").update(normaliseResource(resource, platform)).digest("hex").slice(0, 32)}.lock`);
}

function defaultAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
}

function readLock(file: string): { content?: LockContent; mtimeMs: number } | null {
	try {
		const text = fs.readFileSync(file, "utf8");
		let mtimeMs = Date.now();
		try {
			mtimeMs = fs.statSync(file).mtimeMs;
		} catch {
			// gone between the two calls
		}
		try {
			const c = JSON.parse(text) as LockContent;
			if (typeof c?.token === "string" && typeof c.pid === "number") return { content: c, mtimeMs };
		} catch {
			// half written, or foreign
		}
		return { mtimeMs };
	} catch (e) {
		if ((e as { code?: string }).code === "ENOENT") return null;
		throw e;
	}
}

function tryCreate(file: string, data: string): boolean {
	try {
		fs.writeFileSync(file, data, { flag: "wx" });
		return true;
	} catch (e) {
		if ((e as { code?: string }).code === "EEXIST") return false;
		throw e;
	}
}

const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const onAbort = () => {
			clearTimeout(t);
			reject(abortError());
		};
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Waits until this process holds the resource's lock file. Rejects with an AbortError when `signal` aborts. */
export async function acquireLock(resource: string, opts: LockOptions = {}): Promise<HeldLock> {
	const dir = opts.dir ?? LOCK_DIR;
	const pollMs = opts.pollMs ?? 250;
	const heartbeatMs = opts.heartbeatMs ?? 30_000;
	const staleMs = opts.staleMs ?? 120_000;
	const guardStaleMs = opts.guardStaleMs ?? 30_000;
	const isAlive = opts.isAlive ?? defaultAlive;
	const pid = opts.pid ?? process.pid;
	const file = lockFile(resource, dir);
	const guard = `${file}.takeover`;
	const token = `${pid}-${randomBytes(8).toString("hex")}`;
	const body = JSON.stringify({ token, pid, resource: normaliseResource(resource) });
	fs.mkdirSync(dir, { recursive: true });

	const isStale = (r: { content?: LockContent; mtimeMs: number }): boolean => {
		if (r.content && !isAlive(r.content.pid)) return true;
		return Date.now() - r.mtimeMs > staleMs;
	};

	/** Removes the takeover guard if it is still the stale one that was judged (`seen`); a guard taken meanwhile is put back. */
	const dropStaleGuard = (seen: { text: string; mtimeMs: number }): void => {
		const moved = `${guard}.${token}.stale`;
		try {
			fs.renameSync(guard, moved);
		} catch {
			return; // gone, or renamed by another taker
		}
		let same = false;
		try {
			same = fs.readFileSync(moved, "utf8") === seen.text && fs.statSync(moved).mtimeMs === seen.mtimeMs;
		} catch {
			// unreadable: treat as another's
		}
		if (!same) {
			try {
				fs.linkSync(moved, guard); // fails when yet another guard exists: that one wins
			} catch {
				// a newer guard exists
			}
		}
		fs.rmSync(moved, { force: true });
	};

	/** Under the guard: replace the stale lock if it still holds `staleToken`. */
	const takeOver = (staleToken: string | undefined): boolean => {
		if (!tryCreate(guard, token)) {
			try {
				const seen = { text: fs.readFileSync(guard, "utf8"), mtimeMs: fs.statSync(guard).mtimeMs };
				if (Date.now() - seen.mtimeMs > guardStaleMs) {
					opts.testHooks?.staleGuard?.(guard);
					dropStaleGuard(seen);
				}
			} catch {
				// the guard went away
			}
			return false;
		}
		try {
			const now = readLock(file);
			if (now && now.content?.token !== staleToken) return false;
			if (now && !isStale(now)) return false;
			if (now) fs.rmSync(file, { force: true });
			return tryCreate(file, body);
		} finally {
			// only our own guard is removed
			try {
				if (fs.readFileSync(guard, "utf8") === token) fs.rmSync(guard, { force: true });
			} catch {
				// gone
			}
		}
	};

	for (;;) {
		if (opts.signal?.aborted) throw abortError();
		let got = tryCreate(file, body);
		if (!got) {
			const r = readLock(file);
			if (r === null) continue; // released between the two calls
			if (isStale(r)) got = takeOver(r.content?.token);
		}
		if (got) break;
		await wait(pollMs + Math.floor(Math.random() * pollMs), opts.signal);
	}

	let released = false;
	let lost = false;
	const lostCtl = new AbortController();
	const holds = (): boolean => readLock(file)?.content?.token === token;
	const beat = setInterval(() => {
		try {
			if (!holds()) {
				// taken over: never touch the new owner's file; the holder is told
				lost = true;
				clearInterval(beat);
				lostCtl.abort(Object.assign(new Error("resource lock lost"), { name: "AbortError" }));
				return;
			}
			opts.testHooks?.beat?.(file);
			const now = new Date();
			fs.utimesSync(file, now, now);
		} catch {
			// try again next beat
		}
	}, heartbeatMs);
	beat.unref?.();
	return {
		file,
		token,
		get lost() {
			return lost;
		},
		signal: lostCtl.signal,
		release() {
			if (released) return;
			released = true;
			clearInterval(beat);
			if (lost) return;
			try {
				if (holds()) fs.rmSync(file, { force: true });
			} catch {
				// nothing to release
			}
		},
	};
}
