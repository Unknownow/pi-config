/**
 * The workflow's takeover of the agents `judge` tool. Agents emits `agents:judge-call`
 * `{ v: 1, params, ctx, signal, onUpdate, claim }` before it runs its own judge; while a flow is on the
 * workflow claims the call with its own review (review base, rounds, gates). Pure: tests load it without pi.
 */

/** The judge tool's parameters, as the agents tool declares them. */
export interface JudgeParams {
	focus?: string;
	base?: string;
	full?: boolean;
	disputes?: string;
}

/** Runs the workflow's judge for one call; its result is the tool result `{ content, details?, usage? }`. */
export type JudgeRun<C> = (params: JudgeParams, signal: AbortSignal | undefined, onUpdate: unknown, ctx: C) => Promise<unknown>;

/**
 * Claims the call with `run(...)` when a flow is on (`phase` is not "off"); returns whether it claimed.
 * A payload of another version or without `claim` is left alone.
 */
export function claimJudgeCall<C>(phase: string, payload: unknown, run: JudgeRun<C>): boolean {
	const p = payload as { v?: unknown; params?: unknown; ctx?: C; signal?: AbortSignal; onUpdate?: unknown; claim?: unknown } | null | undefined;
	if (phase === "off" || !p || p.v !== 1 || typeof p.claim !== "function") return false;
	const params = (typeof p.params === "object" && p.params !== null ? p.params : {}) as JudgeParams;
	(p.claim as (answer: Promise<unknown>) => void)(run(params, p.signal, p.onUpdate, p.ctx as C));
	return true;
}

