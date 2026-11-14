/**
 * The job lock: a generation lock. Files `owner.<n>.lock` hold {pid, sessionId, host, heartbeat}.
 * The highest generation owns the job. A takeover creates generation n+1 atomically (hard link, so it fails on EEXIST),
 * then re-checks `isOwner()`; only generations below its own are deleted. Reliable on one host only.
 */

import * as nodeFs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Me {
	pid: number;
	sessionId: string;
	host: string;
}
export interface LockFile extends Me {
	heartbeat: number;
}

/** The file operations the lock uses; tests wrap them to interleave two leads. */
export interface LockFs {
	readdirSync(dir: string): string[];
	readFileSync(file: string): string;
	writeFileSync(file: string, data: string, flag?: string): void;
	linkSync(from: string, to: string): void;
	renameSync(from: string, to: string): void;
	unlinkSync(file: string): void;
	mtimeMs(file: string): number;
	mkdirSync(dir: string): void;
}

export const realFs: LockFs = {
	readdirSync: (d) => nodeFs.readdirSync(d),
	readFileSync: (f) => nodeFs.readFileSync(f, "utf8"),
	writeFileSync: (f, d, flag) => nodeFs.writeFileSync(f, d, { flag: flag ?? "w" }),
	linkSync: (a, b) => nodeFs.linkSync(a, b),
	renameSync: (a, b) => nodeFs.renameSync(a, b),
	unlinkSync: (f) => nodeFs.unlinkSync(f),
	mtimeMs: (f) => nodeFs.statSync(f).mtimeMs,
	mkdirSync: (d) => void nodeFs.mkdirSync(d, { recursive: true }),
};

export interface LockOpts {
	fs?: LockFs;
	now?: () => number;
	staleMs?: number;
	pidAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	/** Test seam: runs after a takeover decided the lock is stale and before it creates the next generation. */
	beforeCreate?: () => void;
}

const RETRY_CODES = ["EPERM", "EBUSY", "EACCES"];
const BACKOFF = [50, 100, 200, 400, 800];
const GEN = /^owner\.(\d+)\.lock$/;

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export const thisHost = () => os.hostname();

export class JobLock {
	gen: number | undefined;
	/** The owner whose stale lock the last successful `takeOver` replaced. */
	previous?: LockFile | "unreadable";
	private readonly fs: LockFs;
	private readonly now: () => number;
	private readonly staleMs: number;
	private readonly alive: (pid: number) => boolean;
	private readonly sleep: (ms: number) => Promise<void>;

	readonly dir: string;
	readonly me: Me;
	private readonly opts: LockOpts;

	constructor(dir: string, me: Me, opts: LockOpts = {}) {
		this.dir = dir;
		this.me = me;
		this.opts = opts;
		this.fs = opts.fs ?? realFs;
		this.now = opts.now ?? Date.now;
		this.staleMs = opts.staleMs ?? 120_000;
		this.alive = opts.pidAlive ?? pidAlive;
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	private file(n: number) {
		return path.join(this.dir, `owner.${n}.lock`);
	}

	/** Generations present, highest first. */
	generations(): number[] {
		try {
			return this.fs
				.readdirSync(this.dir)
				.map((f) => GEN.exec(f))
				.filter((m): m is RegExpExecArray => !!m)
				.map((m) => Number(m[1]))
				.sort((a, b) => b - a);
		} catch {
			return [];
		}
	}

	read(n: number): LockFile | "unreadable" | undefined {
		let text: string;
		try {
			text = this.fs.readFileSync(this.file(n));
		} catch {
			return undefined;
		}
		try {
			const j = JSON.parse(text);
			if (typeof j?.pid === "number" && typeof j.sessionId === "string" && typeof j.host === "string" && typeof j.heartbeat === "number") return j as LockFile;
		} catch {
			// falls through
		}
		return "unreadable";
	}

	/** Whether generation `n` has no live owner: an old heartbeat, a dead pid on this host, or (unreadable) an old mtime. */
	isStale(n: number): boolean {
		const l = this.read(n);
		if (l === undefined) return true;
		if (l === "unreadable") {
			try {
				return this.now() - this.fs.mtimeMs(this.file(n)) > this.staleMs;
			} catch {
				return true;
			}
		}
		if (this.now() - l.heartbeat > this.staleMs) return true;
		return l.host === this.me.host && !this.alive(l.pid);
	}

	private body(): string {
		return JSON.stringify({ ...this.me, heartbeat: this.now() } satisfies LockFile);
	}

	/** Creates generation 1; false when any lock exists. */
	acquire(): boolean {
		this.fs.mkdirSync(this.dir);
		if (this.generations().length) return false;
		try {
			this.fs.writeFileSync(this.file(1), this.body(), "wx");
		} catch {
			return false;
		}
		this.gen = 1;
		return true;
	}

	/** Re-attaches to the highest generation when its file already names this lead (a reload of the same session). */
	attach(): boolean {
		const g = this.generations()[0];
		if (g === undefined) return false;
		const f = this.read(g);
		if (f === undefined || f === "unreadable" || f.sessionId !== this.me.sessionId || f.pid !== this.me.pid || f.host !== this.me.host) return false;
		this.gen = g;
		return true;
	}

	/** Whether this lead's generation is the highest and its file still names this lead. */
	isOwner(): boolean {
		if (this.gen === undefined) return false;
		const gens = this.generations();
		if (gens[0] !== this.gen) return false;
		const l = this.read(this.gen);
		return l !== undefined && l !== "unreadable" && l.sessionId === this.me.sessionId && l.pid === this.me.pid && l.host === this.me.host;
	}

	private async retry<T>(op: () => T): Promise<T> {
		for (let i = 0; ; i++) {
			try {
				return op();
			} catch (e) {
				const code = (e as NodeJS.ErrnoException).code ?? "";
				if (i >= BACKOFF.length || !RETRY_CODES.includes(code)) throw e;
				await this.sleep(BACKOFF[i]);
			}
		}
	}

	/** Takes a stale lock over. False when the lock is fresh, someone else created the next generation first, or the recheck failed. */
	async takeOver(): Promise<boolean> {
		const gens = this.generations();
		if (gens.length === 0) return this.acquire();
		const n = gens[0];
		if (!this.isStale(n)) return false;
		const previous = this.read(n);
		this.opts.beforeCreate?.();
		const next = n + 1;
		const tmp = path.join(this.dir, `owner.${next}.lock.${process.pid}.${Math.floor(Math.random() * 1e6)}.tmp`);
		this.fs.writeFileSync(tmp, this.body());
		let linked = false;
		try {
			await this.retry(() => this.fs.linkSync(tmp, this.file(next)));
			linked = true;
		} catch {
			linked = false;
		} finally {
			try {
				this.fs.unlinkSync(tmp);
			} catch {
				// already gone
			}
		}
		if (!linked) return false;
		this.gen = next;
		if (!this.isOwner()) {
			try {
				this.fs.unlinkSync(this.file(next));
			} catch {
				// someone removed it already
			}
			this.gen = undefined;
			return false;
		}
		this.previous = previous;
		for (const g of this.generations()) {
			if (g < next) {
				try {
					this.fs.unlinkSync(this.file(g));
				} catch {
					// a stale file that cannot be removed does not change who owns the job
				}
			}
		}
		return true;
	}

	/** Refreshes the heartbeat, only while this lead owns the job. */
	async heartbeat(): Promise<"written" | "not-written" | "lost"> {
		if (!this.isOwner() || this.gen === undefined) return "lost";
		const f = this.file(this.gen);
		const tmp = `${f}.tmp`;
		try {
			this.fs.writeFileSync(tmp, this.body());
			await this.retry(() => this.fs.renameSync(tmp, f));
			return "written";
		} catch {
			try {
				this.fs.unlinkSync(tmp);
			} catch {
				// no temp file left
			}
			return "not-written";
		}
	}

	release(): void {
		if (this.gen !== undefined && this.isOwner()) {
			try {
				this.fs.unlinkSync(this.file(this.gen));
			} catch {
				// gone already
			}
		}
		this.gen = undefined;
	}
}
