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

/** The orchestrator's approval notes of a K10 answer, or "". */
export function planReviewNotes(answer: unknown): string {
	const n = typeof answer === "object" && answer !== null ? (answer as { notes?: unknown }).notes : undefined;
	return typeof n === "string" ? n.trim() : "";
}

export const ACCEPTANCE_NO_ANSWER = "the acceptance check did not answer";

/** The refusal of a K11 answer, or null when the merge may go on. `pending`: an acceptance request waits for the orchestrator; `tree` is the tree it resolved. */
export function acceptanceRefusal(answer: unknown): { text: string; pending: boolean; tree?: string } | null {
	if (answer === null || answer === undefined) return null;
	if (typeof answer === "object") {
		const o = answer as { problem?: unknown; pending?: unknown; tree?: unknown };
		const tree = typeof o.tree === "string" && o.tree ? o.tree : undefined;
		if (typeof o.problem === "string" && o.problem) return { text: o.problem, pending: o.pending === true && !!tree, ...(tree ? { tree } : {}) };
	}
	return { text: ACCEPTANCE_NO_ANSWER, pending: false }; // an error, or an answer outside the contract: refuse
}

const SPECIAL = /[.*+?^$()|{}\[\]\\]/g;

/** Exact-name regexes for tools a plan-phase session may use in addition to `planAllowedTools`. */
export function exactToolRegexes(names: string[] | undefined): RegExp[] {
	return (names ?? []).map((n) => new RegExp("^" + n.replace(SPECIAL, "\\$&") + "$"));
}

/** Whether the tools a start-plan caller allowed (K9) stay when the phase changes: they go when the session leaves the flow for off, or leaves execute for anything but plan. */
export function keepExtraTools(from: string, to: string): boolean {
	if (to === "off") return false;
	if (from === "execute" && to !== "plan" && to !== "execute") return false;
	return true;
}

/** K10: the plan goes to a reviewer only when it can be approved, nothing blocks it and a listener claimed it; otherwise the usual menu. */
export function planReviewRoute(planReady: boolean, blocked: boolean, claimed: boolean): "review" | "menu" {
	return planReady && !blocked && claimed ? "review" : "menu";
}

/** K11: where a merge-gate question comes from. */
export type K11Site = "merge" | "protected-push" | "publish" | "git-task";

/** What each site asks: "gate" is the real merge, protected push or publish; "pre" is the `git_task` advance check, which a listener must not answer with an accept request. */
export const K11_SITES: Record<K11Site, { kind: "merge" | "protected-push" | "publish"; ask: "gate" | "pre" }> = {
	merge: { kind: "merge", ask: "gate" },
	"protected-push": { kind: "protected-push", ask: "gate" },
	publish: { kind: "publish", ask: "gate" },
	"git-task": { kind: "merge", ask: "pre" },
};

/** The K11 payload (without the claim) for a site. */
export function k11Payload(site: K11Site, cwd: string, tree: string | null): { v: 1; kind: string; cwd: string; tree: string | null; ask: "gate" | "pre" } {
	const s = K11_SITES[site];
	return { v: 1, kind: s.kind, cwd: cwd.replace(/\\/g, "/"), tree, ask: s.ask };
}

export type FlowEndHow = "finished" | "stopped" | "abandoned";

/** K14: "abandoned" when the execute phase is left for discuss or off without endFlow; a move to plan (replan) or any other move sends nothing. */
export function flowEndKind(c: { from: string; to: string; viaEndFlow: boolean }): "abandoned" | null {
	if (c.viaEndFlow || c.from !== "execute") return null;
	return c.to === "discuss" || c.to === "off" ? "abandoned" : null;
}

/** K14 payload. */
export function flowEndPayload(flowId: string | undefined, how: FlowEndHow): { v: 1; flowId?: string; how: FlowEndHow } {
	return { v: 1, ...(flowId ? { flowId } : {}), how };
}

/** Runs `body` as an endFlow: emits K14 first, marks the flag while the body runs (its setPhase must not send "abandoned"), resets it in finally. */
export async function withEndFlow<T>(flag: { on: boolean }, how: "finished" | "stopped", emit: (how: "finished" | "stopped") => void, body: () => Promise<T>): Promise<T> {
	emit(how);
	flag.on = true;
	try {
		return await body();
	} finally {
		flag.on = false;
	}
}

/** The K16 `flow:active` payload: who asks (`workflow` or `relay`) and the claim function the listener answers through. */
export function parseFlowActive(data: unknown): { from: "workflow" | "relay"; claim?: (p: Promise<unknown>) => void } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "flow:active needs an object payload" };
	const o = data as { v?: unknown; from?: unknown; claim?: unknown };
	if (o.v !== 1) return { error: "flow:active: unsupported version (v must be 1)" };
	if (o.from !== "workflow" && o.from !== "relay") return { error: "flow:active: from must be \"workflow\" or \"relay\"" };
	return { from: o.from, claim: typeof o.claim === "function" ? (o.claim as (p: Promise<unknown>) => void) : undefined };
}

/** True when the settled K16 answer says relay owns the session; null, `{ error }` (timeout) and anything else are no claim. */
export function relayOwner(answer: unknown): boolean {
	return typeof answer === "object" && answer !== null && (answer as { owner?: unknown }).owner === "relay";
}
