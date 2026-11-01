/**
 * Run cards: one row per sub-agent run, with what it is doing right now.
 * The agents extension draws its tool rows with these; the workflow widget adds
 * its stage accounting on top (workflow/view.ts).
 *
 *   ⠹ explore  haiku-5-5  where is average defined?   grep /average/ in src · 3 tools · 12,004 (2,100) tok · 12s
 */

import * as os from "node:os";
import * as path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { add, asTok, countsOf, countTokens, fmtTok, isZero, max, maxCounts, type ModelCounts, noCounts, type Tok, type TokenWeights, type UsageCounts, zero } from "./tokens.ts";

export interface RunView {
	id: number;
	role: string;
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
}

/** What a sub-agent reports while it runs (agents/subagent.ts emits these). */
export type RunEvent =
	| { type: "tool"; name: string; args: Record<string, unknown> }
	| { type: "text"; text: string }
	/** Usage of the assistant message in flight (cumulative while streaming); `done` once it ends. */
	| { type: "usage"; usage: UsageCounts; done: boolean };

/** Tokens a run spent that its owner may count somewhere else. */
export interface Spent {
	tokens: Tok;
	counts: ModelCounts;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function shortModel(spec: string): string {
	return spec.split("/").pop()?.replace(/^claude-/, "") ?? spec;
}

export function oneLine(s: string, max = 60): string {
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

/** A fresh row for a run that is starting. */
export function newRun(id: number, role: string, label: string, model: string): RunView {
	return {
		id,
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
	};
}

/** Applies a sub-agent event to its row; returns what a message that just ended spent. */
export function applyEvent(run: RunView, e: RunEvent, cwd: string, weights: TokenWeights): Spent | undefined {
	if (e.type === "tool") {
		run.tools++;
		run.activity = describeTool(e.name, e.args, cwd);
	} else if (e.type === "usage") {
		// Cumulative per message; a failed stream can end with empty usage, so keep the larger.
		const tokens = max(countTokens(e.usage, weights), e.done ? run.liveTokens : zero());
		// Counts are cumulative too: keep the latest of the message, never a sum of its events.
		const counts = maxCounts(countsOf(e.usage), e.done ? run.liveCounts : noCounts());
		if (!e.done) {
			run.liveTokens = tokens;
			run.liveCounts = counts;
			return undefined;
		}
		run.tokens = add(run.tokens, tokens);
		run.liveTokens = zero();
		run.liveCounts = noCounts();
		return { tokens, counts };
	} else if (e.type === "text" && run.role !== "explore") {
		run.activity = `writing: ${oneLine(e.text.split("\n").filter(Boolean).pop() ?? "", 50)}`;
	}
	return undefined;
}

/** Marks a run finished; returns the tokens of a message cut off by an abort or timeout, which were still spent. */
export function endRun(run: RunView, ok: boolean, outcome: string): Spent {
	const spent = { tokens: run.liveTokens, counts: run.liveCounts };
	run.status = ok ? "ok" : "fail";
	run.ended = Date.now();
	run.tokens = add(run.tokens, run.liveTokens);
	run.liveTokens = zero();
	run.liveCounts = noCounts();
	run.activity = outcome;
	return spent;
}

/** One row per run, shared by the workflow widget and the tool renderers. */
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
