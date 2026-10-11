/**
 * Workflow extension: one model per job.
 *
 *   you -> plan (Opus, high) -> approve -> execute (Sonnet, medium) -> judge (Opus) -> commit
 *                                             |-- explore (Haiku, parallel): file:line only
 *                                             `-- advisor (Opus): reads the full transcript at decision points
 *
 *   escalation (manual)  /flow escalate -> Fable, /flow back -> the phase's own model
 *   context guard        compact at ~140k tokens on every model
 *
 * plan and execute switch the main session's model. explore, advisor and judge
 * are tools that run their role in a separate `pi` process (see subagent.ts).
 * Every model and thinking level comes from ~/.pi/agent/workflow.json, which
 * pi-config syncs between machines; `/flow model` edits it.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, StringEnum } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	CONFIG_PATH,
	describeRole,
	loadConfig,
	parseRoleSpec,
	ROLES,
	type Role,
	saveRole,
	type WorkflowConfig,
} from "./config.ts";
import * as prompts from "./prompts.ts";
import { addUsage, emptyUsage, mapLimit, runSubagent } from "./subagent.ts";

type Phase = "off" | "plan" | "execute";

interface FlowState {
	phase: Phase;
	/** Main session is on the escalate model instead of the phase's own. */
	escalated: boolean;
	judgeRounds: number;
	/** Hash of the last diff the judge passed. */
	passedDiff?: string;
	/** Active tools before plan mode switched some off. */
	toolsBeforePlan?: string[];
}

const STATE_ENTRY = "workflow-state";
const OWN_TOOLS = new Set(["explore", "advisor", "judge"]);

interface Diff {
	text: string;
	hash: string;
	files: number;
	truncated: boolean;
}

function assistantText(m: AgentMessage | undefined): string {
	if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
	return m.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

function shortModel(spec: string): string {
	return spec.split("/").pop()?.replace(/^claude-/, "") ?? spec;
}

export default function workflow(pi: ExtensionAPI) {
	let { config: cfg, error: configError } = loadConfig();
	let state: FlowState = { phase: "off", escalated: false, judgeRounds: 0 };
	/** Diffs already judged or declined this session, so agent_end doesn't ask twice. */
	const seenDiffs = new Set<string>();
	let consecutiveErrors = 0;
	let guardTokens: number | null = null;
	let compacting = false;

	pi.registerFlag("flow", {
		description: "Workflow phase to start in: plan, execute or off (default from workflow.json)",
		type: "string",
	});

	// ----------------------------------------------------------------------
	// Phases and models
	// ----------------------------------------------------------------------

	function persist(): void {
		pi.appendEntry(STATE_ENTRY, state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (state.phase === "off") {
			ctx.ui.setStatus("workflow", undefined);
			return;
		}
		const role: Role = state.escalated ? "escalate" : state.phase;
		const label = `flow:${state.phase}${state.escalated ? " ↑" : ""} ${shortModel(cfg.roles[role].model)}`;
		ctx.ui.setStatus("workflow", ctx.ui.theme.fg(state.escalated ? "warning" : "accent", label));
	}

	/** Switches the main session to a role's model and thinking level. */
	async function applyRole(ctx: ExtensionContext, role: Role): Promise<boolean> {
		const spec = cfg.roles[role];
		const slash = spec.model.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(spec.model.slice(0, slash), spec.model.slice(slash + 1)) : undefined;
		if (!model) {
			ctx.ui.notify(`workflow: model ${spec.model} (${role}) not found — check ${CONFIG_PATH}`, "error");
			return false;
		}
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`workflow: no credentials for ${spec.model} (${role})`, "error");
			return false;
		}
		if (spec.thinking) pi.setThinkingLevel(spec.thinking);
		return true;
	}

	function blockPlanTools(): void {
		state.toolsBeforePlan ??= pi.getActiveTools();
		pi.setActiveTools(state.toolsBeforePlan.filter((t) => !cfg.planBlockedTools.includes(t)));
	}

	function restorePlanTools(): void {
		if (!state.toolsBeforePlan) return;
		const extra = pi.getActiveTools().filter((t) => !state.toolsBeforePlan!.includes(t));
		pi.setActiveTools([...state.toolsBeforePlan, ...extra]);
		state.toolsBeforePlan = undefined;
	}

	async function setPhase(ctx: ExtensionContext, phase: Phase): Promise<void> {
		if (state.phase === "plan" && phase !== "plan") restorePlanTools();
		if (phase === "plan") blockPlanTools();
		state.phase = phase;
		state.escalated = false;
		state.judgeRounds = 0;
		consecutiveErrors = 0;
		if (phase !== "off") await applyRole(ctx, phase);
		persist();
		updateStatus(ctx);
	}

	async function approve(ctx: ExtensionContext): Promise<void> {
		await setPhase(ctx, "execute");
		pi.sendMessage(
			{
				customType: "workflow-execute",
				content: "Plan approved. Execute it now, step by step, following the workflow rules.",
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	async function escalate(ctx: ExtensionContext): Promise<void> {
		if (await applyRole(ctx, "escalate")) {
			state.escalated = true;
			persist();
			updateStatus(ctx);
			ctx.ui.notify(`workflow: escalated to ${describeRole(cfg.roles.escalate)}. /flow back to return.`, "warning");
		}
	}

	async function deescalate(ctx: ExtensionContext): Promise<void> {
		state.escalated = false;
		if (state.phase !== "off") await applyRole(ctx, state.phase);
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`workflow: back to ${state.phase}${state.phase === "off" ? "" : ` on ${describeRole(cfg.roles[state.phase])}`}`, "info");
	}

	// ----------------------------------------------------------------------
	// Subagent helpers
	// ----------------------------------------------------------------------

	function runRole(role: "explore" | "advisor" | "judge", opts: { systemPrompts: string[]; tools: string[]; task: string; cwd: string; signal?: AbortSignal; onProgress?: (text: string) => void }) {
		return runSubagent({
			...opts,
			role: cfg.roles[role],
			extensions: cfg.subagent.extensions,
			timeoutMs: cfg.subagent.timeoutMs,
		});
	}

	async function git(cwd: string, ...args: string[]) {
		return pi.exec("git", ["-C", cwd, ...args], { timeout: 30_000 });
	}

	/** Tracked changes against `base` plus untracked files, or null outside a git work tree. */
	async function collectDiff(cwd: string, base = "HEAD"): Promise<Diff | null> {
		if ((await git(cwd, "rev-parse", "--is-inside-work-tree")).code !== 0) return null;
		let tracked = await git(cwd, "diff", "--no-color", base);
		if (tracked.code !== 0) tracked = await git(cwd, "diff", "--no-color"); // no commits yet
		const parts = [tracked.stdout];
		let files = (tracked.stdout.match(/^diff --git /gm) ?? []).length;

		const untracked = (await git(cwd, "ls-files", "--others", "--exclude-standard", "-z")).stdout.split("\0").filter(Boolean);
		for (const rel of untracked) {
			files++;
			try {
				const buf = fs.readFileSync(path.join(cwd, rel));
				if (buf.length > 200_000 || buf.includes(0)) {
					parts.push(`\n=== new file: ${rel} (${buf.length} bytes, binary or too large, not shown) ===\n`);
					continue;
				}
				const numbered = buf
					.toString("utf8")
					.split("\n")
					.map((l, i) => `+${i + 1}: ${l}`)
					.join("\n");
				parts.push(`\n=== new file: ${rel} ===\n${numbered}\n`);
			} catch {
				parts.push(`\n=== new file: ${rel} (unreadable) ===\n`);
			}
		}

		const full = parts.join("").trim();
		const hash = createHash("sha1").update(full).digest("hex");
		const truncated = full.length > cfg.judge.maxDiffChars;
		const text = truncated ? `${full.slice(0, cfg.judge.maxDiffChars)}\n\n[diff truncated; read the files for the rest]` : full;
		return { text, hash, files, truncated };
	}

	/** The whole branch, compactions included, as text. */
	function transcript(ctx: ExtensionContext): string {
		const messages: AgentMessage[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") messages.push((entry as { message: AgentMessage }).message);
			else if (entry.type === "custom_message") {
				const e = entry as { content: Message["content"]; timestamp?: string };
				messages.push({ role: "user", content: e.content, timestamp: Date.now() } as AgentMessage);
			}
		}
		const text = serializeConversation(convertToLlm(messages));
		const max = cfg.advisor.maxTranscriptChars;
		if (text.length <= max) return text;
		const head = Math.floor(max * 0.3);
		return `${text.slice(0, head)}\n\n[... ${text.length - max} characters of the middle omitted ...]\n\n${text.slice(text.length - (max - head))}`;
	}

	interface JudgeResult {
		verdict: "PASS" | "FAIL" | "ERROR";
		text: string;
		hash: string;
		usage: ReturnType<typeof emptyUsage>;
	}

	async function judge(ctx: ExtensionContext, diff: Diff, focus: string | undefined, signal?: AbortSignal, onProgress?: (t: string) => void): Promise<JudgeResult> {
		const header = `## Diff under review (${diff.files} file(s)${diff.truncated ? ", truncated" : ""})\n\n`;
		const run = await runRole("judge", {
			systemPrompts: [prompts.JUDGE, header + diff.text],
			tools: cfg.judge.tools,
			task: `Review the diff in your system prompt.${focus ? ` Focus: ${focus}` : ""}`,
			cwd: ctx.cwd,
			signal,
			onProgress,
		});
		seenDiffs.add(diff.hash);
		if (!run.ok) return { verdict: "ERROR", text: `judge failed: ${run.error}`, hash: diff.hash, usage: run.usage };
		const verdict = /VERDICT:\s*PASS/i.test(run.text) && !/VERDICT:\s*FAIL/i.test(run.text) ? "PASS" : "FAIL";
		if (verdict === "PASS") {
			state.passedDiff = diff.hash;
			state.judgeRounds = 0;
			persist();
		}
		return { verdict, text: run.text, hash: diff.hash, usage: run.usage };
	}

	// ----------------------------------------------------------------------
	// Tools
	// ----------------------------------------------------------------------

	pi.registerTool({
		name: "explore",
		label: "Explore",
		description:
			"Fan out read/grep lookups to cheap parallel reader agents. Each query is a self-contained question about the codebase (e.g. 'where is the save system serialized?'). Returns only file:line references with a short note, so you can read just the lines you need.",
		promptSnippet: "explore: parallel cheap codebase lookups that return file:line references",
		parameters: Type.Object({
			queries: Type.Array(Type.String({ description: "One self-contained lookup question" }), {
				description: "Lookups to run in parallel",
				minItems: 1,
			}),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const queries = params.queries.slice(0, cfg.explore.maxQueries);
			let done = 0;
			const runs = await mapLimit(queries, cfg.explore.concurrency, async (q) => {
				const r = await runRole("explore", { systemPrompts: [prompts.EXPLORE], tools: cfg.explore.tools, task: q, cwd: ctx.cwd, signal });
				done++;
				onUpdate?.({ content: [{ type: "text", text: `explore: ${done}/${queries.length} done` }], details: undefined });
				return r;
			});
			const usage = emptyUsage();
			const sections = runs.map((r, i) => {
				addUsage(usage, r.usage);
				return `### ${queries[i]}\n${r.ok ? r.text : `(failed: ${r.error})`}`;
			});
			const dropped = params.queries.length - queries.length;
			if (dropped > 0) sections.push(`(${dropped} more queries dropped: limit is ${cfg.explore.maxQueries} per call)`);
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: undefined, usage };
		},
	});

	pi.registerTool({
		name: "advisor",
		label: "Advisor",
		description:
			"Ask a stronger model for guidance at a decision point. It reads the full session transcript, so describe only the question. Use it when choosing between approaches, when an error keeps repeating, and before declaring the task done.",
		promptSnippet: "advisor: guidance from a stronger model that reads the whole transcript",
		parameters: Type.Object({
			situation: StringEnum(["approach", "error", "done", "other"] as const, {
				description: "approach: pick between options; error: repeated failure; done: check before finishing",
			}),
			question: Type.String({ description: "The decision or question, with the options you are weighing" }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			consecutiveErrors = 0;
			const run = await runRole("advisor", {
				systemPrompts: [prompts.ADVISOR, `## Transcript of the execution agent\n\n${transcript(ctx)}`],
				tools: cfg.advisor.tools,
				task: `Situation: ${params.situation}\nQuestion: ${params.question}`,
				cwd: ctx.cwd,
				signal,
				onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
			});
			if (!run.ok) throw new Error(`advisor failed: ${run.error}`);
			return { content: [{ type: "text", text: run.text }], details: undefined, usage: run.usage };
		},
	});

	pi.registerTool({
		name: "judge",
		label: "Judge",
		description:
			"Adversarial review of the current uncommitted diff (plus untracked files) by a stronger model that assumes the change is wrong. Returns one line per finding and VERDICT: PASS or FAIL. Call it when the diff is ready; fix blocker and major findings and call it again. Do not commit before PASS.",
		promptSnippet: "judge: adversarial review of the current diff; must PASS before commit",
		parameters: Type.Object({
			focus: Type.Optional(Type.String({ description: "What the change is meant to do, or areas to scrutinize" })),
			base: Type.Optional(Type.String({ description: "Git ref to diff against. Default HEAD" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const diff = await collectDiff(ctx.cwd, params.base || "HEAD");
			if (!diff) throw new Error("not a git work tree; the judge reviews git diffs");
			if (!diff.text) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const r = await judge(ctx, diff, params.focus, signal, (text) =>
				onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
			);
			if (r.verdict === "ERROR") throw new Error(r.text);
			if (r.verdict === "FAIL") state.judgeRounds++;
			return { content: [{ type: "text", text: r.text }], details: { verdict: r.verdict }, usage: r.usage };
		},
	});

	// ----------------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (state.phase === "plan") return { systemPrompt: `${event.systemPrompt}\n\n${prompts.PLAN_PHASE}` };
		if (state.phase === "execute") return { systemPrompt: `${event.systemPrompt}\n\n${prompts.EXECUTE_PHASE}` };
	});

	// "repeated error" decision point
	pi.on("tool_result", async (event) => {
		if (state.phase !== "execute" || cfg.repeatedErrorThreshold <= 0 || OWN_TOOLS.has(event.toolName)) return;
		consecutiveErrors = event.isError ? consecutiveErrors + 1 : 0;
		if (consecutiveErrors < cfg.repeatedErrorThreshold) return;
		consecutiveErrors = 0;
		pi.sendMessage(
			{
				customType: "workflow-nudge",
				content: `${cfg.repeatedErrorThreshold} tool calls in a row have failed. Stop retrying: call the advisor tool with situation "error" before the next attempt.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});

	// Context guard: compact at a fixed size on every model, whatever its window.
	pi.on("turn_end", async (_event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		if (tokens === null || cfg.contextGuardTokens <= 0) return;
		const crossed = guardTokens !== null && guardTokens <= cfg.contextGuardTokens && tokens > cfg.contextGuardTokens;
		guardTokens = tokens;
		if (!crossed || compacting) return;
		compacting = true;
		ctx.ui.notify(`workflow: context at ${Math.round(tokens / 1000)}k, compacting`, "info");
		ctx.compact({
			onComplete: () => {
				compacting = false;
				guardTokens = null;
			},
			onError: (e) => {
				compacting = false;
				ctx.ui.notify(`workflow: compaction failed: ${e.message}`, "error");
			},
		});
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const last = [...event.messages].reverse().find((m) => m.role === "assistant");

		if (state.phase === "plan") {
			if (!/(^|\n)\s*(#+\s*)?(\*\*)?plan\b[^\n]*\n\s*(1[.)]|[-*])/i.test(assistantText(last))) return;
			const choice = await ctx.ui.select("Plan ready", [
				`Approve: execute on ${describeRole(cfg.roles.execute)}`,
				"Keep planning",
			]);
			if (choice?.startsWith("Approve")) await approve(ctx);
			return;
		}

		if (state.phase === "execute") await reviewDiff(ctx, false);
	});

	/** diff ready -> judge -> fix loop or commit. */
	async function reviewDiff(ctx: ExtensionContext, manual: boolean): Promise<void> {
		if (!manual && cfg.autoJudge === "off") return;
		const diff = await collectDiff(ctx.cwd);
		if (!diff?.text) {
			if (manual) ctx.ui.notify("workflow: no changes to review", "info");
			return;
		}
		if (!manual && (diff.hash === state.passedDiff || seenDiffs.has(diff.hash))) return;
		if (!manual && cfg.autoJudge === "ask") {
			const run = await ctx.ui.confirm("Diff ready", `Run the judge (${describeRole(cfg.roles.judge)}) on ${diff.files} changed file(s)?`);
			if (!run) {
				seenDiffs.add(diff.hash);
				return;
			}
		}

		ctx.ui.setWorkingMessage(`judge reviewing ${diff.files} file(s)…`);
		let r: JudgeResult;
		try {
			r = await judge(ctx, diff, undefined);
		} finally {
			ctx.ui.setWorkingMessage();
		}
		if (r.verdict === "ERROR") {
			ctx.ui.notify(r.text, "error");
			return;
		}
		pi.sendMessage(
			{ customType: "workflow-judge", content: `**Judge: ${r.verdict}**\n\n${r.text}`, display: true },
			{ triggerTurn: false },
		);

		if (r.verdict === "FAIL") {
			state.judgeRounds++;
			persist();
			if (state.judgeRounds >= cfg.maxJudgeRounds) {
				ctx.ui.notify(`workflow: judge failed ${state.judgeRounds} rounds in a row — your call (/flow escalate?)`, "warning");
				return;
			}
			pi.sendMessage(
				{ customType: "workflow-fix", content: "Fix the judge's blocker and major findings above, then call judge again.", display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return;
		}

		const commit = await ctx.ui.select("Judge passed", ["Commit now", "Not yet"]);
		if (commit === "Commit now") {
			pi.sendUserMessage("The judge passed. Commit these changes now with a clear message, following the repo's conventions. Do not push.", {
				deliverAs: "followUp",
			});
		}
	}

	pi.on("session_start", async (event, ctx) => {
		const loaded = loadConfig();
		cfg = loaded.config;
		configError = loaded.error;
		if (configError) ctx.ui.notify(`workflow: bad config, using defaults: ${configError}`, "error");

		const saved = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === STATE_ENTRY)
			.pop() as { data?: FlowState } | undefined;

		if (saved?.data) {
			// Pi restores the session's model itself; only the tool set needs re-applying.
			state = { ...saved.data };
			if (state.phase === "plan") blockPlanTools();
			updateStatus(ctx);
			return;
		}
		if (event.reason === "reload") return;

		const flag = pi.getFlag("flow");
		const start = (typeof flag === "string" && ["plan", "execute", "off"].includes(flag) ? flag : cfg.startPhase) as Phase;
		state = { phase: "off", escalated: false, judgeRounds: 0 };
		if (start !== "off") await setPhase(ctx, start);
	});

	// ----------------------------------------------------------------------
	// /flow
	// ----------------------------------------------------------------------

	const SUBCOMMANDS = [
		{ value: "status", label: "status - phase, models, config path" },
		{ value: "plan", label: "plan - plan phase (read-only, planner model)" },
		{ value: "approve", label: "approve - approve the plan, switch to execute and start" },
		{ value: "execute", label: "execute - execute phase without sending anything" },
		{ value: "off", label: "off - leave the workflow; model stays as is" },
		{ value: "escalate", label: "escalate - switch to the escalate model (Fable)" },
		{ value: "back", label: "back - return to the phase's own model" },
		{ value: "judge", label: "judge - review the current diff now" },
		{ value: "model", label: "model <role> <provider/id[:thinking]> - set a role's model" },
		{ value: "reload", label: "reload - re-read workflow.json" },
	];

	function statusText(): string {
		const lines = [
			`phase      ${state.phase}${state.escalated ? " (escalated)" : ""}`,
			`judge     ${state.judgeRounds} failed round(s); auto=${cfg.autoJudge}`,
			`guard     compact at ${cfg.contextGuardTokens || "off"} tokens`,
			"",
			...ROLES.map((r) => `${r.padEnd(9)} ${describeRole(cfg.roles[r])}`),
			"",
			`config    ${CONFIG_PATH}${fs.existsSync(CONFIG_PATH) ? "" : " (not created, using defaults)"}`,
		];
		if (configError) lines.push(`error     ${configError}`);
		return lines.join("\n");
	}

	pi.registerCommand("flow", {
		description: "Plan -> execute -> judge workflow with a model per role",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts[0] === "model" && parts.length === 2) {
				return ROLES.filter((r) => r.startsWith(parts[1])).map((r) => ({ value: `model ${r} `, label: `${r} (${describeRole(cfg.roles[r])})` }));
			}
			const matches = SUBCOMMANDS.filter((c) => c.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (sub.toLowerCase()) {
				case "status":
					ctx.ui.notify(statusText(), "info");
					return;
				case "plan":
				case "execute":
				case "off":
					await setPhase(ctx, sub.toLowerCase() as Phase);
					ctx.ui.notify(`workflow: ${state.phase}`, "info");
					return;
				case "approve":
					await approve(ctx);
					return;
				case "escalate":
				case "fable":
					await escalate(ctx);
					return;
				case "back":
				case "opusplan":
					await deescalate(ctx);
					return;
				case "judge":
					await reviewDiff(ctx, true);
					return;
				case "reload": {
					const loaded = loadConfig();
					cfg = loaded.config;
					configError = loaded.error;
					updateStatus(ctx);
					ctx.ui.notify(configError ? `workflow: ${configError}` : statusText(), configError ? "error" : "info");
					return;
				}
				case "model": {
					const [role, spec] = rest;
					if (!role || !ROLES.includes(role as Role)) {
						ctx.ui.notify(`Usage: /flow model <${ROLES.join("|")}> <provider/id[:thinking]>`, "warning");
						return;
					}
					const input = spec ?? (await ctx.ui.input(`Model for ${role}`, describeRole(cfg.roles[role as Role])));
					if (!input) return;
					const parsed = parseRoleSpec(input);
					if (typeof parsed === "string") {
						ctx.ui.notify(`workflow: ${parsed}`, "error");
						return;
					}
					saveRole(role as Role, parsed);
					cfg = loadConfig().config;
					const live = state.escalated ? role === "escalate" : role === state.phase;
					if (live) await applyRole(ctx, role as Role);
					updateStatus(ctx);
					ctx.ui.notify(`workflow: ${role} -> ${describeRole(parsed)} (saved to workflow.json)`, "info");
					return;
				}
				default:
					ctx.ui.notify(`Unknown: ${sub}. Try: ${SUBCOMMANDS.map((c) => c.value).join(", ")}`, "warning");
			}
		},
	});
}
