/** Run files under `<git common dir>/pi/orchestra/<run>/`. One writer per file; messages are only appended. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Run, Sub } from "./brief.ts";

export type Exec = (command: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr?: string; code: number }>;

export interface Message {
	v: 1;
	id: string;
	ts: string;
	type: string;
	replyTo?: string;
	text: string;
	data?: Record<string, unknown>;
}

export interface Status {
	v: 1;
	phase: string;
	flowId?: string;
	title?: string;
	stage?: number;
	stages?: number;
	done?: number;
	total?: number;
	waiting?: boolean;
	heartbeat: number;
	pid: number;
}

export function norm(p: string): string {
	return p.replace(/[\\]/g, "/").replace(/\/+$/, "");
}

/** Absolute git common dir of the repo at cwd, forward slashes; null outside a repo. */
export async function commonDir(exec: Exec, cwd: string): Promise<string | null> {
	const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
	const out = r.stdout.trim();
	return r.code === 0 && out ? norm(out) : null;
}

export const orchestraDir = (common: string) => `${norm(common)}/pi/orchestra`;
export const runDir = (common: string, id: string) => `${orchestraDir(common)}/${id}`;
export const subDir = (common: string, runId: string, subId: string) => `${runDir(common, runId)}/${subId}`;

/** Result of reading a JSON file: a value, nothing, or a corruption text to report once. */
function readJson<T>(file: string): { value?: T; corrupt?: string } {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return {};
	}
	try {
		return { value: JSON.parse(text) as T };
	} catch (e) {
		return { corrupt: `${file}: ${(e as Error).message}` };
	}
}

function writeAtomic(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}

function validRun(r: unknown): boolean {
	const o = r as Partial<Run> | null;
	if (!o || o.v !== 1 || typeof o.id !== "string" || !Array.isArray(o.subs)) return false;
	return o.subs.every((s) => s && typeof s.id === "string" && Array.isArray(s.owns) && typeof s.state === "string");
}

export function readRun(common: string, id: string): { run?: Run; corrupt?: string } {
	const r = readJson<Run>(`${runDir(common, id)}/run.json`);
	if (r.value && !validRun(r.value)) return { corrupt: `${runDir(common, id)}/run.json: not a run file (v, id, subs)` };
	return { run: r.value, corrupt: r.corrupt };
}

export function writeRun(common: string, run: Run): void {
	writeAtomic(`${runDir(common, run.id)}/run.json`, run);
}

/** Runs whose run.json says active; corrupt files are listed in `corrupt`. */
export function listActiveRuns(common: string): { runs: Run[]; corrupt: string[] } {
	const runs: Run[] = [];
	const corrupt: string[] = [];
	let names: string[] = [];
	try {
		names = fs.readdirSync(orchestraDir(common));
	} catch {
		return { runs, corrupt };
	}
	for (const n of names) {
		const r = readRun(common, n);
		if (r.corrupt) corrupt.push(r.corrupt);
		else if (r.run && r.run.state === "active") runs.push(r.run);
	}
	return { runs, corrupt };
}

/** Appends one line with the next sequential id (`<from>-<n>`) and a timestamp; returns the message. */
export function appendMessage(file: string, from: string, msg: Omit<Message, "v" | "id" | "ts">, now: Date = new Date()): Message {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let n = 1;
	let partial = false;
	try {
		const text = fs.readFileSync(file, "utf8");
		n = text.split("\n").filter(Boolean).length + 1;
		partial = text.length > 0 && !text.endsWith("\n");
	} catch {
		// no file yet
	}
	if (partial) fs.appendFileSync(file, "\n"); // a crash left half a line: end it so the new message is its own line
	const full: Message = { v: 1, id: `${from}-${n}`, ts: now.toISOString(), ...msg };
	fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
	return full;
}

/** Complete lines after `cursor` (a line count). An unterminated last line is left for the next read; a bad line is skipped and counted in `bad`. */
export function readNew(file: string, cursor: number): { msgs: Message[]; cursor: number; bad: number } {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return { msgs: [], cursor, bad: 0 };
	}
	const lines = text.split("\n");
	lines.pop(); // empty after the last newline, or an unterminated line
	const msgs: Message[] = [];
	let bad = 0;
	for (const line of lines.slice(cursor)) {
		try {
			msgs.push(JSON.parse(line) as Message);
		} catch {
			bad++;
		}
	}
	return { msgs, cursor: Math.max(cursor, lines.length), bad };
}

export function readCursor(file: string): number {
	const v = readJson<{ n?: number }>(file).value;
	return typeof v?.n === "number" && v.n >= 0 ? v.n : 0;
}

export function writeCursor(file: string, n: number): void {
	writeAtomic(file, { n });
}

export function readStatus(file: string): { status?: Status; corrupt?: string } {
	const r = readJson<Status>(file);
	return { status: r.value, corrupt: r.corrupt };
}

export function writeStatus(file: string, status: Status): void {
	writeAtomic(file, status);
}

export function readAccepted(file: string): string[] {
	const v = readJson<{ trees?: unknown }>(file).value;
	return Array.isArray(v?.trees) ? v.trees.filter((t): t is string => typeof t === "string") : [];
}

/** Adds a tree once; returns whether it was new. */
export function addAccepted(file: string, tree: string): boolean {
	const trees = readAccepted(file);
	if (trees.includes(tree)) return false;
	writeAtomic(file, { trees: [...trees, tree] });
	return true;
}

/** The (run, sub) whose worktree is `toplevel`; compared with forward slashes, lowercase when `ci` (default: Windows). */
export function findSubByToplevel(runs: Run[], toplevel: string, ci: boolean = process.platform === "win32"): { run: Run; sub: Sub } | null {
	const key = (p: string) => (ci ? norm(p).toLowerCase() : norm(p));
	const want = key(toplevel);
	for (const run of runs) for (const sub of run.subs) if (sub.cwd && key(sub.cwd) === want) return { run, sub };
	return null;
}
