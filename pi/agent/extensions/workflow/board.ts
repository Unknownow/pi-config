/**
 * Live flow data for the widget and the board. `live.json` is a small snapshot a running session writes into
 * its flow's plan folder (local only, never committed); `board.json` in the agent dir lists the plan folders
 * sessions have written to, so a board can find flows across repos.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isFlowId } from "./plan-doc.ts";

export interface LiveInfo {
	v: 1;
	flowId: string;
	title: string;
	pid: number;
	host: string;
	cwd: string;
	updated: string;
	phase: string;
	stage?: number;
	stages?: number;
	steps: { id: string; text: string; done: boolean }[];
	judgeRound: number;
	autopilot: boolean;
	waiting?: string;
	runs: { role: string; label: string; activity: string }[];
	events: { at: string; text: string }[];
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** null for anything that is not a version-1 snapshot with the right field types. */
export function parseLive(json: string): LiveInfo | null {
	let o: any;
	try {
		o = JSON.parse(json);
	} catch {
		return null;
	}
	if (!o || typeof o !== "object" || o.v !== 1 || !isFlowId(o.flowId)) return null;
	if (![o.title, o.host, o.cwd, o.updated, o.phase].every(isStr)) return null;
	if (!isNum(o.pid) || !isNum(o.judgeRound) || typeof o.autopilot !== "boolean") return null;
	if (o.stage !== undefined && !isNum(o.stage)) return null;
	if (o.stages !== undefined && !isNum(o.stages)) return null;
	if (o.waiting !== undefined && !isStr(o.waiting)) return null;
	if (!Array.isArray(o.steps) || !o.steps.every((s: any) => s && isStr(s.id) && isStr(s.text) && typeof s.done === "boolean")) return null;
	if (!Array.isArray(o.runs) || !o.runs.every((r: any) => r && isStr(r.role) && isStr(r.label) && isStr(r.activity))) return null;
	if (!Array.isArray(o.events) || !o.events.every((e: any) => e && isStr(e.at) && isStr(e.text))) return null;
	return o as LiveInfo;
}

/** The snapshot of a flow, or null when missing or broken. */
export function readLive(dir: string, flowId: string): LiveInfo | null {
	if (!isFlowId(flowId)) return null;
	try {
		return parseLive(fs.readFileSync(path.join(dir, flowId, "live.json"), "utf8"));
	} catch {
		return null;
	}
}

/** What changed between two snapshots, as timeline texts; `updated`, `pid`, `events` and `activity` never count. */
export function liveEvents(prev: LiveInfo | undefined, next: LiveInfo): string[] {
	if (!prev) return ["flow started"];
	const out: string[] = [];
	if (prev.phase !== next.phase) out.push(`phase ${prev.phase} → ${next.phase}`);
	if (prev.stage !== next.stage || prev.stages !== next.stages) {
		if (next.stage !== undefined) out.push(`stage ${next.stage}/${next.stages ?? "?"}`);
	}
	const wasDone = new Set(prev.steps.filter((s) => s.done).map((s) => s.id));
	for (const s of next.steps) if (s.done && !wasDone.has(s.id)) out.push(`${s.id} done`);
	if (next.judgeRound > prev.judgeRound) out.push(`judge round ${next.judgeRound}`);
	if (next.waiting !== undefined) {
		if (next.waiting !== prev.waiting) out.push(`waiting: ${next.waiting}`);
	} else if (prev.waiting !== undefined) out.push("wait over");
	const key = (r: { role: string; label: string }) => `${r.role}\n${r.label}`;
	const before = new Set(prev.runs.map(key));
	const after = new Set(next.runs.map(key));
	for (const r of next.runs) if (!before.has(key(r))) out.push(`${r.role} started: ${r.label}`);
	for (const r of prev.runs) if (!after.has(key(r))) out.push(`${r.role} finished: ${r.label}`);
	return out;
}

/** `width` cells of █ for the done share (rounded down) and ░ for the rest. */
export function progressBar(done: number, total: number, width: number): string {
	const filled = total > 0 ? Math.max(0, Math.min(width, Math.floor((width * done) / total))) : 0;
	return "█".repeat(filled) + "░".repeat(width - filled);
}

/** `12s`, `5m`, `3h` or `2d`, floored. */
export function ago(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

const REGISTRY_KEEP = 50;

interface RegistryFile {
	v: 1;
	dirs: { dir: string; updated: string }[];
}

function readRegistryFile(file: string): RegistryFile["dirs"] {
	try {
		const o = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!o || o.v !== 1 || !Array.isArray(o.dirs)) return [];
		return o.dirs.filter((d: any) => d && isStr(d.dir) && isStr(d.updated));
	} catch {
		return [];
	}
}

/** The plan folders in the registry, newest first; [] for a missing or broken file. */
export function readRegistry(file: string): string[] {
	return readRegistryFile(file).map((d) => d.dir);
}

/** Puts `dir` first with the time `now`, drops duplicates, keeps 50. Writes through a temp file; never throws. */
export function addToRegistry(file: string, dir: string, now: Date): void {
	try {
		const norm = dir.replace(/\\/g, "/");
		const dirs = [{ dir: norm, updated: now.toISOString() }, ...readRegistryFile(file).filter((d) => d.dir !== norm)].slice(0, REGISTRY_KEEP);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, dirs } satisfies RegistryFile, null, 2)}\n`);
		fs.renameSync(tmp, file);
	} catch {}
}
