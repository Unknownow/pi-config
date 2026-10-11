/**
 * Live view of the workflow: a widget above the editor with the pipeline
 * (active stage highlighted, with its model) and one row per subagent run,
 * showing what each one is doing right now.
 *
 *   ● flow  plan opus-5-5·high ▸ EXECUTE sonnet-5-5·medium ▸ judge opus-5-5·high ▸ commit
 *     ├ ⠹ explore  haiku-5-5  where is average defined?   grep /average/ in src · 3 tools · 12s
 *     └ ✓ judge    opus-5-5   FAIL · 3 findings · 41s
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
	tokens: number;
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

export function elapsed(run: RunView): string {
	const s = Math.round(((run.ended ?? Date.now()) - run.started) / 1000);
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
	const stats = [run.tools ? `${run.tools} tool${run.tools > 1 ? "s" : ""}` : "", run.tokens ? `${Math.round(run.tokens / 1000)}k tok` : "", elapsed(run)]
		.filter(Boolean)
		.join(" · ");
	const activityColor = run.status === "fail" ? "error" : run.status === "running" ? "toolOutput" : "muted";
	return `${icon} ${role}${theme.fg("dim", oneLine(run.label, 40))}  ${theme.fg(activityColor, run.activity)} ${theme.fg("dim", `· ${stats}`)}`;
}

export class FlowView {
	phase: "off" | "plan" | "execute" = "off";
	escalated = false;
	stage: Stage = "plan";
	roles: Record<Role, RoleSpec>;
	runs: RunView[] = [];

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
		};
		this.runs.push(run);
		this.changed();
		return run;
	}

	/** Applies a subagent event to its row. */
	event(run: RunView, e: SubagentEvent, cwd: string): void {
		if (e.type === "tool") {
			run.tools++;
			run.activity = describeTool(e.name, e.args, cwd);
		} else if (e.type === "turn") {
			run.tokens = Math.max(run.tokens, e.usage.totalTokens ?? 0);
		} else if (e.type === "text" && run.role !== "explore") {
			run.activity = `writing: ${oneLine(e.text.split("\n").filter(Boolean).pop() ?? "", 50)}`;
		}
		this.changed();
	}

	finish(run: RunView, ok: boolean, outcome: string): void {
		run.status = ok ? "ok" : "fail";
		run.ended = Date.now();
		run.activity = outcome;
		this.changed();
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
				if (!active) return escalated ? theme.fg("warning", `${stage}${model}`) : theme.fg("dim", `${stage}${model}`);
				const color = escalated ? "warning" : "accent";
				return theme.fg(color, theme.bold(`● ${stage.toUpperCase()}`)) + theme.fg(color, model);
			};
			const sep = theme.fg("dim", " ▸ ");
			lines.push(
				`${theme.fg("muted", "flow ")} ${node("plan", "plan")}${sep}${node("execute", "execute")}${sep}${node("judge", "judge")}${sep}${node("commit", null)}`,
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
