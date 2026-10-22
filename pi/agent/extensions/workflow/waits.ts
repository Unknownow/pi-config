/** Wait points: a flow pauses for a person (publish a package, open an Editor) and then continues the same plan. Human checks (test in the Editor, look at visuals) never pause: they are listed after the flow. Pure text and decisions, kept apart so node tests can reach them. */

import type { ChecklistItem } from "./plan-doc.ts";

export interface WaitSpec {
	reason: string;
	/** A read-only command that exits 0 once the wait is over. */
	check?: string;
}

const CHECK = /\s*\(\s*check\s*:\s*([^)]*)\)\s*\.?\s*$/i;

/** The wait a plan step declares: its full line (not the shortened checklist text) must read `**S<n>.** Wait: <what> [(check: <command>)]`. */
export function parseWaitStep(plan: string, id: string): WaitSpec | null {
	const escaped = id.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
	const line = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\[[ xX]\\][ \\t]*)?\\*\\*${escaped}\\.?\\*\\*[ \\t]*(.*)$`, "m").exec(plan);
	if (!line) return null;
	const m = /^wait\s*:\s*(.*)$/i.exec(line[1].trim());
	if (!m) return null;
	let text = m[1].trim();
	let check: string | undefined;
	const c = CHECK.exec(text);
	if (c) {
		text = text.slice(0, c.index).trim();
		check = c[1].trim() || undefined;
	}
	if (!text) return null;
	return { reason: text, ...(check ? { check } : {}) };
}

/** The amendment an unplanned wait adds to the approved plan. `n` is the number of amendments so far + 1. */
export function waitAmendment(n: number, w: { reason: string; step?: string; check?: string }): string {
	return `## Amendment ${n} (executor: wait)\n${w.reason}${w.step ? ` (step ${w.step})` : ""}${w.check ? ` (check: ${w.check})` : ""}`;
}

export interface VerifySpec {
	steps: string;
	lookFor?: string;
}

/** The human check a plan step declares: `**S<n>.** Verify: <steps> [— look for: <what>]` or `(look for: <what>)`. */
export function parseVerifyStep(plan: string, id: string): VerifySpec | null {
	const escaped = id.replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
	const line = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\[[ xX]\\][ \\t]*)?\\*\\*${escaped}\\.?\\*\\*[ \\t]*(.*)$`, "m").exec(plan);
	if (!line) return null;
	const m = /^verify\s*:\s*(.*)$/i.exec(line[1].trim());
	if (!m) return null;
	let text = m[1].trim();
	let lookFor: string | undefined;
	const paren = /\s*\(\s*look for\s*:\s*([^)]*)\)\s*\.?\s*$/i.exec(text);
	const dash = /\s+[—-]\s*look for\s*:\s*(.*)$/i.exec(text);
	const c = paren ?? dash;
	if (c) {
		text = text.slice(0, c.index).trim();
		lookFor = c[1].trim() || undefined;
	}
	if (!text) return null;
	return { steps: text, ...(lookFor ? { lookFor } : {}) };
}

/** The amendment an unplanned human check adds to the approved plan. */
export function verifyAmendment(n: number, v: { steps: string; lookFor?: string; step?: string }): string {
	return `## Amendment ${n} (executor: verify)\n${v.steps}${v.lookFor ? ` — look for: ${v.lookFor}` : ""}${v.step ? ` (step ${v.step})` : ""}`;
}

export interface HumanCheck {
	id?: string;
	text: string;
}

/** The human checks of a flow: the Verify steps in plan order, then the verify amendments (not those of a step already listed). */
export function humanChecks(plan: string | undefined, checklist: ChecklistItem[] | undefined): HumanCheck[] {
	const out: HumanCheck[] = [];
	const ids = new Set<string>();
	for (const i of checklist ?? []) {
		if (!i.human && !/^verify\s*:/i.test(i.text)) continue;
		ids.add(i.id);
		out.push({ id: i.id, text: i.text.replace(/^verify\s*:\s*/i, "").trim() });
	}
	const blocks = (plan ?? "").split(/\r?\n/);
	for (let k = 0; k < blocks.length; k++) {
		if (!/^## Amendment \d+ \(executor: verify\)/.test(blocks[k])) continue;
		const body: string[] = [];
		for (k++; k < blocks.length && !/^## /.test(blocks[k]); k++) if (blocks[k].trim()) body.push(blocks[k].trim());
		k--;
		let text = body.join(" ").trim();
		const s = /\s*\(step (S\d+)\)\s*$/.exec(text);
		let id: string | undefined;
		if (s) {
			id = s[1];
			text = text.slice(0, s.index).trim();
		}
		if (id && ids.has(id)) continue;
		if (id) ids.add(id);
		if (text) out.push({ ...(id ? { id } : {}), text });
	}
	return out;
}

/** The start of the message that resumes a flow after its wait. */
export function resumePrefix(reason: string, how: "passed" | "forced" | "plain"): string {
	if (how === "passed") return `The wait for "${reason}" is over (check passed).`;
	if (how === "forced") return `The wait for "${reason}" is over (you continued without the check passing).`;
	return `The wait for "${reason}" is over.`;
}

/** What a poll tick does: stop polling, hold (the session is busy) or run the check. */
export function pollDecision(o: { waiting: boolean; hasCheck: boolean; idle: boolean; elapsedMs: number; maxMs: number }): "run" | "hold" | "stop" {
	if (!o.waiting || !o.hasCheck || o.elapsedMs >= o.maxMs) return "stop";
	return o.idle ? "run" : "hold";
}

/** What a check run gave: the exit data, or an error when the check could not start at all. */
export type CheckRun = { code: number; stderr: string; killed: boolean } | { error: string };
export interface CheckVerdict { status: "pass" | "fail" | "broken"; detail?: string }

/** Classifies a check run: pass (exit 0), fail ("not yet") or broken (no shell, exit 126/127, "command not found"). */
export function checkVerdict(r: CheckRun, timeoutMs: number): CheckVerdict {
	if ("error" in r) return { status: "broken", detail: r.error };
	if (r.killed) return { status: "fail", detail: `timed out after ${timeoutMs / 1000} s` };
	if (r.code === 0) return { status: "pass" };
	const last = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200);
	const tail = last ? `: ${last}` : "";
	if (r.code === 126 || r.code === 127 || /command not found/i.test(r.stderr)) return { status: "broken", detail: `exit ${r.code}${tail}` };
	return { status: "fail", detail: `exit ${r.code}${tail}` };
}

/** The title of the menu shown when a typed message meets a check that is not passing. */
export function checkTitle(v: CheckVerdict, check: string): string {
	if (v.status === "broken") return `Check can't run (${v.detail}): ${check}`;
	return v.detail ? `Check not passing (${v.detail}): ${check}` : `Check not passing: ${check}`;
}

/** The amendment a self-resolved (autopilot) wait adds to the approved plan. */
export function autopilotAmendment(n: number, w: { reason: string; step?: string; kind: "approve" | "act" }): string {
	return `## Amendment ${n} (executor: autopilot)\n${w.reason} (${w.step ? `step ${w.step}, ` : ""}${w.kind})`;
}

/** What wait_for_user tells the agent to do instead of pausing, when autopilot is on. */
export function autopilotReply(kind: "approve" | "act", reason: string, check?: string): string {
	const checkLine = check ? `Then run the check and make sure it passes: ${check}\n` : "";
	if (kind === "approve") {
		return (
			`Autopilot is on: do not wait for "${reason}". Resolve it yourself.\n` +
			"Review the item against the plan and your findings. If it holds, post the approval as a comment where the person was asked to reply. Use the word the check looks for, and mark it as the autopilot's, for example:\n" +
			'gh issue comment <n> -R <owner/repo> --body "approved (workflow autopilot): <one-line reason>"\n' +
			"Without a check, post a comment only if the plan or the reason names an issue or PR.\n" +
			checkLine +
			"Tick the step with plan_check and continue in this turn.\n" +
			"If the review finds something the user must decide, call wait_for_user again with manual: true and say why."
		);
	}
	return (
		`Autopilot is on: do not wait for "${reason}". Resolve it yourself.\n` +
		"If a non-interactive command can do it and the repo's AGENTS.md/CLAUDE.md allow the agent to run it, do it now.\n" +
		checkLine +
		"Tick the step with plan_check and continue in this turn.\n" +
		"Otherwise call wait_for_user again with manual: true; the workflow polls the check and resumes you.\n" +
		"Never script around a confirmation that a person must type."
	);
}
