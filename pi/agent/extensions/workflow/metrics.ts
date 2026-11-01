/**
 * Per-flow metrics: one JSON line per subagent run, compaction and finished flow,
 * appended to `metrics.jsonl` in the flow's plan folder. Local only, best effort.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { RunResult } from "../agents/subagent.ts";
import type { FlowUsage } from "./view.ts";

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type MetricEvent =
	| { kind: "subagent"; at: string; flowId?: string; role: string; label: string; stage: string; model: string; ms: number; bootMs?: number; turns: number; tools: number; tokens: Tokens; cost: number; ok: boolean; error?: string }
	| { kind: "compaction"; at: string; flowId?: string; reason: "handover" | "guard"; tokensBefore: number | null; ms: number; ok: boolean; error?: string }
	| { kind: "flow"; at: string; flowId?: string; outcome: string; ok: boolean; started?: number; ended: number; stages: FlowUsage; profile?: "quick" };

const MAX_QUEUED = 1000;

export function subagentMetric(role: string, label: string, stage: string, model: string, started: number, ended: number, r: RunResult): MetricEvent {
	const u = r.usage;
	return {
		kind: "subagent",
		at: new Date(ended).toISOString(),
		role,
		label,
		stage,
		model,
		ms: ended - started,
		bootMs: r.bootMs,
		turns: r.turns,
		tools: r.toolCalls.length,
		tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
		cost: u.cost?.total ?? 0,
		ok: r.ok,
		error: r.error,
	};
}

/** Appends the events to `<folder>/metrics.jsonl`. Never creates the folder and never throws; false when nothing was written. */
export function appendMetrics(folder: string, events: MetricEvent[]): boolean {
	try {
		if (!events.length || !fs.statSync(folder).isDirectory()) return false;
		fs.appendFileSync(path.join(folder, "metrics.jsonl"), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** Events waiting for their flow's plan folder (a flow has none until its plan is approved). */
export class MetricsQueue {
	private events: MetricEvent[] = [];

	record(e: MetricEvent): void {
		this.events.push(e);
		if (this.events.length > MAX_QUEUED) this.events.splice(0, this.events.length - MAX_QUEUED);
	}

	flush(folderOf: (flowId: string) => string | undefined, activeFlowId?: string): void {
		if (activeFlowId) for (const e of this.events) e.flowId ??= activeFlowId;
		const keep: MetricEvent[] = [];
		const byFolder = new Map<string, MetricEvent[]>();
		for (const e of this.events) {
			const folder = e.flowId ? folderOf(e.flowId) : undefined;
			if (!folder) keep.push(e);
			else byFolder.set(folder, [...(byFolder.get(folder) ?? []), e]);
		}
		for (const [folder, list] of byFolder) appendMetrics(folder, list);
		this.events = keep;
	}

	clear(): void {
		this.events = [];
	}

	get size(): number {
		return this.events.length;
	}
}
