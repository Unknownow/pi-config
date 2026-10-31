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
	return stoppedNormally && !ENDS_IN_QUESTION.test(text.trim()) && hasPlanLine(text);
}

/** True when some line of the reply is a plan heading or label (not a notice such as "Plan mode"). */
export function hasPlanLine(text: string): boolean {
	return text.trim().split(/\r?\n/).some((line) => {
		const rest = planLineRest(line);
		return rest !== null && !NOTICE.test(rest.replace(/^[\s*_:()\u2013\u2014-]+/, ""));
	});
}

const ENDS_IN_QUESTION = /\?[\s*_)"'`]*$/;

/** Approval needs a finished reply that does not end on a question, and a `## Plan:` reply since the plan phase started. */
export function canApprove(text: string, stoppedNormally: boolean, hasFullPlan: boolean): boolean {
	return stoppedNormally && !ENDS_IN_QUESTION.test(text.trim()) && hasFullPlan;
}

const FULL_PLAN = /^##\s*Plan:/m;
const PLAN_CHANGES = /^##\s*Plan changes/m;

/** The plan so far: the last full `## Plan:` reply and the `## Plan changes` sections written after it. */
export interface PlanDraft {
	full: string;
	changes: string[];
}

/** Folds one planner reply into the draft: a full plan replaces it, a change section is appended, anything else leaves it as it is. */
export function addPlanReply(draft: PlanDraft, text: string): PlanDraft {
	const full = FULL_PLAN.exec(text);
	if (full) return { full: text.slice(full.index).trim(), changes: [] };
	const change = PLAN_CHANGES.exec(text);
	if (change && draft.full) return { full: draft.full, changes: [...draft.changes, text.slice(change.index).trim()] };
	return draft;
}

/** Why a plan can't be approved yet, or undefined: no full `## Plan:` reply, or wait checks that can't run. */
export function approvalBlock(draft: PlanDraft, waitProblems: string[]): string | undefined {
	if (!draft.full) return "there is no `## Plan:` reply yet; ask the planner for the plan first";
	if (waitProblems.length) return `the plan has wait checks that can't run (${waitProblems[0]})`;
	return undefined;
}

/** The approved plan text: the full plan followed by its change sections. */
export function composePlan(draft: PlanDraft): string {
	return [draft.full, ...draft.changes].filter(Boolean).join("\n\n");
}

/** A passed diff is sent back for a minor-fix round only once: not after its flow ended, or when a fix message already went out for it. */
export function minorFixOpen(s: { summarized: boolean; sentFor?: string; hash: string }): boolean {
	return !s.summarized && s.sentFor !== s.hash;
}

/** After a pass: go back for a fix round while findings remain and rounds are left, else the stage is done. */
export function afterPass(findings: number, minorRounds: number, maxMinorRounds: number): "fix" | "done" {
	return findings > 0 && minorRounds < maxMinorRounds ? "fix" : "done";
}

/** A judge pass nobody has ended a stage or flow for yet: the diff may be empty by now (the pull request was merged and the base moved up). */
export function passPending(s: { passedDiff?: string; judged?: { hash: string; verdict: "PASS" | "FAIL" }; summarized?: string[] }): boolean {
	return !!s.passedDiff && s.judged?.hash === s.passedDiff && s.judged.verdict === "PASS" && !s.summarized?.includes(s.passedDiff);
}

/** A passed stage with steps still open gets one reminder per pass; the next time it ends anyway. */
export function stageEndAction(s: { openSteps: number; nudgedFor?: string; hash: string }): "nudge" | "done" {
	return s.openSteps > 0 && s.nudgedFor !== s.hash ? "nudge" : "done";
}

/** The judge runs after an execute reply unless the reply errored. */
export function skipJudge(last: { role?: string; stopReason?: string } | undefined): boolean {
	return last?.role === "assistant" && last.stopReason === "error";
}

/** True when this many failed judge rounds in a row hit the cap. A cap of 0 means no limit. */
export function judgeCapReached(rounds: number, max: number): boolean {
	return max > 0 && rounds >= max;
}

/** The phase to go back to when a flow ends: `returnTo` (discuss or plan), from execute or test; none when it is "off". */
export function phaseAfterFlow(returnTo: "discuss" | "plan" | "off", phase: "off" | "discuss" | "plan" | "execute" | "test"): "discuss" | "plan" | undefined {
	return returnTo !== "off" && (phase === "execute" || phase === "test") ? returnTo : undefined;
}

/** Handovers that start a new piece of work (execute, a stage) may compact first; the others ("continue": fix rounds, open steps) never do. */
export function handoverKind(customType: string): "start" | "continue" {
	return customType === "workflow-execute" || customType === "workflow-stage" ? "start" : "continue";
}

/** Whether a pending handover message is sent after compacting the session first. An aborted run holds it (the user stopped the flow). */
export function handoverAction(s: { aborted: boolean; kind: "start" | "continue"; idle: boolean; compacting: boolean; hasPlan: boolean; tokens: number | null; threshold: number }): "compact" | "send" | "hold" {
	if (s.aborted) return "hold";
	return s.kind === "start" && s.idle && !s.compacting && s.hasPlan && s.threshold > 0 && s.tokens !== null && s.tokens > s.threshold ? "compact" : "send";
}

/** The judge reports that the approved plan itself is flawed: a finding line tagged [plan-flaw]. */
export function hasPlanFlaw(text: string): boolean {
	return /^\S.*\s-\s*(blocker|major|minor)\s*-\s*\[plan-flaw\]/im.test(text);
}

const PLAN_FLAW_LINE = /^\S.*\s-\s*(blocker|major|minor)\s*-\s*\[plan-flaw\]/i;

/** The finding lines of a judge report tagged [plan-flaw]. */
export function planFlawLines(text: string): string[] {
	return text.split(/\r?\n/).filter((l) => PLAN_FLAW_LINE.test(l));
}

/** What a judge report with plan flaws does: "stop" (FAIL or a blocker flaw: the user or arbiter resolves it), "arbiter" (worst flaw is major, on a pass), "note" (all minor, on a pass). */
export function planFlawOnPass(text: string, verdict: "PASS" | "FAIL"): "stop" | "arbiter" | "note" {
	if (verdict !== "PASS") return "stop";
	const sev = planFlawLines(text).map((l) => PLAN_FLAW_LINE.exec(l)![1].toLowerCase());
	if (sev.includes("blocker")) return "stop";
	return sev.includes("major") ? "arbiter" : "note";
}

/** Plan flaws go to the arbiter before the user: this flow's choice at approval, else the config. */
export function arbiterFirst(flow: "auto" | undefined, config: "ask" | "auto"): boolean {
	return (flow ?? config) === "auto";
}

/**
 * Findings of a judge report the executor should fix after a pass: finding lines (not the indented Why/Fix lines)
 * except [knowledge <id>] deviations from a recommended rule, which may stay with a reason, and [plan-flaw] findings, which the arbiter or the user decides.
 */
export function fixableFindings(text: string): number {
	return text
		.split(/\r?\n/)
		.filter((l) => /^\S.*\s-\s*(blocker|major|minor)\s*-/i.test(l) && !/-\s*(\[plan-flaw\]|\[knowledge\b[^\]]*\]\s*deviation from a recommended rule)/i.test(l)).length;
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

/**
 * A staged plan's turn ended with no new changes: advance if the executor handed the stage over (judge called) or `auto` (stageAdvance), else ask the user (UI) or wait.
 * A stage with open steps and no judge call never advances by itself, even with `auto`: it is blocked, not done.
 */
export function noChangeStage(judged: boolean, hasUI: boolean, auto = false, openSteps = 0): "advance" | "ask" | "wait" {
	if (!judged && openSteps > 0) return hasUI ? "ask" : "wait";
	return judged || auto ? "advance" : hasUI ? "ask" : "wait";
}
