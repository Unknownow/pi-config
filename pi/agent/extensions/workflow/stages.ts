import { cleanCheck, parseWaitStep, waitCheckProblem } from "./waits.ts";

/** Staged plans: a plan split into `### Stage N: <title>` sections is executed, judged and delivered one stage at a time. Pure text and decisions, kept apart so node tests can reach them. */

export interface PlanStage {
	/** 1-based, in plan order. */
	n: number;
	title: string;
	/** A person's action the stage waits for before it starts, from a trailing `(after: <what>; check: <command>)` on its heading. */
	after?: { reason: string; check?: string };
}

export const HEADING = /^#{2,4}\s*[*_]*Stage\s+(\d+)[*_]*\s*[:.\u2013\u2014-]\s*(.*?)\s*[*_]*\s*$/i;
const TAG = /\s*\(\s*deliver(?:y)?\s*:\s*([a-z]+)\s*\)\s*$/i;
const AFTER = /\s*\(\s*after\s*:\s*([^;)]*?)\s*(?:;\s*check\s*:\s*([^)]*?)\s*)?\)\s*$/i;

/**
 * The plan's stages: `##`-`####` headings "Stage N: title", optionally ending in "(after: …)". A trailing "(delivery: …)" of older plans is ignored.
 * A number seen before is skipped (an arbiter amendment may repeat a heading). The numbers must run
 * 1, 2, 3, ... in order and there must be at least two, else it is not a staged plan: [].
 */
export function parseStages(plan: string | undefined): PlanStage[] {
	const stages: PlanStage[] = [];
	const seen = new Set<number>();
	for (const line of (plan ?? "").split(/\r?\n/)) {
		const m = HEADING.exec(line.trim());
		if (!m) continue;
		const n = Number(m[1]);
		if (seen.has(n)) continue;
		seen.add(n);
		let title = m[2];
		let after: PlanStage["after"];
		// The two tags may come in either order; strip them from the end.
		for (let i = 0; i < 2; i++) {
			const tag = TAG.exec(title);
			const aft = tag ? null : AFTER.exec(title);
			if (tag) {
				title = title.slice(0, tag.index);
			} else if (aft) {
				title = title.slice(0, aft.index);
				if (aft[1].trim()) {
					const check = cleanCheck(aft[2]);
					after = { reason: aft[1].trim(), ...(check ? { check } : {}) };
				}
			} else break;
		}
		stages.push({ n, title: title.replace(/[*_\s]+$/, "").trim(), ...(after ? { after } : {}) });
	}
	if (stages.length < 2 || stages.some((s, i) => s.n !== i + 1)) return [];
	return stages;
}

/** What is wrong with the wait checks of a plan (stage `(after:)` checks and `Wait:` steps), one line each; [] when they are fine. */
export function planWaitProblems(plan: string, isReadOnly: (c: string) => string | null): string[] {
	const out: string[] = [];
	const add = (label: string, check: string | undefined): void => {
		if (!check) return;
		const problem = waitCheckProblem(check) ?? isReadOnly(check);
		if (problem) out.push(`${label}: ${problem}: ${check}`);
	};
	for (const s of parseStages(plan)) add(`Stage ${s.n} check`, s.after?.check);
	const seen = new Set<string>();
	for (const m of plan.matchAll(/\*\*(S\d+)\.?\*\*[ \t]*Wait\s*:/gi)) {
		if (seen.has(m[1])) continue;
		seen.add(m[1]);
		add(`${m[1]} check`, parseWaitStep(plan, m[1])?.check);
	}
	return out;
}

/** The instruction to do stage `current` only, then hand over. */
export function stageStart(stages: PlanStage[], current: number): string {
	const s = stages[current - 1];
	const rest = current < stages.length ? " The workflow then sends you the next stage." : " This is the last stage.";
	return `This plan has ${stages.length} stages. Do stage ${current} only: "${s.title}". Don't start a later stage. When it is done, run its tests and call \`judge\`. Once it passes, deliver the stage yourself as the plan says (commit, push, pull request, merge), tick its steps and end your turn.${rest}`;
}

/** The message that starts stage `current` after the previous one was delivered. */
export function nextStage(stages: PlanStage[], current: number, outcome: string): string {
	const prev = stages[current - 2];
	return `Stage ${current - 1} ("${prev.title}") is delivered: ${outcome}.\n\nCheck \`git status\` and the current branch before you change anything. ${stageStart(stages, current)}`;
}

/** One line for the executor's system prompt while a staged plan runs. */
export function stageLine(stages: PlanStage[], current: number): string {
	return `- Current stage: ${current} of ${stages.length}, "${stages[current - 1].title}". Work on this stage only; earlier stages are delivered, later ones are not started.`;
}

/** For the judge and the arbiter: which part of the plan this diff covers. */
export function stageNote(stages: PlanStage[], current: number): string {
	const s = stages[current - 1];
	const before = current > 1 ? ` Stages 1-${current - 1} are already done; any of their code still uncommitted may appear in this diff and is not a finding.` : "";
	const after = current < stages.length ? ` Stages ${current + 1}-${stages.length} are not started: their steps missing from this diff is not a finding.` : "";
	return `## Stage under review\n\nThe plan is delivered in ${stages.length} stages. This diff is stage ${current}: "${s.title}".${before}${after} Judge this diff against the plan's target as far as stage ${current} reaches, and against stage ${current}'s steps.`;
}

/** The flow's outcome over its delivered stages. */
export function stagesOutcome(parts: { text: string; ok: boolean }[], total: number): { text: string; ok: boolean } {
	const text = parts.map((p, i) => `stage ${i + 1}: ${p.text}`).join("; ");
	const done = parts.length === total;
	return { text: done ? text : `stopped after stage ${parts.length} of ${total}: ${text}`, ok: done && parts.every((p) => p.ok) };
}
