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
