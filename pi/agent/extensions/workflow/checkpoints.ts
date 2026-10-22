/** Checkpoints: deliveries made inside a plan, before the end of a stage or flow. Pure text and rules, kept apart so node tests can reach them. */

type Cap = "off" | "commit" | "push" | "pr" | "merge";
const ORDER = ["commit", "push", "pr", "merge"];

/** Whether `mode` stays within the delivery `cap` (commit < push < pr < merge; off allows nothing). */
export function modeAllowed(mode: string, cap: Cap | string): boolean {
	const m = ORDER.indexOf(mode);
	const c = ORDER.indexOf(cap);
	return m >= 0 && c >= 0 && m <= c;
}

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

/** The amendment an unplanned checkpoint adds to the approved plan. `n` is the number of amendments so far + 1. */
export function checkpointAmendment(n: number, c: { mode?: string; tag?: string; reason: string }): string {
	const what = [c.mode ? `Deliver ${c.mode}` : "", c.tag ? `tag ${c.tag}` : ""].filter(Boolean).join(", ");
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
export function hasCheckpointAmendment(plan: string, c: { mode?: string; tag?: string; reason: string }): boolean {
	const line = checkpointAmendment(0, c).split("\n")[1];
	return plan.split(/\r?\n/).some((l, i, all) => l === line && /^## Amendment \d+ \(executor: checkpoint\)$/.test(all[i - 1] ?? ""));
}

export function checkpointNote(cps: { text: string }[]): string {
	if (!cps.length) return "";
	return `## Checkpoints already delivered\n\n${cps.map((c) => c.text).join("; ")}. Their code is committed and is not in this diff; its absence is not a finding.`;
}

type DeliverMode = "commit" | "push" | "pr" | "merge";

/** The mode and tag a Deliver step names: explicit (`push — …`) or inferred by keyword (merge > pr > push > commit). Null when the step is not a Deliver step. */
export function deliverStepSpec(plan: string, id: string): { mode?: DeliverMode; tag: boolean } | null {
	const text = parseDeliverStep(plan, id);
	if (text === null) return null;
	const tag = /\btag\b/i.test(text);
	const explicit = /^(commit|push|pr|merge)\s*(?:—|–|-|:|$)/i.exec(text);
	if (explicit) return { mode: explicit[1].toLowerCase() as DeliverMode, tag };
	const mode: DeliverMode | undefined = /\bmerge\b/i.test(text) ? "merge" : /\bpr\b|pull request/i.test(text) ? "pr" : /\bpush\b/i.test(text) ? "push" : /\bcommit\b/i.test(text) ? "commit" : undefined;
	return { mode, tag };
}

/** The call the executor makes at a Deliver step, within the delivery `cap`. */
export function deliverHint(id: string, spec: { mode?: string; tag: boolean }, cap: string): string {
	if (cap === "off") return "→ delivery is off for this flow: skip it and say so";
	if (spec.mode && !modeAllowed(spec.mode, cap)) return `→ beyond this flow's delivery (${cap}): call deliver {mode: "${cap}", step: "${id}"} or ask the user`;
	if (!spec.mode) return `→ call deliver {tag: …, step: "${id}"} as the step names it`;
	return `→ call deliver {mode: "${spec.mode}", step: "${id}"${spec.tag ? ", tag: …" : ""}}`;
}

/** The open Deliver steps of the current stage with their calls, as a block; undefined when there are none. */
export function deliverHintsBlock(plan: string, checklist: { id: string; text: string; done: boolean; stage?: number; human?: true }[] | undefined, stage: number | undefined, cap: string): string | undefined {
	const lines: string[] = [];
	for (const i of checklist ?? []) {
		if (i.done || i.human || /^verify\s*:/i.test(i.text)) continue;
		if (stage !== undefined && i.stage !== undefined && i.stage !== stage) continue;
		const spec = deliverStepSpec(plan, i.id);
		if (spec) lines.push(`- ${i.id} ${deliverHint(i.id, spec, cap)}`);
	}
	return lines.length ? `Deliver steps:\n${lines.join("\n")}` : undefined;
}

/** The refusal text for a publish the executor may not run itself. */
export function publishRefusal(problem: string, next: { id: string; hint: string } | null, delivery: string): string {
	const route = delivery === "don't commit"
		? "Delivery is off for this flow: end your turn when the work is done."
		: next
		? `To publish now, call ${next.hint.replace(/^→\s*(call\s+)?/, "")} (the workflow's commit step pushes, opens and merges).`
		: `When the work is done, end your turn: the workflow delivers it as ${delivery} after the judge passes.`;
	return `Refused: ${problem}. ${route} Never ask the user to run it for you.`;
}

const RAW_PUBLISH = /git\s+push|gh\s+pr\s+(?:create|merge)|push\s+--delete/i;

/** Warnings for Deliver steps that name a mode beyond the delivery `cap` or spell out a raw publish command. */
export function deliverStepWarnings(plan: string, capOf: string | ((id: string) => string)): string[] {
	const out: string[] = [];
	for (const m of plan.matchAll(/^[ \t]*(?:[-*][ \t]+)?(?:\[[ xX]\][ \t]*)?\*\*(S[A-Za-z0-9_-]*?)\.?\*\*/gm)) {
		const text = parseDeliverStep(plan, m[1]);
		if (text === null) continue;
		const spec = deliverStepSpec(plan, m[1])!;
		const cap = typeof capOf === "string" ? capOf : capOf(m[1]);
		if (spec.mode && !modeAllowed(spec.mode, cap)) out.push(`${m[1]}: Deliver ${spec.mode} is beyond the delivery (${cap}).`);
		if (RAW_PUBLISH.test(text)) out.push(`${m[1]}: the step spells out a raw publish command; write "Deliver: <mode> — <what>" and let deliver publish.`);
	}
	return out;
}
