/** Pure parts of the contracts K9 (start-plan), K10 (plan-ready) and K11 (merge-gate); see README.md. */

export const START_PLAN_PREFACE = "The discussion is done; its result is this brief. Write the final `## Plan: <title>` now, following the plan-phase rules. Ask only about what blocks the plan.\n\n";

export interface StartPlan {
	title: string;
	brief: string;
	allowTools: string[];
}

/** The K9 payload, or `{ error }` when it is malformed. */
export function parseStartPlan(data: unknown): StartPlan | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "workflow:start-plan needs an object payload" };
	const o = data as Record<string, unknown>;
	if (o.v !== 1) return { error: "workflow:start-plan: unsupported version (v must be 1)" };
	if (typeof o.title !== "string" || !o.title.trim()) return { error: "workflow:start-plan: title must be a non-empty string" };
	if (typeof o.brief !== "string" || !o.brief.trim()) return { error: "workflow:start-plan: brief must be a non-empty string" };
	if (o.allowTools !== undefined && !(Array.isArray(o.allowTools) && o.allowTools.every((t) => typeof t === "string" && t))) return { error: "workflow:start-plan: allowTools must be a list of tool names" };
	return { title: o.title, brief: o.brief, allowTools: (o.allowTools as string[] | undefined) ?? [] };
}

/** What to do with the settled answer of a K10 claim. `stillCurrent`: the phase is still plan and the plan text is unchanged. */
export function planReviewAction(answer: unknown, stillCurrent: boolean): "approve" | "reject" | "ignore" {
	if (!stillCurrent || typeof answer !== "object" || answer === null) return "ignore";
	const o = answer as { approve?: unknown; reject?: unknown };
	if (o.approve === true) return "approve";
	if (typeof o.reject === "string" && o.reject.trim()) return "reject";
	return "ignore";
}

export const ACCEPTANCE_NO_ANSWER = "the acceptance check did not answer";

/** The refusal text of a K11 answer, or null when the merge may go on. */
export function acceptanceRefusal(answer: unknown): string | null {
	if (answer === null || answer === undefined) return null;
	if (typeof answer === "object") {
		const o = answer as { problem?: unknown; error?: unknown };
		if (typeof o.problem === "string" && o.problem) return o.problem;
		if (typeof o.error === "string") return ACCEPTANCE_NO_ANSWER;
	}
	return null;
}

const SPECIAL = /[.*+?^$()|{}\[\]\\]/g;

/** Exact-name regexes for tools a plan-phase session may use in addition to `planAllowedTools`. */
export function exactToolRegexes(names: string[] | undefined): RegExp[] {
	return (names ?? []).map((n) => new RegExp("^" + n.replace(SPECIAL, "\\$&") + "$"));
}
