/**
 * Live view of the workflow: a widget above the editor with the pipeline
 * (active stage highlighted, with its model) and one row per subagent run,
 * showing what each one is doing right now.
 *
 *   ● flow  plan opus-5-5·high 48,120 (9,800) ▸ EXECUTE sonnet-5-5·medium 1,204,331 (310,200) ▸ judge opus-5-5·high 90,004 (21,300) · Σ 1,342,455 (341,300)
 *     ├ ⠹ explore  haiku-5-5  where is average defined?   grep /average/ in src · 3 tools · 12,004 (2,100) tok · 12s
 *     └ ✓ judge    opus-5-5   FAIL · 3 findings · 90,004 (21,300) tok · 41s
 *
 * Token counts are live: each stage sums the main session's messages sent while
 * it was active plus the subagents run during it (judge runs count as judge),
 * including the message still streaming. Each count is the exact raw total (cache
 * reads and writes at full size), with the cost-weighted figure in brackets
 * (tokenWeights in workflow.json: a cache read counts 0.1), so re-sending a long
 * context shows both its volume and what it costs.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { DEFAULTS, describeRole, type Role, type RoleSpec } from "./config.ts";
import { countTokens, type Tok, type TokenWeights, type UsageCounts } from "./tokens.ts";
import type { SubagentEvent } from "./subagent.ts";
import { progressBar } from "./board.ts";
import { reportLines, type ReportFinding, type ReportStep } from "./flow-report.ts";

export type Stage = "discuss" | "plan" | "test" | "execute" | "judge" | "commit";
export type SubRole = "explore" | "advisor" | "judge" | "arbiter" | "commit" | "runner";

export interface RunView {
	id: number;
	role: SubRole;
	model: string;
	label: string;
	started: number;
	ended?: number;
	status: "running" | "ok" | "fail";
	/** What it is doing now, or its outcome once finished. */
	activity: string;
	tools: number;
	/** Tokens of finished messages. */
	tokens: Tok;
	/** Tokens of the message still streaming. */
	liveTokens: Tok;
	/** Counts of the message still streaming. */
	liveCounts: ModelCounts;
	/** Pipeline stage its tokens count toward. */
	stage: Stage;
}

/** The four kinds of tokens, as the provider reports them. */
export interface ModelCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelTotal extends ModelCounts {
	tokens: Tok;
}

const noCounts = (): ModelCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const countsOf = (u: UsageCounts | undefined): ModelCounts => ({ input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0 });
const maxCounts = (a: ModelCounts, b: ModelCounts): ModelCounts => ({
	input: Math.max(a.input, b.input),
	output: Math.max(a.output, b.output),
	cacheRead: Math.max(a.cacheRead, b.cacheRead),
	cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
});
const addCounts = (a: ModelCounts, b: ModelCounts): ModelCounts => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: a.cacheRead + b.cacheRead,
	cacheWrite: a.cacheWrite + b.cacheWrite,
});
/** Key of a model in the per-model maps: the short name, so "claude-bridge/claude-x" and "claude-x" agree. */
const modelKey = (model: string | undefined): string => (model ? shortModel(model) : "unknown");

export const STAGES: Stage[] = ["discuss", "plan", "test", "execute", "judge", "commit"];

const zero = (): Tok => ({ raw: 0, cost: 0 });
const isZero = (t: Tok): boolean => t.raw === 0 && t.cost === 0;
const add = (a: Tok, b: Tok): Tok => ({ raw: a.raw + b.raw, cost: a.cost + b.cost });
const max = (a: Tok, b: Tok): Tok => ({ raw: Math.max(a.raw, b.raw), cost: Math.max(a.cost, b.cost) });
const same = (a: Tok, b: Tok): boolean => a.raw === b.raw && a.cost === b.cost;

/** Summaries saved before counts were tracked as raw and cost held a single number; show it as both. */
function asTok(x: Tok | number | undefined): Tok {
	if (typeof x === "number") return { raw: x, cost: x };
	return x ?? zero();
}

export function emptyStageTokens(): Record<Stage, Tok> {
	return { discuss: zero(), plan: zero(), test: zero(), execute: zero(), judge: zero(), commit: zero() };
}

/** Where one stage's tokens went during a flow. */
export interface StageUsage {
	tokens: Tok;
	/** The main session's share; the rest is subagents. */
	main: Tok;
	models: string[];
	subs: Partial<Record<SubRole, { tokens: Tok; runs: number; byModel?: Record<string, { tokens: Tok; runs: number }> }>>;
	/** The main session's share per model (short name). Absent in summaries saved before the breakdown. */
	mainByModel?: Record<string, Tok>;
	/** Main session and subagents per model, with the four counts. */
	byModel?: Record<string, ModelTotal>;
}

function addToModel(u: StageUsage, model: string | undefined, tokens: Tok, counts: ModelCounts): string {
	const key = modelKey(model);
	const total = ((u.byModel ??= {})[key] ??= { tokens: zero(), ...noCounts() });
	total.tokens = add(total.tokens, tokens);
	Object.assign(total, addCounts(total, counts));
	return key;
}

export type FlowUsage = Record<Stage, StageUsage>;

export function emptyFlowUsage(): FlowUsage {
	const empty = (): StageUsage => ({ tokens: zero(), main: zero(), models: [], subs: {}, mainByModel: {}, byModel: {} });
	return { discuss: empty(), plan: empty(), test: empty(), execute: empty(), judge: empty(), commit: empty() };
}

/** Data of the summary entry shown when a flow ends. */
export interface FlowSummary {
	/** Heading; "flow done" when absent. */
	title?: string;
	outcome: string;
	ok: boolean;
	started?: number;
	ended: number;
	stages: FlowUsage;
	/** Saved before both totals were kept: the counts are cost-weighted only. */
	weighted?: boolean;
	/** Plan steps with their done marks. */
	steps?: ReportStep[];
	/** Every finding raised in the flow. */
	findings?: ReportFinding[];
	/** Checks only a person can do, listed after the flow. */
	humanChecks?: { id?: string; text: string }[];
	/** The card was posted again after a compaction hid it. */
	reposted?: boolean;
}

/** Exact count with thousands separators, e.g. 1,204,331. */
export function exact(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Raw count, with the cost-weighted count in brackets when they differ. */
export function fmtTok(t: Tok): string {
	return t.raw === t.cost ? exact(t.raw) : `${exact(t.raw)} (${exact(t.cost)})`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function shortModel(spec: string): string {
	return spec.split("/").pop()?.replace(/^claude-/, "") ?? spec;
}

function short(spec: RoleSpec): string {
	return `${shortModel(spec.model)}${spec.thinking && spec.thinking !== "off" ? `·${spec.thinking}` : ""}`;
}

function oneLine(s: string, max = 60): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function elapsed(run: { started: number; ended?: number }): string {
	const s = Math.round(((run.ended ?? Date.now()) - run.started) / 1000);
	if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function spinner(): string {
	return SPINNER[Math.floor(Date.now() / 100) % SPINNER.length];
}

/** `grep /pattern/ in dir`, `read file:10-50`, ... relative to cwd. */
export function describeTool(name: string, args: Record<string, unknown>, cwd: string): string {
	const rel = (p: unknown) => {
		if (typeof p !== "string" || !p) return ".";
		const r = path.isAbsolute(p) ? path.relative(cwd, p) : p;
		if (!r.startsWith("..")) return r || ".";
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (name) {
		case "read": {
			const off = args.offset as number | undefined;
			const lim = args.limit as number | undefined;
			const range = off || lim ? `:${off ?? 1}${lim ? `-${(off ?? 1) + lim - 1}` : ""}` : "";
			return `read ${rel(args.path ?? args.file_path)}${range}`;
		}
		case "grep":
			return `grep /${oneLine(String(args.pattern ?? ""), 30)}/ in ${rel(args.path)}`;
		case "find":
			return `find ${oneLine(String(args.pattern ?? "*"), 30)} in ${rel(args.path)}`;
		case "ls":
			return `ls ${rel(args.path)}`;
		case "bash":
			return `$ ${oneLine(String(args.command ?? ""), 50)}`;
		default:
			return `${name} ${oneLine(JSON.stringify(args), 40)}`;
	}
}

/** One row per run, shared by the widget and the tool renderers. */
export function runLine(run: RunView, theme: Theme, opts: { showRole: boolean }): string {
	const icon =
		run.status === "running"
			? theme.fg("accent", spinner())
			: run.status === "ok"
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	const role = opts.showRole ? `${theme.fg("toolTitle", run.role.padEnd(8))} ${theme.fg("muted", run.model.padEnd(10))} ` : "";
	const tokens = add(asTok(run.tokens), asTok(run.liveTokens));
	const stats = [run.tools ? `${run.tools} tool${run.tools > 1 ? "s" : ""}` : "", isZero(tokens) ? "" : `${fmtTok(tokens)} tok`, elapsed(run)]
		.filter(Boolean)
		.join(" · ");
	const activityColor = run.status === "fail" ? "error" : run.status === "running" ? "toolOutput" : "muted";
	return `${icon} ${role}${theme.fg("dim", oneLine(run.label, 40))}  ${theme.fg(activityColor, run.activity)} ${theme.fg("dim", `· ${stats}`)}`;
}

/**
 * The end-of-flow card: one bar per stage, scaled to the flow's total, with the
 * main session's and each subagent role's share.
 *
 *   ✓ flow done · committed and pushed · 1,342,455 (341,300) tokens · 12m04s
 *     plan     ██░░░░░░░░░░░░░░░░░░    48,120 (9,800)   4%  opus-5-5
 *     execute  █████████████████░░░ 1,080,000 (273,000) 87%  sonnet-5-5 920,000 (240,000) · explore ×6 120,000 (25,000) · advisor ×1 40,000 (8,000)
 *     judge    █░░░░░░░░░░░░░░░░░░░    90,004 (21,300)   7%  judge ×2 90,004 (21,300)
 *     commit   ░░░░░░░░░░░░░░░░░░░░    20,000 (4,200)   2%  sonnet-5-5
 */
export function summaryLines(s: FlowSummary, theme: Theme): string[] {
	const stageTokens = (st: Stage) => asTok(s.stages[st]?.tokens);
	const total = STAGES.reduce((n, st) => add(n, stageTokens(st)), zero());
	// The discuss, test and commit rows show only for flows that used them.
	const rows = STAGES.filter((st) => (st !== "test" && st !== "discuss" && st !== "commit") || !isZero(stageTokens(st)));
	const unit = s.weighted ? "cost-weighted tokens" : "tokens";
	// Summaries from before the per-model breakdown render as they always did.
	const perModel = new Map<string, ModelTotal>();
	for (const st of STAGES) {
		for (const [m, t] of Object.entries(s.stages[st]?.byModel ?? {})) {
			const cur = perModel.get(m) ?? { tokens: zero(), ...noCounts() };
			perModel.set(m, { tokens: add(cur.tokens, asTok(t.tokens)), ...addCounts(cur, countsOf(t)) });
		}
	}
	const byModel = perModel.size > 0;
	const took = s.started ? elapsed({ started: s.started, ended: s.ended }) : "";
	const timing = took ? ` · ${took}` : "";
	const head = [
		s.ok ? theme.fg("success", "✓") : theme.fg("warning", "■"),
		theme.bold(s.title ?? "flow done"),
		theme.fg("dim", "·"),
		theme.fg(s.ok ? "success" : "warning", s.outcome),
		theme.fg("dim", byModel ? (took ? `· ${took}` : "") : `· ${fmtTok(total)} ${unit}${timing}`),
	].join(" ");
	const lines = [head.trimEnd()];
	if (byModel) {
		const rowsByCost = [...perModel].sort((a, b) => b[1].tokens.cost - a[1].tokens.cost);
		for (const [m, t] of rowsByCost) {
			lines.push(theme.fg("text", `  ${m} ${fmtTok(t.tokens)}`) + theme.fg("dim", ` · in ${exact(t.input)} · out ${exact(t.output)} · cache read ${exact(t.cacheRead)} · cache write ${exact(t.cacheWrite)}`));
		}
	}
	const width = 20;
	const labelWidth = Math.max(...rows.map((st) => fmtTok(stageTokens(st)).length));
	for (const stage of rows) {
		const u = s.stages[stage] ?? { tokens: zero(), main: zero(), models: [], subs: {} };
		const t = stageTokens(stage);
		const share = total.raw ? t.raw / total.raw : 0;
		const filled = t.raw ? Math.max(1, Math.round(share * width)) : 0;
		const bar = theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
		const parts: string[] = [];
		const main = asTok(u.main);
		const mains = Object.entries(u.mainByModel ?? {}).filter(([, t]) => !isZero(asTok(t)));
		if (mains.length) for (const [m, t] of mains) parts.push(`${m} ${fmtTok(asTok(t))}`);
		else if (!isZero(main)) parts.push(`${u.models.map(shortModel).join("/") || "main"} ${fmtTok(main)}`);
		for (const [role, sub] of Object.entries(u.subs)) {
			if (!sub) continue;
			const models = Object.entries(sub.byModel ?? {});
			if (models.length) for (const [m, r] of models) parts.push(`${role} ${m} ×${r.runs} ${fmtTok(asTok(r.tokens))}`);
			else parts.push(`${role} ×${sub.runs} ${fmtTok(asTok(sub.tokens))}`);
		}
		const color = t.raw || t.cost ? "text" : "dim";
		lines.push(
			`  ${theme.fg(color, stage.padEnd(8))} ${bar} ${theme.fg(color, fmtTok(t).padStart(labelWidth))} ${theme.fg("muted", `${Math.round(share * 100)}%`.padStart(4))}  ${theme.fg("dim", parts.join(" · "))}`,
		);
	}
	const tone = { head: "text", done: "success", open: "warning", fixed: "dim", noted: "muted", human: "accent" } as const;
	for (const l of reportLines(s.steps, s.findings, s.humanChecks)) lines.push(l.tone === "head" ? theme.bold(l.text) : theme.fg(tone[l.tone], l.text));
	return lines;
}

export interface FlowProgress {
	stage?: number;
	stages?: number;
	done: number;
	total: number;
	/** `<id> <text>` of the first open step. */
	current?: string;
	judgeRound: number;
	waiting?: string;
}

/** The one-line progress of the executing plan: stage, step bar, current step, judge round, wait. */
export function progressLine(p: FlowProgress, theme: Theme): string {
	const parts: string[] = [];
	if (p.stage !== undefined && p.stages !== undefined) parts.push(theme.fg("muted", `stage ${p.stage}/${p.stages}`));
	parts.push(`${theme.fg("accent", progressBar(p.done, p.total, 10))} ${theme.fg("muted", `${p.done}/${p.total}`)}`);
	if (p.total > 0 && p.done >= p.total) parts.push(theme.fg("muted", "all steps done"));
	else if (p.current) parts.push(theme.fg("muted", `now ${p.current.slice(0, 50)}`));
	if (p.judgeRound > 0) parts.push(theme.fg("muted", `judge round ${p.judgeRound}`));
	if (p.waiting) parts.push(theme.fg("warning", `waiting: ${p.waiting.slice(0, 40)}`));
	return `  ${parts.join(theme.fg("dim", " · "))}`;
}

export class FlowView {
	phase: "off" | "discuss" | "plan" | "execute" | "test" = "off";
	escalated = false;
	stage: Stage = "plan";
	roles: Record<Role, RoleSpec>;
	/** How much each kind of token counts; see WorkflowConfig.tokenWeights. */
	weights: TokenWeights = DEFAULTS.tokenWeights;
	runs: RunView[] = [];
	/** Progress of the executing plan; the widget shows it under the pipeline line. */
	progress: FlowProgress | undefined;
	/** Tokens of finished messages per stage this session, main session and subagents together. */
	used: Record<Stage, Tok> = emptyStageTokens();
	/** The same, broken down, since the current flow started; the widget shows these. */
	flow: FlowUsage = emptyFlowUsage();
	/** When the current flow spent its first token. */
	flowStarted: number | undefined;

	/** The main session's message still streaming, and the stage it started in. */
	private mainLive: { stage: Stage; tokens: Tok; counts: ModelCounts; model?: string } | undefined;
	private nextId = 1;
	private tui: TUI | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private mounted = false;

	constructor(roles: Record<Role, RoleSpec>) {
		this.roles = roles;
	}

	/** Mounts the widget once per UI; later changes only request a re-render. */
	mount(ui: { setWidget: (key: string, content: any, options?: any) => void }): void {
		if (this.mounted) return this.changed();
		this.mounted = true;
		ui.setWidget("workflow", (tui: TUI, theme: Theme): Component & { dispose(): void } => {
			this.tui = tui;
			return {
				render: (width: number) => this.render(theme).map((l) => truncateToWidth(l, width)),
				invalidate: () => undefined,
				dispose: () => {
					this.stopTicker();
					this.tui = undefined;
					this.mounted = false;
				},
			};
		});
	}

	changed(): void {
		const running = this.runs.some((r) => r.status === "running");
		if (running && !this.ticker) this.ticker = setInterval(() => this.tui?.requestRender(), 100);
		if (!running) this.stopTicker();
		this.tui?.requestRender();
	}

	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	start(role: SubRole, label: string, model: string = this.roles[role].model): RunView {
		this.clearFinished(15_000);
		const run: RunView = {
			id: this.nextId++,
			role,
			model: shortModel(model),
			label,
			started: Date.now(),
			status: "running",
			activity: "starting…",
			tools: 0,
			tokens: zero(),
			liveTokens: zero(),
			liveCounts: noCounts(),
			stage: role === "judge" || role === "arbiter" ? "judge" : this.stage,
		};
		const sub = (this.flow[run.stage].subs[role] ??= { tokens: zero(), runs: 0 });
		sub.runs++;
		const bySub = ((sub.byModel ??= {})[modelKey(run.model)] ??= { tokens: zero(), runs: 0 });
		bySub.runs++;
		this.flowStarted ??= run.started;
		this.runs.push(run);
		this.changed();
		return run;
	}

	/** Applies a subagent event to its row. */
	event(run: RunView, e: SubagentEvent, cwd: string): void {
		if (e.type === "tool") {
			run.tools++;
			run.activity = describeTool(e.name, e.args, cwd);
		} else if (e.type === "usage") {
			// Cumulative per message; a failed stream can end with empty usage, so keep the larger.
			const tokens = max(countTokens(e.usage, this.weights), e.done ? run.liveTokens : zero());
			// Counts are cumulative too: keep the latest of the message, never a sum of its events.
			const counts = maxCounts(countsOf(e.usage), e.done ? run.liveCounts : noCounts());
			if (e.done) {
				run.tokens = add(run.tokens, tokens);
				this.add(run.stage, tokens, run.role, run.model, counts);
				run.liveTokens = zero();
				run.liveCounts = noCounts();
			} else {
				run.liveTokens = tokens;
				run.liveCounts = counts;
			}
		} else if (e.type === "text" && run.role !== "explore") {
			run.activity = `writing: ${oneLine(e.text.split("\n").filter(Boolean).pop() ?? "", 50)}`;
		}
		this.changed();
	}

	finish(run: RunView, ok: boolean, outcome: string): void {
		run.status = ok ? "ok" : "fail";
		run.ended = Date.now();
		// A message cut off by an abort or timeout never ends; its tokens were still spent.
		this.add(run.stage, run.liveTokens, run.role, run.model, run.liveCounts);
		run.tokens = add(run.tokens, run.liveTokens);
		run.liveTokens = zero();
		run.liveCounts = noCounts();
		run.activity = outcome;
		this.changed();
	}

	/** Usage of the main session's assistant message: cumulative while streaming, `done` once it ends. */
	mainUsage(tokens: Tok, done: boolean, model?: string, usage?: UsageCounts): void {
		this.mainLive ??= { stage: this.stage, tokens: zero(), counts: noCounts() };
		this.flowStarted ??= Date.now();
		const counts = maxCounts(countsOf(usage), done ? this.mainLive.counts : noCounts());
		if (done) {
			// A failed stream can end with empty usage; the streamed tokens were still spent.
			this.add(this.mainLive.stage, max(tokens, this.mainLive.tokens), "main", model ?? this.mainLive.model, counts);
			this.mainLive = undefined;
		} else if (same(tokens, this.mainLive.tokens)) {
			return;
		} else {
			this.mainLive.tokens = tokens;
			this.mainLive.counts = counts;
			if (model) this.mainLive.model = model;
		}
		this.changed();
	}

	/** Counts a main-session message that never ended (e.g. aborted) as spent. */
	settleMain(): void {
		if (this.mainLive) this.mainUsage(this.mainLive.tokens, true, this.mainLive.model);
	}

	private add(stage: Stage, tokens: Tok, source: "main" | SubRole, model?: string, counts: ModelCounts = noCounts()): void {
		this.used[stage] = add(this.used[stage], tokens);
		const u = this.flow[stage];
		u.tokens = add(u.tokens, tokens);
		const key = addToModel(u, model, tokens, counts);
		if (source === "main") {
			u.main = add(u.main, tokens);
			if (model && !u.models.includes(model)) u.models.push(model);
			const m = (u.mainByModel ??= {});
			m[key] = add(m[key] ?? zero(), tokens);
		} else {
			// runs is 0 when the run started before this flow did.
			const sub = (u.subs[source] ??= { tokens: zero(), runs: 0 });
			sub.tokens = add(sub.tokens, tokens);
			sub.runs ||= 1;
			const bySub = ((sub.byModel ??= {})[key] ??= { tokens: zero(), runs: 0 });
			bySub.tokens = add(bySub.tokens, tokens);
			bySub.runs ||= 1;
		}
	}

	private liveTokens(stage: Stage): Tok {
		let n = this.mainLive?.stage === stage ? this.mainLive.tokens : zero();
		for (const r of this.runs) if (r.stage === stage) n = add(n, r.liveTokens);
		return n;
	}

	/** The current flow's finished plus in-flight tokens of a stage. */
	stageTokens(stage: Stage): Tok {
		return add(this.flow[stage].tokens, this.liveTokens(stage));
	}

	/** The session's finished plus in-flight tokens of a stage. */
	sessionTokens(stage: Stage): Tok {
		return add(this.used[stage], this.liveTokens(stage));
	}

	/** Closes the current flow: returns its summary and starts counting the next one from zero. */
	endFlow(outcome: string, ok: boolean): FlowSummary {
		const summary = this.peekFlow(outcome, ok);
		this.flow = emptyFlowUsage();
		this.flowStarted = undefined;
		this.changed();
		return summary;
	}

	/** The current flow so far, including the message still streaming and running subagents. */
	peekFlow(outcome: string, ok: boolean): FlowSummary {
		const stages = structuredClone(this.flow);
		if (this.mainLive) {
			const st = stages[this.mainLive.stage];
			st.tokens = add(st.tokens, this.mainLive.tokens);
			st.main = add(st.main, this.mainLive.tokens);
			const key = addToModel(st, this.mainLive.model, this.mainLive.tokens, this.mainLive.counts);
			const m = (st.mainByModel ??= {});
			m[key] = add(m[key] ?? zero(), this.mainLive.tokens);
		}
		for (const r of this.runs) {
			if (isZero(r.liveTokens)) continue;
			const st = stages[r.stage];
			st.tokens = add(st.tokens, r.liveTokens);
			const sub = (st.subs[r.role] ??= { tokens: zero(), runs: 0 });
			sub.tokens = add(sub.tokens, r.liveTokens);
			const key = addToModel(st, r.model, r.liveTokens, r.liveCounts);
			const bySub = ((sub.byModel ??= {})[key] ??= { tokens: zero(), runs: 0 });
			bySub.tokens = add(bySub.tokens, r.liveTokens);
			bySub.runs ||= 1;
		}
		return { outcome, ok, started: this.flowStarted, ended: Date.now(), stages };
	}

	hasFlowUsage(): boolean {
		return STAGES.some((s) => this.flow[s].tokens.raw > 0);
	}

	/** Drops rows that finished more than `maxAgeMs` ago. */
	clearFinished(maxAgeMs = 0): void {
		const cutoff = Date.now() - maxAgeMs;
		this.runs = this.runs.filter((r) => r.status === "running" || (r.ended ?? 0) > cutoff);
		this.changed();
	}

	private render(theme: Theme): string[] {
		if (this.phase === "off" && this.runs.length === 0) return [];
		const lines: string[] = [];

		if (this.phase !== "off") {
			const node = (stage: Stage, role: Role | null) => {
				const active = this.stage === stage;
				// Escalation swaps the main session's model, i.e. the current phase's node.
				const escalated = this.escalated && stage === this.phase;
				const spec = escalated ? this.roles.escalate : role ? this.roles[role] : null;
				const model = spec ? ` ${short(spec)}${escalated ? " ↑" : ""}` : "";
				const n = this.stageTokens(stage);
				const tokens = isZero(n) ? "" : theme.fg(active ? "toolOutput" : "muted", ` ${fmtTok(n)}`);
				if (!active) return (escalated ? theme.fg("warning", `${stage}${model}`) : theme.fg("dim", `${stage}${model}`)) + tokens;
				const color = escalated ? "warning" : "accent";
				return theme.fg(color, theme.bold(`● ${stage.toUpperCase()}`)) + theme.fg(color, model) + tokens;
			};
			const sep = theme.fg("dim", " ▸ ");
			const total = STAGES.reduce((sum, s) => add(sum, this.stageTokens(s)), zero());
			const discussNode = this.stage === "discuss" || !isZero(this.stageTokens("discuss")) ? `${node("discuss", "discuss")}${sep}` : "";
			const testNode = this.stage === "test" || !isZero(this.stageTokens("test")) ? `${node("test", "test")}${sep}` : "";
			const commitNode = this.stage === "commit" || !isZero(this.stageTokens("commit")) ? `${sep}${node("commit", null)}` : "";
			lines.push(
				`${theme.fg("muted", "flow ")} ${discussNode}${node("plan", "plan")}${sep}${testNode}${node("execute", "execute")}${sep}${node("judge", "judge")}${commitNode}${isZero(total) ? "" : theme.fg("dim", ` · Σ ${fmtTok(total)}`)}`,
			);
			if (this.progress) lines.push(progressLine(this.progress, theme));
		}

		this.runs.forEach((run, i) => {
			const branch = i === this.runs.length - 1 ? "└" : "├";
			lines.push(`  ${theme.fg("dim", branch)} ${runLine(run, theme, { showRole: true })}`);
		});
		return lines;
	}

	describe(role: Role): string {
		return describeRole(this.roles[role]);
	}
}
