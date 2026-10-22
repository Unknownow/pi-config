/**
 * Live flow data for the widget and the board. `live.json` is a small snapshot a running session writes into
 * its flow's plan folder (local only, never committed); `board.json` in the agent dir lists the plan folders
 * sessions have written to, so a board can find flows across repos.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isFlowId, type PlanStatus } from "./plan-doc.ts";
import { CLAIM_LIVE_MS } from "./plan-store.ts";

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

export interface BoardEntry {
	flowId: string;
	dir: string;
	status: PlanStatus | null;
	live: LiveInfo | null;
	mtime: number;
}

export type BoardClass = "running" | "waiting" | "stalled" | "finished";
export type BoardRow = BoardEntry & { cls: BoardClass; at: number };

const DAY = 86_400_000;
const BOARD_MAX = 30;
const CLASS_ORDER: BoardClass[] = ["running", "waiting", "stalled", "finished"];

function ms(iso: string | undefined): number {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(t) ? t : 0;
}

/** Classifies the entries, drops old ones and sorts running, waiting, stalled, finished; newest first within a class. */
export function boardRows(entries: BoardEntry[], now: number, host: string, isAlive: (pid: number) => boolean): BoardRow[] {
	const rows: BoardRow[] = [];
	for (const e of entries) {
		if (!e.status && !e.live) continue;
		const at = Math.max(ms(e.live?.updated), ms(e.status?.updated), e.mtime);
		const finished = e.status?.finished;
		const live = !!e.live && now - ms(e.live.updated) < CLAIM_LIVE_MS && e.live.host === host && isAlive(e.live.pid);
		let cls: BoardClass | undefined;
		if (finished) {
			if (now - ms(finished.at) <= DAY) cls = "finished";
		} else if (live) cls = e.live?.waiting ? "waiting" : "running";
		else if (now - at <= 7 * DAY) cls = "stalled";
		if (cls) rows.push({ ...e, cls, at });
	}
	rows.sort((a, b) => CLASS_ORDER.indexOf(a.cls) - CLASS_ORDER.indexOf(b.cls) || b.at - a.at);
	return rows.slice(0, BOARD_MAX);
}

function cut(s: string, width: number): string {
	return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
}

function repoName(r: BoardRow): string {
	const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
	if (r.live?.cwd) return norm(r.live.cwd).pop() ?? "?";
	// A plan dir lives in <repo>/.git/...; show the folder before `.git`.
	const parts = norm(r.dir);
	const g = parts.indexOf(".git");
	return (g > 0 ? parts[g - 1] : parts[parts.length - 1]) ?? "?";
}

function marker(r: BoardRow): string {
	if (r.cls === "finished") return r.status?.finished?.ok ? "✓" : "✗";
	return r.cls === "running" ? "●" : r.cls === "waiting" ? "⏸" : "○";
}

export function boardLines(rows: BoardRow[], selected: number, width: number, now: number): string[] {
	if (!rows.length) return ["No flows in the last 7 days."];
	return rows.map((r, i) => {
		const l = r.live;
		const parts = [marker(r), cut(l?.title ?? r.status?.title ?? r.flowId, 40), repoName(r), l?.phase ?? (r.status?.finished ? "done" : "?")];
		const stage = l?.stage ?? r.status?.stage;
		if (l?.stage !== undefined && l.stages !== undefined) parts.push(`stage ${l.stage}/${l.stages}`);
		else if (stage !== undefined) parts.push(`stage ${stage}`);
		if (l) {
			const done = l.steps.filter((s) => s.done).length;
			parts.push(`${progressBar(done, l.steps.length, 10)} ${done}/${l.steps.length}`);
			const open = l.steps.find((s) => !s.done);
			if (r.status?.finished) parts.push(cut(r.status.finished.text, 30));
			else if (l.waiting) parts.push(`waiting: ${cut(l.waiting, 30)}`);
			else if (open) parts.push(`now ${open.id}`);
		} else {
			parts.push(`${r.status?.done.length ?? 0}/?`);
			parts.push(r.status?.finished ? cut(r.status.finished.text, 30) : "no live data");
		}
		parts.push(ago(now - r.at));
		return cut(`${i === selected ? "▶ " : "  "}${parts.join("  ")}`, width);
	});
}

export function detailLines(row: BoardRow, width: number, now: number): string[] {
	const out: string[] = [];
	const l = row.live;
	out.push(l?.title ?? row.status?.title ?? row.flowId, row.flowId);
	if (!l) {
		out.push(`done: ${row.status?.done.join(", ") || "-"}`);
		if (row.status?.waiting) out.push(`waiting: ${row.status.waiting.reason}`);
		out.push("no live data");
		return out.map((s) => cut(s, width));
	}
	out.push(l.cwd);
	out.push([l.phase, l.stage !== undefined && l.stages !== undefined ? `stage ${l.stage}/${l.stages}` : undefined, `judge round ${l.judgeRound}`, `autopilot ${l.autopilot ? "on" : "off"}`].filter(Boolean).join(" · "));
	const open = l.steps.find((s) => !s.done);
	for (const s of l.steps) out.push(`${s === open ? "▶" : " "} [${s.done ? "x" : " "}] ${s.id} ${s.text}`);
	if (l.waiting) out.push(`waiting: ${l.waiting}`);
	if (l.runs.length) {
		out.push("running:");
		for (const r of l.runs) out.push(`  ${r.role} ${r.label} — ${r.activity}`);
	}
	out.push("recent:");
	for (const e of l.events.slice(-10)) {
		const d = new Date(e.at);
		const hm = Number.isNaN(d.getTime()) ? "--:--" : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		out.push(`  ${hm} ${e.text}`);
	}
	void now;
	return out.map((s) => cut(s, width));
}
