/** The approved plan as data: its step checklist, sections, the short plan card sent after a compaction, and the commit step's excerpt. Pure text, kept apart so node tests can reach them. */

import { HEADING } from "./stages.ts";

export interface ChecklistItem {
	/** "S1", "S2", ... numbered across the whole plan. */
	id: string;
	text: string;
	/** The stage heading above the step, when the plan is staged. */
	stage?: number;
	done: boolean;
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
		items.push({ id, text: m[2].replace(/\*\*/g, "").trim().slice(0, 120), ...(stage ? { stage } : {}), done: false });
	}
	return items;
}

/** Re-parses the plan and keeps the ticks of the steps that are still in it. */
export function mergeChecklist(plan: string, old: ChecklistItem[] | undefined): ChecklistItem[] {
	const done = new Set((old ?? []).filter((i) => i.done).map((i) => i.id));
	return parseChecklist(plan).map((i) => ({ ...i, done: done.has(i.id) }));
}

/**
 * The short version of the plan sent after a compaction: goal, decisions, done-when, amendments and the open steps.
 * `stage`/`stageCount`: the current stage of a staged plan (open steps are then that stage's).
 * A plan with neither Goal nor Done when is sent whole.
 */
export function planCard(plan: string, checklist: ChecklistItem[] | undefined, stage?: number, stageCount?: number, path?: string): string {
	const s = planSections(plan);
	if (!s.goal && !s.doneWhen) return `## The approved plan\n\n${plan}`;
	const out = [path ? `## Plan card (full plan: ${path})` : "## Plan card"];
	if (s.goal) out.push(`### Goal and non-goals\n${s.goal}`);
	if (s.decisions) out.push(`### User decisions\n${s.decisions}`);
	if (s.doneWhen) out.push(`### Done when\n${s.doneWhen}`);
	if (s.amendments) out.push(`### Amendments\n${s.amendments.replace(/^## /gm, "#### ")}`);
	if (checklist?.length) {
		const done = checklist.filter((i) => i.done).length;
		const open = checklist.filter((i) => !i.done && (stage === undefined || i.stage === undefined || i.stage === stage));
		const where = stage !== undefined && stageCount ? ` (stage ${stage} of ${stageCount})` : "";
		out.push(`### Open steps${where} — ${done} of ${checklist.length} done\n${open.length ? open.map((i) => `- [ ] ${i.id} ${i.text}`).join("\n") : "(none open)"}`);
	}
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
