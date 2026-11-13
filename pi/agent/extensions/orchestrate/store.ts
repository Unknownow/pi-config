/** Run files under `<git common dir>/pi/orchestra/<run>/`. One writer per file; messages are only appended. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Run, Sub } from "./brief.ts";
import { emptyItems, type ItemsFile } from "./items.ts";
import type { View } from "./view.ts";

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

/** Whether two paths are the same directory: forward slashes, no trailing slash, lowercase when `ci` (default: Windows). */
export function sameDir(a: string, b: string, ci: boolean = process.platform === "win32"): boolean {
	return ci ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
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

export const viewPath = (common: string, runId: string): string => `${runDir(common, runId)}/view.json`;

/** view.json: written by the orchestrator's watcher only (tmp + rename). */
export function writeView(common: string, runId: string, view: View): void {
	writeAtomic(viewPath(common, runId), view);
}

export function readView(common: string, runId: string): { view?: View; corrupt?: string } {
	const r = readJson<View>(viewPath(common, runId));
	if (r.value && (r.value.v !== 1 || !Array.isArray(r.value.subs))) return { corrupt: `${viewPath(common, runId)}: not a view file (v, subs)` };
	return { view: r.value, corrupt: r.corrupt };
}

export const itemsPath = (common: string, runId: string): string => `${runDir(common, runId)}/items.json`;

/** items.json: written by the orchestrator session only (tmp + rename). A missing file is empty; an unreadable one is empty with a `corrupt` text to report once. */
export function readItems(common: string, runId: string): { file: ItemsFile; corrupt?: string } {
	const r = readJson<ItemsFile>(itemsPath(common, runId));
	if (r.value && (r.value.v !== 1 || !Array.isArray(r.value.items) || typeof r.value.subs !== "object" || !r.value.subs)) return { file: emptyItems(), corrupt: `${itemsPath(common, runId)}: not an items file (v, items, subs)` };
	return { file: r.value ?? emptyItems(), corrupt: r.corrupt };
}

export function writeItems(common: string, runId: string, file: ItemsFile): void {
	writeAtomic(itemsPath(common, runId), file);
}

/** One worktree set that an orchestrated run created (or is creating): the evidence the trust handler relies on. */
export interface SpawnEntry {
	runId: string;
	common: string;
	sub: string;
	state: "spawning" | "spawned";
	at: string;
	/** The worktree roots of the sub (the working repo and every repo worktree); empty while spawning. */
	tops: string[];
}

export const spawnRegistryPath = (agentDir: string): string => `${norm(agentDir)}/orchestrate-spawned.json`;

/**
 * The per-user registry of spawned worktrees, outside every repository: only `orch_spawn` of a trusted-origin run writes it, so a
 * project cannot vouch for itself. A missing or unreadable file means empty.
 */
export function readSpawnRegistry(agentDir: string): SpawnEntry[] {
	const v = readJson<{ entries?: unknown }>(spawnRegistryPath(agentDir)).value;
	if (!Array.isArray(v?.entries)) return [];
	return v.entries.filter((e): e is SpawnEntry => !!e && typeof e === "object" && typeof (e as SpawnEntry).runId === "string" && typeof (e as SpawnEntry).common === "string" && typeof (e as SpawnEntry).sub === "string" && ((e as SpawnEntry).state === "spawning" || (e as SpawnEntry).state === "spawned") && typeof (e as SpawnEntry).at === "string" && Array.isArray((e as SpawnEntry).tops));
}

export function writeSpawnRegistry(agentDir: string, entries: SpawnEntry[]): void {
	writeAtomic(spawnRegistryPath(agentDir), { v: 1, entries });
}

/** Adds or replaces the entry of (runId, sub). Pure. */
export function withSpawnEntry(entries: SpawnEntry[], e: SpawnEntry): SpawnEntry[] {
	return [...entries.filter((x) => !(x.runId === e.runId && x.sub === e.sub)), e];
}

/** Drops the entries of a run, or of one sub of it. Pure. */
export function withoutSpawnEntries(entries: SpawnEntry[], runId: string, sub?: string): SpawnEntry[] {
	return entries.filter((x) => !(x.runId === runId && (sub === undefined || x.sub === sub)));
}
