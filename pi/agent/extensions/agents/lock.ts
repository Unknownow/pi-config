/**
 * Cross-process resource lock for test_run: one file per resource under `os.tmpdir()/pi-agents-locks/`,
 * so runners of different pi processes (sessions, workers) never share a device or a Unity project.
 *
 * Protocol: the lock file is created with `wx`; its content is the owner token (pid + random) and a
 * heartbeat time. Waiters poll every 250-500 ms (jittered). The owner rewrites the heartbeat every 30 s,
 * only while the file still holds its token; release deletes the file only when it holds its token.
 * A stale lock (owner pid dead, or heartbeat older than 2 min) is taken over under a `<name>.takeover`
 * guard file created with `wx` (itself stale after 30 s): holding the guard, the taker re-reads the lock
 * and only if it still has the stale token deletes it and creates its own with `wx`.
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
	/** Heartbeat refresh. Default 30 s. */
	heartbeatMs?: number;
	/** A heartbeat older than this is stale. Default 2 min. */
	staleMs?: number;
	/** A takeover guard older than this is stale. Default 30 s. */
	guardStaleMs?: number;
	/** Whether a pid runs; default `process.kill(pid, 0)`. */
	isAlive?: (pid: number) => boolean;
	/** Test hook: the owner's pid written into the token. */
	pid?: number;
}

export interface HeldLock {
	/** The lock file. */
	file: string;
	token: string;
	/** Stops the heartbeat and deletes the file if it still holds this token. */
	release(): void;
}

interface LockContent {
	token: string;
	pid: number;
	at: number;
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
			if (typeof c?.token === "string" && typeof c.pid === "number" && typeof c.at === "number") return { content: c, mtimeMs };
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
	const body = () => JSON.stringify({ token, pid, at: Date.now(), resource: normaliseResource(resource) });
	fs.mkdirSync(dir, { recursive: true });

	const isStale = (r: { content?: LockContent; mtimeMs: number }): boolean => {
		if (!r.content) return Date.now() - r.mtimeMs > staleMs;
		return !isAlive(r.content.pid) || Date.now() - r.content.at > staleMs;
	};

	/** Under the guard: replace the stale lock if it still holds `staleToken`. */
	const takeOver = (staleToken: string | undefined): boolean => {
		if (!tryCreate(guard, String(pid))) {
			try {
				if (Date.now() - fs.statSync(guard).mtimeMs > guardStaleMs) fs.rmSync(guard, { force: true });
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
			return tryCreate(file, body());
		} finally {
			fs.rmSync(guard, { force: true });
		}
	};

	for (;;) {
		if (opts.signal?.aborted) throw abortError();
		let got = tryCreate(file, body());
		if (!got) {
			const r = readLock(file);
			if (r === null) continue; // released between the two calls
			if (isStale(r)) got = takeOver(r.content?.token);
		}
		if (got) break;
		await wait(pollMs + Math.floor(Math.random() * pollMs), opts.signal);
	}

	let released = false;
	const beat = setInterval(() => {
		try {
			const r = readLock(file);
			if (r?.content?.token !== token) {
				clearInterval(beat); // taken over: never write over the new owner
				return;
			}
			fs.writeFileSync(file, body());
		} catch {
			// try again next beat
		}
	}, heartbeatMs);
	beat.unref?.();
	return {
		file,
		token,
		release() {
			if (released) return;
			released = true;
			clearInterval(beat);
			try {
				if (readLock(file)?.content?.token === token) fs.rmSync(file, { force: true });
			} catch {
				// nothing to release
			}
		},
	};
}
