/**
 * The workflow's side of `agents:subagent-finished`, which the agents extension emits after every
 * explore, advisor and runner run. Pure: index.ts applies the result to the view, the metrics and
 * the error counter.
 */
import type { MetricEvent } from "./metrics.ts";

export interface SubagentFinished {
	role: string;
	label: string;
	ms: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total?: number } };
	model: string;
	ok: boolean;
	error?: string;
	bootMs?: number;
	turns?: number;
	tools?: number;
}

export interface SubagentCounted {
	event: SubagentFinished;
	metric: MetricEvent;
	/** The advisor answered, so the executor's run of failed tool calls starts over. */
	resetErrors: boolean;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** What a flow does with a finished agents run; undefined outside a flow or for a malformed event. */
export function countSubagent(data: unknown, phase: string, stage: string, now = Date.now()): SubagentCounted | undefined {
	if (phase === "off" || typeof data !== "object" || data === null) return undefined;
	const d = data as Record<string, unknown>;
	if (typeof d.role !== "string" || typeof d.model !== "string" || typeof d.usage !== "object" || d.usage === null) return undefined;
	const u = d.usage as Record<string, unknown>;
	const usage = { input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite), cost: { total: num((u.cost as { total?: unknown } | undefined)?.total) } };
	const event: SubagentFinished = { role: d.role, label: typeof d.label === "string" ? d.label : "", ms: num(d.ms), usage, model: d.model, ok: d.ok === true, error: typeof d.error === "string" ? d.error : undefined, bootMs: typeof d.bootMs === "number" ? d.bootMs : undefined, turns: num(d.turns), tools: num(d.tools) };
	const metric: MetricEvent = {
		kind: "subagent",
		at: new Date(now).toISOString(),
		role: event.role,
		label: event.label,
		stage,
		model: event.model,
		ms: event.ms,
		bootMs: event.bootMs,
		turns: event.turns ?? 0,
		tools: event.tools ?? 0,
		tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
		cost: usage.cost.total,
		ok: event.ok,
		error: event.error,
	};
	return { event, metric, resetErrors: event.role === "advisor" };
}
