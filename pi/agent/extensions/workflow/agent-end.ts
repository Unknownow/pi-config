/** Pure decisions behind the agent_end handler, kept apart so node tests can reach them. */

export const MAX_RESUMES = 2;

/** True when the reply is an assistant reply with no content: the bridge's answer to a retry that ended on a tool result. */
export function isEmptyReply(last: { role?: string; content?: unknown } | undefined): boolean {
	return last?.role === "assistant" && Array.isArray(last.content) && last.content.length === 0;
}

/** After a "prompt is too long" retry, ask the model to carry on only if it answered with nothing and the cap is not used up. */
export function shouldResume(overflowRetry: boolean, last: { role?: string; content?: unknown } | undefined, resumes: number): boolean {
	return overflowRetry && isEmptyReply(last) && resumes < MAX_RESUMES;
}

const HEADING = /^#+\s*[*_]*(?:Plan|plan|PLAN)(?![A-Za-z])(.*)$/;
const EMPHASIS = /^[*_]+(?:Plan|plan|PLAN)(?![A-Za-z])(.*)$/;
const LABEL_END = /^[^*_\n]*[*_]+\s*(?:$|[:(\u2013\u2014-])|^\s*[:(\u2013\u2014-]|^\s*$/;
/** What follows "Plan" says it is a notice, not a plan: "mode", "mode is on", "not ready", "pending", "tbd". */
const NOTICE = /^(?:mode\b(?!\s+\w)|mode\s+(?:is|on|off|active|enabled)\b|not\s+(?:ready|yet|final|done|available)\b|(?:pending|tbd)\b(?!\s+\w))/i;

/** The text after the word "Plan" when the line is a plan heading, bold label or "Plan:" line; null otherwise. */
function planLineRest(line: string): string | null {
	const l = line.trim();
	let m = HEADING.exec(l);
	if (m) return m[1];
	m = EMPHASIS.exec(l);
	if (m) return LABEL_END.test(m[1]) ? m[1] : null;
	m = /^(?:Plan|PLAN)(\s*[:(].*)$/.exec(l);
	return m ? m[1] : null;
}

/**
 * A typed "go" approves only a finished plan: the reply stopped normally, has a plan line, and does not end on a question.
 * A plan line is a "#" heading or a bold/italic label starting with Plan, plan or PLAN (text after it is fine, such as
 * "## Plan for X"; prose like "**Plan** to read first" is not), or a bare line starting "Plan:" or "Plan (".
 * A line whose text after Plan is a notice ("Plan mode", "Plan: mode is on", "Plan not ready yet") does not count;
 * "## Plan: mode switch redesign" does.
 */
export function isPlanReady(text: string, stoppedNormally: boolean): boolean {
	if (!stoppedNormally) return false;
	const t = text.trim();
	if (/\?[\s*_)"'`]*$/.test(t)) return false;
	return t.split(/\r?\n/).some((line) => {
		const rest = planLineRest(line);
		return rest !== null && !NOTICE.test(rest.replace(/^[\s*_:()\u2013\u2014-]+/, ""));
	});
}

/** A passed diff is sent back for a minor-fix round only once: not after its commit step started, its flow ended, or a fix message already went out for it. */
export function minorFixOpen(s: { committed: boolean; commitPending: boolean; summarized: boolean; sentFor?: string; hash: string }): boolean {
	return !s.committed && !s.commitPending && !s.summarized && s.sentFor !== s.hash;
}

/** After a pass: go back for a fix round while findings remain and rounds are left, else commit. */
export function afterPass(findings: number, minorRounds: number, maxMinorRounds: number): "fix" | "commit" {
	return findings > 0 && minorRounds < maxMinorRounds ? "fix" : "commit";
}

/** The judge runs after an execute reply unless the reply errored. */
export function skipJudge(last: { role?: string; stopReason?: string } | undefined): boolean {
	return last?.role === "assistant" && last.stopReason === "error";
}

/** True when this many failed judge rounds in a row hit the cap. A cap of 0 means no limit. */
export function judgeCapReached(rounds: number, max: number): boolean {
	return max > 0 && rounds >= max;
}

/** The judge reports that the approved plan itself is flawed: a finding line tagged [plan-flaw]. */
export function hasPlanFlaw(text: string): boolean {
	return /^\S.*\s-\s*(blocker|major|minor)\s*-\s*\[plan-flaw\]/im.test(text);
}

/**
 * Findings of a judge report the executor should fix after a pass: finding lines (not the indented Why/Fix lines)
 * except [knowledge ...] deviations, which may stay with a reason, and [plan-flaw] findings, which the arbiter or the user decides.
 */
export function fixableFindings(text: string): number {
	return text
		.split(/\r?\n/)
		.filter((l) => /^\S.*\s-\s*(blocker|major|minor)\s*-/i.test(l) && !/-\s*\[(knowledge\b|plan-flaw\])/i.test(l)).length;
}

export interface ArbiterDecision {
	decision: "REVISE" | "KEEP" | "ASK_USER";
	reason: string;
	amendment: string;
}

/** Reads the arbiter's reply. A REVISE without an amendment counts as ASK_USER; null when there is no decision. */
export function parseArbiter(text: string): ArbiterDecision | null {
	const m = /^\s*DECISION:\s*(REVISE|KEEP|ASK_USER)\b/im.exec(text);
	if (!m) return null;
	let decision = m[1].toUpperCase() as ArbiterDecision["decision"];
	const reasonMatch = /^\s*Reason:\s*([\s\S]*?)(?=^#{1,6}\s*Plan amendment|$(?![\s\S]))/im.exec(text);
	const reason = (reasonMatch?.[1] ?? "").trim();
	const amendMatch = /^#{1,6}\s*Plan amendment[^\n]*\n([\s\S]*)$/im.exec(text);
	const amendment = (amendMatch?.[1] ?? "").trim();
	if (decision === "REVISE" && !amendment) decision = "ASK_USER";
	return { decision, reason, amendment };
}
