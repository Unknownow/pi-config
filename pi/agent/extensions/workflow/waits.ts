/** Wait points: a flow pauses for a person (publish a package, open an Editor) and then continues the same plan. Pure text and decisions, kept apart so node tests can reach them. */

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
