/**
 * Live view of the workflow: a widget above the editor with the pipeline
 * (active stage highlighted, with its model) and one row per subagent run,
 * showing what each one is doing right now.
 *
 *   ● flow  plan opus-5-5·high 48k ▸ EXECUTE sonnet-5-5·medium 1.2M ▸ judge opus-5-5·high 90k ▸ commit · Σ 1.3M
 *     ├ ⠹ explore  haiku-5-5  where is average defined?   grep /average/ in src · 3 tools · 12k tok · 12s
 *     └ ✓ judge    opus-5-5   FAIL · 3 findings · 90k tok · 41s
 *
 * Token counts are live: each stage sums the main session's messages sent while
 * it was active plus the subagents run during it (judge runs count as judge),
 * including the message still streaming.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { describeRole, type Role, type RoleSpec } from "./config.ts";
import type { SubagentEvent } from "./subagent.ts";

export type Stage = "plan" | "execute" | "judge" | "commit";
export type SubRole = "explore" | "advisor" | "judge";

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
	tokens: number;
	/** Tokens of the message still streaming. */
	liveTokens: number;
	/** Pipeline stage its tokens count toward. */
	stage: Stage;
}

export const STAGES: Stage[] = ["plan", "execute", "judge", "commit"];

export function emptyStageTokens(): Record<Stage, number> {
	return { plan: 0, execute: 0, judge: 0, commit: 0 };
}

/** Where one stage's tokens went during a flow. */
export interface StageUsage {
	tokens: number;
	/** The main session's share; the rest is subagents. */
	main: number;
	models: string[];
	subs: Partial<Record<SubRole, { tokens: number; runs: number }>>;
}

export type FlowUsage = Record<Stage, StageUsage>;

export function emptyFlowUsage(): FlowUsage {
	const empty = (): StageUsage => ({ tokens: 0, main: 0, models: [], subs: {} });
	return { plan: empty(), execute: empty(), judge: empty(), commit: empty() };
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
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 999_500) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
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
	const tokens = (run.tokens ?? 0) + (run.liveTokens ?? 0); // rows saved before liveTokens existed lack it
	const stats = [run.tools ? `${run.tools} tool${run.tools > 1 ? "s" : ""}` : "", tokens ? `${formatTokens(tokens)} tok` : "", elapsed(run)]
		.filter(Boolean)
		.join(" · ");
	const activityColor = run.status === "fail" ? "error" : run.status === "running" ? "toolOutput" : "muted";
	return `${icon} ${role}${theme.fg("dim", oneLine(run.label, 40))}  ${theme.fg(activityColor, run.activity)} ${theme.fg("dim", `· ${stats}`)}`;
}

/**
 * The end-of-flow card: one bar per stage, scaled to the flow's total, with the
 * main session's and each subagent role's share.
 *
 *   ✓ flow done · committed and pushed · 1.3M tokens · 12m04s
 *     plan     ██░░░░░░░░░░░░░░░░░░    48k   4%  opus-5-5
 *     execute  █████████████████░░░   1.1M  85%  sonnet-5-5 920k · explore ×6 120k · advisor ×1 40k
 *     judge    █░░░░░░░░░░░░░░░░░░░    90k   7%  judge ×2 90k
 *     commit   ░░░░░░░░░░░░░░░░░░░░    20k   2%  sonnet-5-5
 */
export function summaryLines(s: FlowSummary, theme: Theme): string[] {
	const total = STAGES.reduce((n, st) => n + s.stages[st].tokens, 0);
	const head = [
		s.ok ? theme.fg("success", "✓") : theme.fg("warning", "■"),
		theme.bold(s.title ?? "flow done"),
		theme.fg("dim", "·"),
		theme.fg(s.ok ? "success" : "warning", s.outcome),
		theme.fg("dim", `· ${formatTokens(total)} tokens${s.started ? ` · ${elapsed({ started: s.started, ended: s.ended })}` : ""}`),
	].join(" ");
	const lines = [head];
	const width = 20;
	for (const stage of STAGES) {
		const u = s.stages[stage];
		const share = total ? u.tokens / total : 0;
		const filled = u.tokens ? Math.max(1, Math.round(share * width)) : 0;
		const bar = theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
		const parts: string[] = [];
		if (u.main) parts.push(`${u.models.map(shortModel).join("/") || "main"} ${formatTokens(u.main)}`);
		for (const [role, sub] of Object.entries(u.subs)) if (sub) parts.push(`${role} ×${sub.runs} ${formatTokens(sub.tokens)}`);
		const color = u.tokens ? "text" : "dim";
		lines.push(
			`  ${theme.fg(color, stage.padEnd(8))} ${bar} ${theme.fg(color, formatTokens(u.tokens).padStart(6))} ${theme.fg("muted", `${Math.round(share * 100)}%`.padStart(4))}  ${theme.fg("dim", parts.join(" · "))}`,
		);
	}
	return lines;
}

export class FlowView {
	phase: "off" | "plan" | "execute" = "off";
	escalated = false;
	stage: Stage = "plan";
	roles: Record<Role, RoleSpec>;
	runs: RunView[] = [];
	/** Tokens of finished messages per stage this session, main session and subagents together. */
	used: Record<Stage, number> = emptyStageTokens();
	/** The same, broken down, since the current flow started; the widget shows these. */
	flow: FlowUsage = emptyFlowUsage();
	/** When the current flow spent its first token. */
	flowStarted: number | undefined;

	/** The main session's message still streaming, and the stage it started in. */
	private mainLive: { stage: Stage; tokens: number } | undefined;
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

	start(role: SubRole, label: string): RunView {
		this.clearFinished(15_000);
		const run: RunView = {
			id: this.nextId++,
			role,
			model: shortModel(this.roles[role].model),
			label,
			started: Date.now(),
			status: "running",
			activity: "starting…",
			tools: 0,
			tokens: 0,
			liveTokens: 0,
			stage: role === "judge" ? "judge" : this.stage,
		};
		const sub = (this.flow[run.stage].subs[role] ??= { tokens: 0, runs: 0 });
		sub.runs++;
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
			const tokens = Math.max(e.usage.totalTokens ?? 0, e.done ? run.liveTokens : 0);
			if (e.done) {
				run.tokens += tokens;
				this.add(run.stage, tokens, run.role);
				run.liveTokens = 0;
			} else {
				run.liveTokens = tokens;
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
		this.add(run.stage, run.liveTokens, run.role);
		run.tokens += run.liveTokens;
		run.liveTokens = 0;
		run.activity = outcome;
		this.changed();
	}

	/** Usage of the main session's assistant message: cumulative while streaming, `done` once it ends. */
	mainUsage(tokens: number, done: boolean, model?: string): void {
		this.mainLive ??= { stage: this.stage, tokens: 0 };
		this.flowStarted ??= Date.now();
		if (done) {
			// A failed stream can end with empty usage; the streamed tokens were still spent.
			this.add(this.mainLive.stage, Math.max(tokens, this.mainLive.tokens), "main", model);
			this.mainLive = undefined;
		} else if (tokens === this.mainLive.tokens) {
			return;
		} else {
			this.mainLive.tokens = tokens;
		}
		this.changed();
	}

	/** Counts a main-session message that never ended (e.g. aborted) as spent. */
	settleMain(): void {
		if (this.mainLive) this.mainUsage(this.mainLive.tokens, true);
	}

	private add(stage: Stage, tokens: number, source: "main" | SubRole, model?: string): void {
		this.used[stage] += tokens;
		const u = this.flow[stage];
		u.tokens += tokens;
		if (source === "main") {
			u.main += tokens;
			if (model && !u.models.includes(model)) u.models.push(model);
		} else {
			// runs is 0 when the run started before this flow did.
			const sub = (u.subs[source] ??= { tokens: 0, runs: 0 });
			sub.tokens += tokens;
			sub.runs ||= 1;
		}
	}

	private liveTokens(stage: Stage): number {
		let n = this.mainLive?.stage === stage ? this.mainLive.tokens : 0;
		for (const r of this.runs) if (r.stage === stage) n += r.liveTokens;
		return n;
	}

	/** The current flow's finished plus in-flight tokens of a stage. */
	stageTokens(stage: Stage): number {
		return this.flow[stage].tokens + this.liveTokens(stage);
	}

	/** The session's finished plus in-flight tokens of a stage. */
	sessionTokens(stage: Stage): number {
		return this.used[stage] + this.liveTokens(stage);
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
			stages[this.mainLive.stage].tokens += this.mainLive.tokens;
			stages[this.mainLive.stage].main += this.mainLive.tokens;
		}
		for (const r of this.runs) {
			if (!r.liveTokens) continue;
			stages[r.stage].tokens += r.liveTokens;
			const sub = (stages[r.stage].subs[r.role] ??= { tokens: 0, runs: 0 });
			sub.tokens += r.liveTokens;
		}
		return { outcome, ok, started: this.flowStarted, ended: Date.now(), stages };
	}

	hasFlowUsage(): boolean {
		return STAGES.some((s) => this.flow[s].tokens > 0);
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
				const tokens = n ? theme.fg(active ? "toolOutput" : "muted", ` ${formatTokens(n)}`) : "";
				if (!active) return (escalated ? theme.fg("warning", `${stage}${model}`) : theme.fg("dim", `${stage}${model}`)) + tokens;
				const color = escalated ? "warning" : "accent";
				return theme.fg(color, theme.bold(`● ${stage.toUpperCase()}`)) + theme.fg(color, model) + tokens;
			};
			const sep = theme.fg("dim", " ▸ ");
			const total = STAGES.reduce((sum, s) => sum + this.stageTokens(s), 0);
			lines.push(
				`${theme.fg("muted", "flow ")} ${node("plan", "plan")}${sep}${node("execute", "execute")}${sep}${node("judge", "judge")}${sep}${node("commit", null)}${total ? theme.fg("dim", ` · Σ ${formatTokens(total)}`) : ""}`,
			);
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
