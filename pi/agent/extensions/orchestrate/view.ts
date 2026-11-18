/** The run as data and as text lines: view.json, the widget rows and the /orch board. Pure; `paint(kind, text)` adds color. */

import type { Run, Sub } from "./brief.ts";
import { isLive, type Item } from "./items.ts";
import { split } from "./repos.ts";
import { phaseLabel } from "./plan-judge.ts";
import type { Message, Status } from "./store.ts";

export type Paint = (kind: "accent" | "dim" | "warn" | "ok" | "err" | "plain", text: string) => string;
export const plain: Paint = (_k, t) => t;

export interface Pending {
	kind: "question" | "plan" | "accept" | "menu" | "wait" | "idle";
	ref: string;
	text: string;
	repo?: string;
	/** menu: the workflow's key. */
	key?: string;
	/** The orchestrator escalated it: the user must answer. */
	escalated?: boolean;
	/** wait: an external wait that resumes by itself. */
	parked?: true;
}

export interface ViewRepo {
	key: string;
	files: number;
	drift: string[];
	pr?: "merged" | "not merged" | "unknown";
}

export interface ViewSub {
	id: string;
	state: string;
	phase: string;
	judging?: "discussion" | "plan";
	done?: number;
	total?: number;
	waiting: boolean;
	heartbeat?: number;
	offline: boolean;
	stalled: boolean;
	dependsOn: string[];
	goal: string;
	criteria: string[];
	owns: string[];
	forbids: string[];
	accepted: string[];
	repos: ViewRepo[];
	overlap: string[];
	pending: Pending[];
	recent: Array<{ dir: "in" | "out"; type: string; text: string; ts: string }>;
}

export interface View {
	v: 1;
	runId: string;
	title: string;
	updated: string;
	maxSubs: number;
	/** Escalated items that wait for the user. */
	waitingForUser?: number;
	subs: ViewSub[];
}

/** What is still unanswered: questions without an answer, plans without a verdict, accept-requests without a verdict of the same tree and repo. `outbox` is sub → orchestrator, `inbox` the reverse. */
export function pendingOf(outbox: Message[], inbox: Message[]): Pending[] {
	const out: Pending[] = [];
	// a newer plan-review or accept-request (per repo) supersedes the older ones: only the latest can still get a verdict
	const latestPlan = [...outbox].reverse().find((m) => m.type === "plan-review");
	const latestAccept = new Map<string, Message>();
	for (const m of outbox) if (m.type === "accept-request") latestAccept.set(String(m.data?.repo ?? ""), m);
	for (const m of outbox) {
		if (m.type === "plan-review" && m !== latestPlan) continue;
		if (m.type === "accept-request" && latestAccept.get(String(m.data?.repo ?? "")) !== m) continue;
		if (m.type === "question") {
			if (!inbox.some((x) => x.type === "answer" && x.replyTo === m.id)) out.push({ kind: "question", ref: m.id, text: m.text });
		} else if (m.type === "plan-review") {
			const n = m.data?.n;
			if (!inbox.some((x) => x.type === "plan-verdict" && x.data?.n === n)) out.push({ kind: "plan", ref: String(n ?? "?"), text: m.text });
		} else if (m.type === "accept-request") {
			const tree = String(m.data?.tree ?? "");
			const repo = String(m.data?.repo ?? "");
			if (!inbox.some((x) => x.type === "accept-verdict" && String(x.data?.tree ?? "") === tree && String(x.data?.repo ?? "") === repo)) out.push({ kind: "accept", ref: tree, text: m.text, repo });
		}
	}
	return out;
}

/** The pending list from items.json: one entry per live item. */
export function pendingFromItems(items: Item[]): Pending[] {
	return items.filter(isLive).map((i): Pending => {
		const escalated = i.state === "escalated" ? true : undefined;
		const base = { text: i.summary, escalated, ...(i.parked ? { parked: true as const } : {}) };
		if (i.kind === "plan-review") return { kind: "plan", ref: String(i.n ?? i.ref), ...base };
		if (i.kind === "accept-request") return { kind: "accept", ref: i.tree ?? i.ref, repo: i.repo ?? "", ...base };
		if (i.kind === "menu") return { kind: "menu", ref: i.ref, key: i.key, ...base };
		return { kind: i.kind, ref: i.ref, ...base };
	});
}

export interface SubInput {
	status?: Status;
	files?: string[];
	drift?: string[];
	overlap?: string[];
	stalled?: boolean;
	outbox: Message[];
	inbox: Message[];
	accepted: string[];
	/** The live items of the package (items.json); when given, they replace the pending list derived from the files. */
	items?: Item[];
	/** repo key → last known PR state */
	prs?: Map<string, "merged" | "not merged" | "unknown">;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildView(run: Run, now: number, maxSubs: number, inputs: Map<string, SubInput>, offlineSeconds: number): View {
	const multi = !!run.repos?.length;
	const keyOf = (f: string): { key: string; path: string } => (multi ? split(f) : { key: "", path: f });
	const subs: ViewSub[] = run.subs.map((s: Sub) => {
		const i = inputs.get(s.id) ?? { outbox: [], inbox: [], accepted: [] };
		const keys = s.repos?.length ? s.repos : [run.repos?.[0]?.key ?? ""];
		const count = new Map<string, number>();
		for (const f of i.files ?? []) {
			const k = keyOf(f).key;
			count.set(k, (count.get(k) ?? 0) + 1);
		}
		const drift = new Map<string, string[]>();
		for (const f of i.drift ?? []) {
			const k = keyOf(f);
			drift.set(k.key, [...(drift.get(k.key) ?? []), k.path]);
		}
		const all = [...new Set([...keys, ...count.keys(), ...drift.keys()])];
		const hb = i.status?.heartbeat;
		const recent = [
			...i.outbox.map((m) => ({ dir: "out" as const, type: m.type, text: clip(m.text, 120), ts: m.ts })),
			...i.inbox.map((m) => ({ dir: "in" as const, type: m.type, text: clip(m.text, 120), ts: m.ts })),
		];
		const last = (d: "in" | "out") => recent.filter((r) => r.dir === d).slice(-5);
		const active = ["spawning", "spawned", "planning", "executing", "awaiting-acceptance"].includes(s.state);
		return {
			id: s.id,
			state: s.state,
			phase: i.status?.phase ?? "-",
			judging: i.status?.judging,
			done: i.status?.done,
			total: i.status?.total,
			waiting: i.status?.waiting === true,
			heartbeat: hb,
			offline: active && hb !== undefined && now - hb > offlineSeconds * 1000,
			stalled: i.stalled === true,
			dependsOn: s.dependsOn,
			goal: s.goal,
			criteria: s.criteria,
			owns: s.owns,
			forbids: s.forbids,
			accepted: i.accepted,
			repos: all.map((k) => ({ key: k, files: count.get(k) ?? 0, drift: drift.get(k) ?? [], pr: i.prs?.get(k) })),
			overlap: i.overlap ?? [],
			pending: s.state === "merged" || s.state === "stopped" ? [] : i.items ? pendingFromItems(i.items) : pendingOf(i.outbox, i.inbox),
			recent: [...last("out"), ...last("in")].sort((a, b) => a.ts.localeCompare(b.ts)),
		};
	});
	const waitingForUser = subs.reduce((n, s) => n + s.pending.filter((p) => p.escalated).length, 0);
	return { v: 1, runId: run.id, title: run.title, updated: new Date(now).toISOString(), maxSubs, ...(waitingForUser ? { waitingForUser } : {}), subs };
}

/** The part of a view that decides whether view.json is rewritten (everything but `updated`). */
export const viewSig = (v: View): string => JSON.stringify({ ...v, updated: "" });

type Seg = [Parameters<Paint>[0], string];

/** Joins segments, cut to `width` characters before coloring. */
function fit(segs: Seg[], width: number, paint: Paint): string {
	let left = Math.max(0, width);
	let out = "";
	for (const [k, t] of segs) {
		if (left <= 0) break;
		const cut = t.length > left ? t.slice(0, Math.max(0, left - 1)) + "…" : t;
		out += paint(k, cut);
		left -= cut.length;
	}
	return out;
}

export const pendingMark = (p: Pending): string => {
	if (p.escalated) return `‼ you: ${p.kind === "plan" ? `plan ${p.ref}` : p.kind === "accept" ? `accept ${p.ref.slice(0, 7)}` : p.kind === "menu" ? `menu ${p.key ?? p.ref}` : p.ref}`;
	if (p.kind === "question") return "? question";
	if (p.kind === "plan") return `plan ${p.ref} review`;
	if (p.kind === "menu") return `menu ${p.key ?? ""}`.trim();
	if (p.kind === "wait" && p.parked) return "wait (resumes itself)";
	if (p.kind === "wait" || p.kind === "idle") return p.kind;
	return `⚠ accept ${p.repo ? `${p.repo} ` : ""}${p.ref.slice(0, 7)}`;
};

export function widgetLines(view: View | null, mode: string, _now: number, paint: Paint = plain, width = 120, judging?: string): string[] {
	if (!view) {
		if (mode === "discuss" || mode === "propose") return [fit([["accent", `orch ▸ ${phaseLabel(mode, judging)}`]], width, paint)];
		if (mode === "run") return [fit([["accent", "orch ▸ run"], ["dim", " (no data yet)"]], width, paint)];
		return [];
	}
	const running = view.subs.filter((s) => ["spawning", "spawned", "planning", "executing", "awaiting-acceptance"].includes(s.state)).length;
	const head: Seg[] = [["accent", `orch ${view.runId} ▸ ${mode === "off" ? "watching" : phaseLabel(mode, judging)}`], ["dim", `  ${running}/${view.maxSubs} running`]];
	if (view.waitingForUser) head.push(["err", `  ${view.waitingForUser} waiting for you`]);
	const lines = [fit(head, width, paint)];
	for (const s of view.subs) {
		const segs: Seg[] = [["plain", s.id.padEnd(12)]];
		const keys = s.repos.map((r) => r.key).filter(Boolean);
		if (keys.length) segs.push(["dim", ` [${keys.join(",")}]`]);
		segs.push([s.state === "merged" ? "ok" : "plain", ` ${s.state}`]);
		segs.push(["dim", ` ${phaseLabel(s.phase, s.judging)}${s.total ? ` ${s.done ?? 0}/${s.total}` : ""}`]);
		for (const p of s.pending) segs.push(["warn", ` ${pendingMark(p)}`]);
		const files = s.repos.filter((r) => r.files).map((r) => `${r.key ? `${r.key}:` : ""}${r.files}`);
		if (files.length) segs.push(["dim", ` files ${files.join(" ")}`]);
		if (s.repos.some((r) => r.drift.length)) segs.push(["err", " drift"]);
		if (s.overlap.length) segs.push(["err", " overlap"]);
		if (s.offline) segs.push(["err", " offline"]);
		if (s.stalled) segs.push(["warn", " stalled"]);
		if (s.dependsOn.length && s.state === "planned") segs.push(["dim", ` (after ${s.dependsOn.join(",")})`]);
		lines.push(fit(segs, width, paint));
	}
	return lines;
}

const ago = (ms: number | undefined, now: number): string => (ms === undefined ? "-" : `${Math.max(0, Math.round((now - ms) / 1000))}s ago`);

export function detailOf(s: ViewSub, now: number): string[] {
	const out = [`${s.id}: ${s.state}, phase ${phaseLabel(s.phase, s.judging)}${s.total ? ` ${s.done ?? 0}/${s.total}` : ""}${s.waiting ? " (waiting)" : ""}, beat ${ago(s.heartbeat, now)}`, `goal: ${s.goal}`];
	if (s.criteria.length) out.push("criteria:", ...s.criteria.map((c) => `  - ${c}`));
	out.push(`owns: ${s.owns.join(", ") || "-"}`);
	if (s.forbids.length) out.push(`forbids: ${s.forbids.join(", ")}`);
	if (s.dependsOn.length) out.push(`after: ${s.dependsOn.join(", ")}`);
	for (const r of s.repos) out.push(`repo ${r.key || "(working)"}: ${r.files} files${r.drift.length ? `, drift ${r.drift.slice(0, 5).join(", ")}` : ""}, PR ${r.pr ?? "-"}`);
	if (s.overlap.length) out.push(`overlap: ${s.overlap.slice(0, 5).join(", ")}`);
	if (s.pending.length) out.push("pending:", ...s.pending.map((p) => `  ${pendingMark(p)}: ${clip(p.text, 100)}`));
	if (s.accepted.length) out.push(`accepted: ${s.accepted.map((t) => t.slice(0, 12)).join(", ")}`);
	if (s.recent.length) out.push("recent:", ...s.recent.map((m) => `  ${m.dir === "in" ? "←" : "→"} ${m.type}: ${m.text}`));
	return out;
}

/** The board: a list on the left and the selected package on the right; `detail` shows the package alone. */
export function boardLines(view: View, selected: number, detail: boolean, width: number, now: number, paint: Paint = plain): string[] {
	if (!view.subs.length) return [fit([["dim", "no packages"]], width, paint)];
	const sel = Math.min(Math.max(0, selected), view.subs.length - 1);
	if (detail) return detailOf(view.subs[sel], now).map((l) => fit([["plain", l]], width, paint));
	const leftW = Math.min(32, Math.max(12, Math.floor(width / 3)));
	const left = view.subs.map((s, i) => ({ text: `${i === sel ? "▸" : " "} ${s.id} ${s.state}${s.pending.some((p) => p.escalated) ? " ‼" : s.pending.length ? " !" : ""}`, on: i === sel }));
	const right = detailOf(view.subs[sel], now);
	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		const l = left[i];
		const lt = l ? (l.text.length > leftW ? l.text.slice(0, leftW - 1) + "…" : l.text.padEnd(leftW)) : " ".repeat(leftW);
		out.push(fit([[l?.on ? "accent" : "plain", lt], ["dim", " │ "], ["plain", right[i] ?? ""]], width, paint));
	}
	return out;
}
