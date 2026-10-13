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

/**
 * A typed "go" approves only a finished plan: the reply stopped normally, has a "Plan"
 * heading or bold line (Plan, plan or PLAN; text after it is fine, such as "## Plan for X", except "Plan mode..."; a bare line needs "Plan:" or "Plan ("), and does not end on a question.
 */
export function isPlanReady(text: string, stoppedNormally: boolean): boolean {
	if (!stoppedNormally) return false;
	const t = text.trim();
	return /^\s*(?:#+\s*[*_]*(?:[Pp]lan|PLAN)(?![A-Za-z])(?![*_]*[ \t:\u2013\u2014-]+[Mm][Oo][Dd][Ee]\b)|[*_]+(?:[Pp]lan|PLAN)(?![A-Za-z])(?![*_]*[ \t:\u2013\u2014-]+[Mm][Oo][Dd][Ee]\b)|(?:Plan|PLAN)\s*[:(])/m.test(t) && !/\?[\s*_)"'`]*$/.test(t);
}

/** The judge runs after an execute reply unless the reply errored. */
export function skipJudge(last: { role?: string; stopReason?: string } | undefined): boolean {
	return last?.role === "assistant" && last.stopReason === "error";
}
