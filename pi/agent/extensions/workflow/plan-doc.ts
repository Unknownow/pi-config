/** The approved plan as data: its step checklist, sections, the short plan card sent after a compaction, and the commit step's excerpt. Pure text, kept apart so node tests can reach them. */

import { HEADING } from "./stages.ts";

export interface ChecklistItem {
	/** "S1", "S2", ... numbered across the whole plan. */
	id: string;
	text: string;
	/** The stage heading above the step, when the plan is staged. */
	stage?: number;
	done: boolean;
	/** A check only a person can do (a `Verify:` step): never an open step. */
	human?: true;
}

const VERIFY = /^verify\s*:/i;

/** Whether a step is a human check; also true for checklists saved before the flag existed. */
export function isHuman(i: ChecklistItem): boolean {
	return !!i.human || VERIFY.test(i.text);
}

export interface PlanSections {
	goal?: string;
	decisions?: string;
	doneWhen?: string;
	commits?: string;
	amendments?: string;
}

const SECTION = /^\s*(?:#{1,4}\s*)?\**\s*\d\.\s*\**\s*(Goal|User decisions|Facts|Design|Steps|Tests|Done when|Risks|Commits)\b/i;
const AMENDMENT = /^## (?:Amendment \d+|Plan choices upheld)/;
const ITEM = /^\s*(?:[-*]\s+|\d+[.)]\s+)?\*{0,2}S(\d+)\s*[.:)]\s*\*{0,2}\s*(.*)$/;

interface Section {
	name: string;
	body: string[];
}

function split(plan: string): { sections: Section[]; amendments: string[] } {
	const lines = plan.split(/\r?\n/);
	let cut = lines.findIndex((l) => AMENDMENT.test(l));
	if (cut < 0) cut = lines.length;
	const sections: Section[] = [];
	let cur: Section | undefined;
	for (const line of lines.slice(0, cut)) {
		const m = SECTION.exec(line);
		if (m) {
			cur = { name: m[1].toLowerCase(), body: [] };
			sections.push(cur);
		} else if (cur) cur.body.push(line);
	}
	return { sections, amendments: lines.slice(cut) };
}

const text = (lines: string[] | undefined): string | undefined => {
	const t = lines?.join("\n").trim();
	return t || undefined;
};

/** The sections the plan card and the commit step need; each is the section's body without its header line. */
export function planSections(plan: string): PlanSections {
	const { sections, amendments } = split(plan);
	const find = (name: string) => text(sections.find((s) => s.name === name)?.body);
	return { goal: find("goal"), decisions: find("user decisions"), doneWhen: find("done when"), commits: find("commits"), amendments: text(amendments) };
}

/** The steps written as `**S1.** text` (also `- S2: text`, `3. S3) text`), in the Steps section or, without one, anywhere in the plan. The first of a repeated ID wins. */
export function parseChecklist(plan: string): ChecklistItem[] {
	const { sections } = split(plan);
	const steps = sections.find((s) => s.name === "steps");
	const all = plan.split(/\r?\n/);
	const lines = steps ? steps.body : all;
	const items: ChecklistItem[] = [];
	const seen = new Set<string>();
	// A stage heading above a step names its stage; the Steps section keeps the headings in its body.
	let stage: number | undefined;
	for (const line of lines) {
		const h = HEADING.exec(line.trim());
		if (h) {
			stage = Number(h[1]);
			continue;
		}
		const m = ITEM.exec(line);
		if (!m) continue;
		const id = `S${m[1]}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const text = m[2].replace(/\*\*/g, "").trim().slice(0, 120);
		items.push({ id, text, ...(stage ? { stage } : {}), done: false, ...(VERIFY.test(text) ? { human: true as const } : {}) });
	}
	return items;
}

/** Re-parses the plan and keeps the ticks of the steps that are still in it. */
export function mergeChecklist(plan: string, old: ChecklistItem[] | undefined): ChecklistItem[] {
	const done = new Set((old ?? []).filter((i) => i.done).map((i) => i.id));
	return parseChecklist(plan).map((i) => ({ ...i, done: done.has(i.id) }));
}

/** The reminder line for the unticked steps of the current stage (or unstaged steps), or undefined when none are open. */
export function openStepsReminder(checklist: ChecklistItem[] | undefined, stage?: number): string | undefined {
	const open = (checklist ?? []).filter((i) => !isHuman(i) && !i.done && (stage === undefined || i.stage === undefined || i.stage === stage));
	if (!open.length) return undefined;
	return `Open step${open.length === 1 ? "" : "s"} not ticked: ${open.map((i) => i.id).join(", ")}. Tick the finished ones with \`plan_check\`.`;
}

/**
 * The short version of the plan sent after a compaction: goal, decisions, done-when, amendments and the open steps.
 * `stage`/`stageCount`: the current stage of a staged plan (open steps are then that stage's).
 * A plan with neither Goal nor Done when is sent whole.
 */
export function planCard(plan: string, checklist: ChecklistItem[] | undefined, stage?: number, stageCount?: number, path?: string, waiting?: string): string {
	const s = planSections(plan);
	if (!s.goal && !s.doneWhen) return `## The approved plan\n\n${plan}`;
	const out = [path ? `## Plan card (full plan: ${path})` : "## Plan card"];
	if (s.goal) out.push(`### Goal and non-goals\n${s.goal}`);
	if (s.decisions) out.push(`### User decisions\n${s.decisions}`);
	if (s.doneWhen) out.push(`### Done when\n${s.doneWhen}`);
	if (s.amendments) out.push(`### Amendments\n${s.amendments.replace(/^## /gm, "#### ")}`);
	if (checklist?.length) {
		const own = checklist.filter((i) => !isHuman(i));
		const done = own.filter((i) => i.done).length;
		const open = own.filter((i) => !i.done && (stage === undefined || i.stage === undefined || i.stage === stage));
		const where = stage !== undefined && stageCount ? ` (stage ${stage} of ${stageCount})` : "";
		out.push(`### Open steps${where} — ${done} of ${own.length} done\n${open.length ? open.map((i) => `- [ ] ${i.id} ${i.text}`).join("\n") : "(none open)"}`);
	}
	if (waiting) out.push(`### Waiting for\n${waiting}`);
	if (path) out.push(`Read ${path} for a step's details.`);
	else out.push(`## Full plan (no plan file yet)\n\n${plan}`);
	return out.join("\n\n");
}

/** What the commit step needs of the plan: goal, commits and amendments. null when the plan has no Commits section. */
export function commitPlan(plan: string): string | null {
	const s = planSections(plan);
	if (!s.commits) return null;
	const out = ["## Approved plan (goal and commits)"];
	if (s.goal) out.push(`### Goal and non-goals\n${s.goal}`);
	out.push(`### Commits\n${s.commits}`);
	if (s.amendments) out.push(`### Amendments\n${s.amendments.replace(/^## /gm, "#### ")}`);
	return out.join("\n\n");
}

export interface Finished {
	at: string;
	ok: boolean;
	text: string;
}

export interface PlanStatus {
	v: 1;
	flowId: string;
	rev: number;
	/** ISO time of the last milestone. */
	updated: string;
	title: string;
	stage?: number;
	delivery?: string;
	/** "test": a test-and-fix flow, which cannot be resumed. */
	kind?: "test";
	/** IDs of the ticked steps. */
	done: string[];
	finished?: Finished;
	/** The wait the flow is in, so a resumed flow keeps waiting. */
	waiting?: { reason: string; check?: string; since: string; planned?: boolean; atStageStart?: boolean; held?: string };
	/** Checkpoints delivered mid-plan. */
	checkpoints?: { step?: string; stage?: number; text: string; ok: boolean }[];
	/** Heads the workflow's commit step produced, per repo key: what a later push, pr or merge may publish. */
	judgedHeads?: Record<string, { base: string; head: string; branch: string }>;
	repos: { remote?: string; branch?: string; primary: boolean }[];
}

const FLOW_ID = /^\d{8}-\d{4}-[a-z0-9-]{1,40}-[0-9a-f]{4}$/;
const FILE_HEADER = "<!-- pi-workflow plan v1 flow=";
const STATUS_MARKER = "<!-- pi-workflow:status -->";

export const isFlowId = (s: unknown): s is string => typeof s === "string" && FLOW_ID.test(s);

/** `<yyyymmdd>-<hhmm>-<slug>-<hex4>` in local time. */
export function newFlowId(title: string, now: Date, hex4: string): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "flow";
	return `${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${slug}-${hex4}`;
}

/** The readable plan file: the approved text exactly, then a status block below a marker line. */
export function renderPlanFile(flowId: string, plan: string, checklist: ChecklistItem[] | undefined, finished?: Finished, waiting?: string): string {
	const out = [`${FILE_HEADER}${flowId} -->`, plan, "", STATUS_MARKER];
	const own = (checklist ?? []).filter((i) => !isHuman(i));
	const human = (checklist ?? []).filter(isHuman);
	if (own.length) out.push("## Checklist", ...own.map((i) => `- [${i.done ? "x" : " "}] ${i.id} ${i.text}`));
	if (human.length) out.push("## For you after the flow", ...human.map((i) => `- ${i.id} ${i.text}`));
	if (waiting) out.push(`**Waiting for:** ${waiting}`);
	if (finished) out.push("## Outcome", `${finished.at} — ${finished.ok ? "ok" : "failed"}: ${finished.text}`);
	return `${out.join("\n")}\n`;
}

/** The approved text of a plan file; a text that is not a plan file comes back unchanged. */
export function splitPlanFile(text: string): string {
	if (!text.startsWith(FILE_HEADER)) return text;
	const nl = text.indexOf("\n");
	const rest = nl < 0 ? "" : text.slice(nl + 1);
	const at = rest.lastIndexOf(STATUS_MARKER);
	if (at < 0) return rest;
	const body = rest.slice(0, at);
	return body.endsWith("\n\n") ? body.slice(0, -2) : body.replace(/\n$/, "");
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** null for anything that is not a version-1 status with the right field types. */
export function parseStatus(json: string): PlanStatus | null {
	let o: any;
	try {
		o = JSON.parse(json);
	} catch {
		return null;
	}
	if (!o || typeof o !== "object" || o.v !== 1 || !isFlowId(o.flowId)) return null;
	if (!Number.isInteger(o.rev) || !isStr(o.updated) || !isStr(o.title)) return null;
	if (!Array.isArray(o.done) || !o.done.every(isStr) || !Array.isArray(o.repos)) return null;
	if (o.stage !== undefined && !Number.isInteger(o.stage)) return null;
	if (o.delivery !== undefined && !isStr(o.delivery)) return null;
	const f = o.finished;
	if (f !== undefined && !(f && isStr(f.at) && typeof f.ok === "boolean" && isStr(f.text))) return null;
	const w = o.waiting;
	if (w !== undefined && !(w && isStr(w.reason) && isStr(w.since) && (w.check === undefined || isStr(w.check)) && (w.held === undefined || isStr(w.held)) && (w.planned === undefined || typeof w.planned === "boolean") && (w.atStageStart === undefined || typeof w.atStageStart === "boolean"))) return null;
	const cps = o.checkpoints;
	if (cps !== undefined && !(Array.isArray(cps) && cps.every((c: any) => c && isStr(c.text) && typeof c.ok === "boolean" && (c.step === undefined || isStr(c.step)) && (c.stage === undefined || Number.isInteger(c.stage))))) return null;
	const jh = o.judgedHeads;
	if (jh !== undefined && !(jh && typeof jh === "object" && !Array.isArray(jh) && Object.values(jh).every((h: any) => h && isStr(h.base) && isStr(h.head) && isStr(h.branch)))) return null;
	for (const r of o.repos) {
		if (!r || typeof r.primary !== "boolean" || (r.remote !== undefined && !isStr(r.remote)) || (r.branch !== undefined && !isStr(r.branch))) return null;
	}
	if (o.kind !== "test") delete o.kind;
	return o as PlanStatus;
}

export interface PruneEntry {
	flowId: string;
	/** Epoch ms of the last update. */
	updated: number;
	finished: boolean;
}

/** The plans to delete: finished ones beyond the newest keepCount, and any older than keepDays (0 = no age limit). Never the active one. */
export function pruneIds(entries: PruneEntry[], opts: { keepDays: number; keepCount: number; now: number; activeId?: string }): string[] {
	const rest = entries.filter((e) => e.flowId !== opts.activeId);
	const drop = new Set<string>();
	const finished = rest.filter((e) => e.finished).sort((a, b) => b.updated - a.updated);
	for (const e of finished.slice(opts.keepCount)) drop.add(e.flowId);
	if (opts.keepDays > 0) for (const e of rest) if (opts.now - e.updated > opts.keepDays * 86_400_000) drop.add(e.flowId);
	return [...drop];
}

/** `git@github.com:Org/A.git` and `https://user@GitHub.com/Org/A.git` both become `github.com/Org/A`. */
export function normalizeRemote(url: string): string {
	let u = url.trim();
	const proto = /^[a-z][a-z0-9+.-]*:\/\//i.exec(u);
	if (proto) u = u.slice(proto[0].length);
	u = u.replace(/^[^@/]*@/, "");
	if (!proto) {
		const m = /^([^/:]+):(.*)$/.exec(u);
		if (m) u = `${m[1]}/${m[2].replace(/^\/+/, "")}`;
	}
	u = u.replace(/\/+$/, "").replace(/\.git$/, "");
	const slash = u.indexOf("/");
	return slash < 0 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash);
}
