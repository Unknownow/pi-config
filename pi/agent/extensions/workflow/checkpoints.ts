/** Checkpoints: tags created inside a plan, before the end of a stage or flow. Pure text and rules, kept apart so node tests can reach them. */
import { parseMirrorStep, parsePublishStep } from "./registry-publish.ts";

/** The text after `Deliver:` of plan step `id`, or null when the step is not a Deliver step. */
export function parseDeliverStep(plan: string, id: string): string | null {
	const escaped = id.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
	const line = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\[[ xX]\\][ \\t]*)?\\*\\*${escaped}\\.?\\*\\*[ \\t]*(.*)$`, "m").exec(plan);
	if (!line) return null;
	const m = /^deliver\s*:\s*(.*)$/i.exec(line[1].trim());
	return m ? m[1].trim() : null;
}

/** A tag is planned when the Deliver step names it; a move also needs the word "move". */
export function isPlannedTag(stepText: string | null, name: string, move: boolean): boolean {
	if (stepText === null || !name || !stepText.includes(name)) return false;
	return !move || /\bmove\b/i.test(stepText);
}

/** The amendment an unplanned tag checkpoint adds to the approved plan. `n` is the number of amendments so far + 1. */
export function checkpointAmendment(n: number, c: { tag?: string; reason: string }): string {
	const what = c.tag ? `tag ${c.tag}` : "tag";
	return `## Amendment ${n} (executor: checkpoint)\n${what} — ${c.reason}`;
}

export function checkpointText(step: string | undefined, outcome: string): string {
	return `checkpoint ${step ?? "unplanned"}: ${outcome}`;
}

export function withCheckpoints(parts: string[], end: string): string {
	return [...parts, end].join("; ");
}

/** The outcome of a stage or flow whose remaining changes were all delivered by checkpoints; null without checkpoints. */
export function checkpointOutcome(cps: { text: string; ok: boolean }[]): { text: string; ok: boolean } | null {
	if (!cps.length) return null;
	return { text: withCheckpoints(cps.map((c) => c.text), "no further changes"), ok: cps.every((c) => c.ok) };
}

/** Whether an unplanned checkpoint is already in the plan, so a retried `deliver` call adds no second amendment. */
export function hasCheckpointAmendment(plan: string, c: { tag?: string; reason: string }): boolean {
	const line = checkpointAmendment(0, c).split("\n")[1];
	return plan.split(/\r?\n/).some((l, i, all) => l === line && /^## Amendment \d+ \(executor: checkpoint\)$/.test(all[i - 1] ?? ""));
}

export function checkpointNote(cps: { text: string }[]): string {
	if (!cps.length) return "";
	return `## Checkpoints already delivered\n\n${cps.map((c) => c.text).join("; ")}. Their code is committed and is not in this diff; its absence is not a finding.`;
}

/** Whether a Deliver step names a tag. Other Deliver steps (commit, push, pull request, merge) are plain steps the executor does with git and gh. Null when the step is not a Deliver step. */
export function deliverStepSpec(plan: string, id: string): { tag: boolean } | null {
	const text = parseDeliverStep(plan, id);
	if (text === null) return null;
	return { tag: /\btag\b/i.test(text) };
}

/** The call the executor makes at a Deliver step that names a tag; "" for any other Deliver step. */
export function deliverHint(id: string, spec: { tag: boolean }): string {
	return spec.tag ? `→ call deliver {tag: …, step: "${id}"} as the step names it` : "";
}

/** The open tag Deliver steps of the current stage with their calls, as a block; undefined when there are none. */
export function deliverHintsBlock(plan: string, checklist: { id: string; text: string; done: boolean; stage?: number; human?: true }[] | undefined, stage: number | undefined): string | undefined {
	const lines: string[] = [];
	for (const i of checklist ?? []) {
		if (i.done || i.human || /^verify\s*:/i.test(i.text)) continue;
		if (stage !== undefined && i.stage !== undefined && i.stage !== stage) continue;
		const spec = deliverStepSpec(plan, i.id);
		const hint = spec ? deliverHint(i.id, spec) : "";
		if (hint) lines.push(`- ${i.id} ${hint}`);
	}
	return lines.length ? `Deliver steps:\n${lines.join("\n")}` : undefined;
}

/** Whether a Deliver step asks for a merge ("Deliver: merge — …"); "no merge" and tag steps do not. */
export function isMergeDeliver(plan: string, id: string): boolean {
	const t = parseDeliverStep(plan, id);
	return t !== null && /\bmerge\b/i.test(t) && !/\bno merge\b/i.test(t);
}

/** Whether the current stage (the whole plan when `stage` is undefined) has an unticked `Deliver: merge` step. */
export function deliverMergeOpen(plan: string, checklist: { id: string; text: string; done: boolean; stage?: number; human?: true }[] | undefined, stage: number | undefined): boolean {
	for (const i of checklist ?? []) {
		if (i.done || i.human || /^verify\s*:/i.test(i.text)) continue;
		if (stage !== undefined && i.stage !== undefined && i.stage !== stage) continue;
		if (isMergeDeliver(plan, i.id)) return true;
	}
	return false;
}

export interface MergeDecision {
	allowed: boolean;
	by: "arbiter" | "user";
	/** 0: the whole flow (an unstaged plan). */
	stage: number;
	reason: string;
}

/** The amendment that records a decision about a merge before the end of the flow. `n` is the number of amendments so far + 1. */
export function mergeAmendment(n: number, d: MergeDecision): string {
	const where = d.stage ? `stage ${d.stage}` : "this flow";
	const reason = d.reason.replace(/\s+/g, " ").trim() || "no reason given";
	return `## Amendment ${n} (${d.by}: ${d.allowed ? "merge" : "no merge"})\nMerge ${d.allowed ? "allowed" : "refused"} in ${where}: ${reason}`;
}

/** The merge decisions recorded in the approved plan, in order. */
export function mergeDecisions(plan: string | undefined): MergeDecision[] {
	const out: MergeDecision[] = [];
	const re = /^## Amendment \d+ \((arbiter|user): (merge|no merge)\)[ \t]*\r?\nMerge (?:allowed|refused) in (?:stage (\d+)|this flow):[ \t]*(.*)$/gm;
	for (const m of (plan ?? "").matchAll(re)) out.push({ allowed: m[2] === "merge", by: m[1] as "arbiter" | "user", stage: m[3] ? Number(m[3]) : 0, reason: m[4].trim() });
	return out;
}

/** One entry per merge decision for the flow outcome; "" when there are none. */
export function mergeDecisionsText(plan: string | undefined): string {
	return mergeDecisions(plan)
		.map((d) => `mid-flow merge ${d.allowed ? "allowed" : "refused"} by ${d.by} (${d.stage ? `stage ${d.stage}` : "whole flow"}): ${d.reason}`)
		.join("; ");
}

/** Whether a step can only run after the final merge: a non-merge Deliver step (a tag), a Publish step or a Mirror step. */
export function afterMergeStep(plan: string, id: string): boolean {
	if (parseDeliverStep(plan, id) !== null) return !isMergeDeliver(plan, id);
	return parsePublishStep(plan, id) !== null || parseMirrorStep(plan, id) !== null;
}

/** The ids of the open steps the merge gate counts: the unticked, non-human steps of the current stage; at the end of the flow without the steps that run after the merge. */
export function gateOpenSteps(plan: string, checklist: { id: string; text: string; done: boolean; stage?: number; human?: true }[] | undefined, staged: { current: number; total: number } | undefined): string[] {
	const atEnd = !staged || staged.current >= staged.total;
	return (checklist ?? [])
		.filter((i) => !i.human && !/^verify\s*:/i.test(i.text) && !i.done && (!staged || i.stage === undefined || i.stage === staged.current) && !(atEnd && afterMergeStep(plan, i.id)))
		.map((i) => i.id);
}

/** The refusal text for a command the executor may not run. */
export function publishRefusal(problem: string): string {
	return `Refused: ${problem}.`;
}
