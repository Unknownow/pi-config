/** The running-sessions registry: one small file per interactive pi process in `<agentDir>/live/`. Display only; I/O errors are ignored. */

import * as fs from "node:fs";
import * as path from "node:path";

export const LIVE_MS = 120000;

export interface LiveEntry {
	v: 1;
	pid: number;
	started: string;
	updated: string;
	sessionFile: string | null;
	cwd: string;
	folders: string[];
	/** The set root this session runs in, or null in an original folder. */
	set: string | null;
	/** The git top of `cwd`, when known. */
	repo?: string | null;
	busy: boolean;
	flow: { phase: string; flowId?: string; title?: string; stage?: number; stages?: number } | null;
}

const fold = (s: string) => {
	const n = s.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "");
	return process.platform === "win32" ? n.toLowerCase() : n;
};
const inside = (p: string, dir: string) => fold(p) === fold(dir) || fold(p).startsWith(`${fold(dir)}/`);
const base = (p: string) => p.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").split("/").pop() ?? "";

export function writeLive(dir: string, entry: LiveEntry): void {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${entry.pid}.json`);
		fs.writeFileSync(`${file}.tmp`, JSON.stringify(entry));
		fs.renameSync(`${file}.tmp`, file);
	} catch {}
}

export function removeLive(dir: string, pid: number): void {
	try {
		fs.unlinkSync(path.join(dir, `${pid}.json`));
	} catch {}
}

/** The live entries (fresh and pid alive); files of dead pids are deleted. */
export function readLive(dir: string, now: number, isAlive: (pid: number) => boolean): LiveEntry[] {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const out: LiveEntry[] = [];
	for (const n of names) {
		try {
			const e = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as LiveEntry;
			if (!e || typeof e.pid !== "number") continue;
			if (!isAlive(e.pid)) {
				removeLive(dir, e.pid);
				continue;
			}
			if (now - Date.parse(e.updated) < LIVE_MS) out.push(e);
		} catch {}
	}
	return out;
}

/** The other live session that uses `setRoot` (its cwd or an added folder is inside), or null. */
export function setInUse(entries: LiveEntry[], setRoot: string, ownPid: number): LiveEntry | null {
	return entries.find((e) => e.pid !== ownPid && [e.cwd, ...(e.folders ?? [])].some((f) => inside(f, setRoot))) ?? null;
}

/** The footer line about the other sessions, or undefined when there are none. */
export function footerText(entries: LiveEntry[], ownPid: number): string | undefined {
	const others = entries.filter((e) => e.pid !== ownPid);
	if (!others.length) return undefined;
	const one = (e: LiveEntry) => {
		const label = base(e.set ?? e.repo ?? e.cwd) || String(e.pid);
		const exec = e.flow?.phase === "execute";
		let state: string;
		if (e.busy) state = `working${exec && e.flow?.stage !== undefined ? ` execute ${e.flow.stage}/${e.flow.stages ?? "?"}` : ""}`;
		else state = e.flow && (e.flow.phase === "plan" || exec) ? "needs you" : "idle";
		return `${label}: ${state}`;
	};
	const shown = others.slice(0, 4).map(one).join(" · ");
	return others.length > 4 ? `${shown} +${others.length - 4}` : shown;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
