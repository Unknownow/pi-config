/**
 * Agents extension: helpers that run as separate `pi` processes, usable in every session.
 *
 *   explore    cheap read-only model answers open questions about the code (parallel)
 *   advisor    stronger model reads the whole transcript at a decision point
 *   test_run   cheap runners execute test task cards, results verified against the commands run
 *
 * Models, thinking levels and limits come from ~/.pi/agent/agents.json. Each finished run emits
 * `agents:subagent-finished` on pi.events; the workflow extension counts it while a flow is active.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, StringEnum } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, serializeConversation } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentRole, CONFIG_PATH, loadConfig } from "./config.ts";
import * as prompts from "./prompts.ts";
import { renderRuns, toolProgress } from "./render.ts";
import { RUNNER_GUARD_ENV, type RunnerGuardSpec } from "./runner-guard.ts";
import { addUsage, emptyUsage, mapLimit, noContextFilesFor, type RunResult, runSubagent } from "./subagent.ts";
import { callDir, formatTaskResult, parseRunnerReply, runnerGate, sanitizeIds, scheduleTasks, taskCard, taskRecord, type TestTask, verifyRun } from "./test-run.ts";
import { FlowView, type RunView, shortModel } from "../workflow/view.ts";
import { forwardedServers, roleTools } from "./knowledge.ts";
import { foldersForCwd } from "./session-folders.ts";
import { knowledgeTools } from "./prompts.ts";
import { uniqueRoots } from "../workflow/repos.ts";

const EXPLORE_REASONS = ["question", "broad_search", "timeout", "too_much_output", "location_unknown", "parallel_lookups"] as const;

/** Subagent-only extension that registers forwarded MCP servers (see mcp-forward.ts). */
const FORWARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "agents", "mcp-forward.ts");
/** Subagent-only extension that guards the runners' bash (see runner-guard.ts). */
const RUNNER_GUARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "agents", "runner-guard.ts");
/** The workflow publishes the session's added folders as a custom entry of this type. */

export default function agents(pi: ExtensionAPI) {
	// Tracks the live rows of this extension's own runs; the workflow widget is not involved.
	const view = new FlowView(loadConfig().config.roles as never);
	pi.on("session_start", (_e, ctx) => {
		const error = loadConfig().error;
		if (error) ctx.ui.notify(`agents: ${error}`, "warning");
	});
	const runnerSlots = runnerGate(() => loadConfig().config.test.concurrency);

	/** The knowledge tools and server config a subagent role gets, or undefined when knowledge is off for it. */
	function knowledgeFor(role: AgentRole) {
		const k = loadConfig().config.knowledge;
		if (!k.server || !k.roles.includes(role) || !fs.existsSync(FORWARD_EXTENSION)) return undefined;
		const servers = forwardedServers(pi.getMcpServers(), k);
		return servers[k.server] ? { tools: roleTools(role, k), servers } : undefined;
	}

	/** Runs a role as a subagent with a live row; `onChange` fires on every update. */
	async function runAgent(
		role: AgentRole,
		label: string,
		opts: { systemPrompts: string[]; tools: string[]; task: string; cwd: string; signal?: AbortSignal; env?: Record<string, string>; extensions?: string[]; timeoutMs?: number },
		onChange?: (run: RunView) => void,
	): Promise<{ result: RunResult; run: RunView }> {
		const cfg = loadConfig().config;
		const spec = cfg.roles[role];
		const run = view.start(role, label, spec.model);
		onChange?.(run);
		const { extensions, timeoutMs, ...rest } = opts;
		const k = knowledgeFor(role);
		const started = Date.now();
		const result = await runSubagent({
			...rest,
			noContextFiles: noContextFilesFor(role, cfg.explore.contextFiles),
			tools: k ? [...rest.tools, ...k.tools] : rest.tools,
			systemPrompts: k ? [...rest.systemPrompts, knowledgeTools(k.tools)] : rest.systemPrompts,
			mcp: k ? { servers: k.servers, extension: FORWARD_EXTENSION } : undefined,
			role: spec,
			extensions: extensions ? [...cfg.subagent.extensions, ...extensions] : cfg.subagent.extensions,
			timeoutMs: timeoutMs ?? cfg.subagent.timeoutMs,
			idleTimeoutMs: cfg.subagent.idleTimeoutMs,
			onEvent: (e) => {
				view.event(run, e, opts.cwd);
				onChange?.(run);
			},
		});
		if (!result.ok) view.finish(run, false, result.error ?? "failed");
		pi.events.emit("agents:subagent-finished", {
			role,
			label,
			ms: Date.now() - started,
			usage: result.usage,
			model: result.model ?? spec.model,
			ok: result.ok,
			error: result.error,
			bootMs: result.bootMs,
			turns: result.turns,
			tools: result.toolCalls.length,
		});
		return { result, run };
	}

	const title = (theme: { fg: (c: string, s: string) => string; bold: (s: string) => string }, name: string, role: AgentRole) =>
		theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", shortModel(loadConfig().config.roles[role].model));

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
		const max = loadConfig().config.advisor.maxTranscriptChars;
		if (text.length <= max) return text;
		const head = Math.floor(max * 0.3);
		return `${text.slice(0, head)}\n\n[... ${text.length - max} characters of the middle omitted ...]\n\n${text.slice(text.length - (max - head))}`;
	}

	/** Folders the workflow extension added to this session (newest `session-folders` entry for this working folder) that still exist. */
	function sessionFolders(ctx: ExtensionContext): string[] {
		return foldersForCwd(ctx.sessionManager.getBranch(), ctx.cwd).filter((f) => {
			try {
				return fs.statSync(f).isDirectory();
			} catch {
				return false;
			}
		});
	}

	/** The work tree's top folder containing `dir`, or null. */
	async function gitRoot(dir: string): Promise<string | null> {
		if (!fs.existsSync(dir)) return null;
		const r = await pi.exec("git", ["-C", dir, "rev-parse", "--show-toplevel"], { timeout: 30_000 });
		return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
	}

	pi.registerTool({
		name: "explore",
		label: "Explore",
		description:
			"Ask a cheap explorer model questions about the codebase, in parallel. Use it for open questions and multi-file searches ('how does the save system serialize state?', 'where is X handled?'); read files you already know yourself. Each query is self-contained. Returns a short answer with file:line evidence; check the evidence before relying on it.",
		promptSnippet: "explore: ask a cheap model open questions about the codebase (answer + file:line evidence)",
		parameters: Type.Object({
			reason: StringEnum(EXPLORE_REASONS, {
				description:
					"Why: question (an open question about how something works), broad_search (a search across many files), timeout, too_much_output, location_unknown (no idea where to look), parallel_lookups (several independent lookups, e.g. across repos)",
			}),
			queries: Type.Array(Type.String({ description: "One self-contained lookup question" }), {
				description: "Lookups to run in parallel",
				minItems: 1,
			}),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const cfg = loadConfig().config;
			const queries = params.queries.slice(0, cfg.explore.maxQueries);
			const progress = toolProgress(onUpdate);
			const results = await mapLimit(queries, cfg.explore.concurrency, async (q) => {
				const { result, run } = await runAgent("explore", `[${params.reason}] ${q}`, { systemPrompts: [prompts.EXPLORE], tools: cfg.explore.tools, task: q, cwd: ctx.cwd, signal }, progress.track);
				if (result.ok) {
					const refs = result.text.split("\n").filter((l) => /^(?:[-*]\s+)?\S+:\d+/.test(l.trim())).length;
					view.finish(run, true, refs ? `${refs} ref${refs === 1 ? "" : "s"}` : "nothing found");
				}
				progress.track(run);
				return result;
			});
			const usage = emptyUsage();
			const sections = results.map((r, i) => {
				addUsage(usage, r.usage);
				return `### ${queries[i]}\n${r.ok ? r.text : `(failed: ${r.error})`}`;
			});
			const dropped = params.queries.length - queries.length;
			if (dropped > 0) sections.push(`(${dropped} more queries dropped: limit is ${cfg.explore.maxQueries} per call)`);
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: { runs: progress.snapshot() }, usage };
		},
		renderCall(args, theme) {
			const queries = (args.queries ?? []) as string[];
			const reason = typeof args.reason === "string" ? theme.fg("warning", ` · ${args.reason.replace(/_/g, " ")}`) : "";
			const head = `${title(theme, "explore", "explore")}${theme.fg("accent", ` ${queries.length} quer${queries.length === 1 ? "y" : "ies"}`)}${reason}`;
			return new Text(head, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 0),
	});

	pi.registerTool({
		name: "advisor",
		label: "Advisor",
		description:
			"Ask a stronger model for guidance at a decision point. It reads the full session transcript, which is expensive, so call it sparingly and describe only the question. Use it only when choosing between approaches with real consequences, or when the same error keeps repeating. Not for routine steps, small changes, or checking finished work (the judge reviews the diff).",
		promptSnippet: "advisor: guidance from a stronger model that reads the whole transcript",
		parameters: Type.Object({
			situation: StringEnum(["approach", "error", "other"] as const, {
				description: "approach: pick between options; error: repeated failure",
			}),
			question: Type.String({ description: "The decision or question, with the options you are weighing" }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const progress = toolProgress(onUpdate);
			const { result, run } = await runAgent(
				"advisor",
				`[${params.situation}] ${params.question}`,
				{
					systemPrompts: [prompts.ADVISOR, `## Transcript of the execution agent\n\n${transcript(ctx)}`],
					tools: loadConfig().config.advisor.tools,
					task: `Situation: ${params.situation}\nQuestion: ${params.question}`,
					cwd: ctx.cwd,
					signal,
				},
				progress.track,
			);
			if (!result.ok) throw new Error(`advisor failed: ${result.error}`);
			view.finish(run, true, "guidance ready");
			return { content: [{ type: "text", text: result.text }], details: { runs: progress.snapshot() }, usage: result.usage };
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "advisor", "advisor")} ${theme.fg("accent", `[${args.situation ?? "…"}]`)} ${theme.fg("dim", String(args.question ?? ""))}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 8),
	});

	pi.registerTool({
		name: "test_run",
		label: "Test run",
		description:
			"Send cheap runner agents to run test tasks, in parallel. Each task is a card: exact commands to run (run), what to capture (observe), and when it passes (pass). Tasks that share a resource (e.g. unity:<project>, device:<serial>) run one after another; others run together. Each result lists the commands the runner actually ran; a result marked unverified is only a claim, so rerun it. Full logs and per-task records are written to the artifacts folder.",
		promptSnippet: "test_run: run test task cards on cheap runner agents (parallel by resource), results with the commands actually run",
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "Short name for the task" }),
					run: Type.String({ description: "The exact commands or scenario to run" }),
					observe: Type.String({ description: "What to capture (output lines, logcat, screenshot, exit code)" }),
					pass: Type.String({ description: "The criteria for PASS" }),
					resource: Type.String({ description: "What the task needs alone: unity:<project folder>, device:<serial>, or none" }),
				}),
				{ description: "Test tasks", minItems: 1 },
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const cfg = loadConfig().config;
			const given = params.tasks.slice(0, cfg.test.maxTasks);
			const ids = sanitizeIds(given.map((t) => t.id));
			const tasks: TestTask[] = given.map((t, i) => ({ id: ids[i], run: t.run, observe: t.observe, pass: t.pass, resource: t.resource.trim() || "none" }));
			const progress = toolProgress(onUpdate);
			const usage = emptyUsage();
			const notes: string[] = [];
			if (params.tasks.length > given.length) notes.push(`(${params.tasks.length - given.length} more tasks dropped: limit is ${cfg.test.maxTasks} per call)`);
			if (!fs.existsSync(RUNNER_GUARD_EXTENSION)) {
				const sections = tasks.map((t) => `### ${t.id} · ${t.resource} · ERROR: runner guard extension not found at ${RUNNER_GUARD_EXTENSION}`);
				return { content: [{ type: "text", text: [...sections, ...notes].join("\n\n") }], details: { runs: [] as RunView[] }, usage };
			}
			// Records go to the temp folder; one numbered folder per call.
			const roundDir = path.join(os.tmpdir(), "pi-test-runs", `session-${process.pid}`, "runs", "1");
			fs.mkdirSync(roundDir, { recursive: true });
			let dir = roundDir;
			try {
				dir = callDir(roundDir, fs, path.join);
			} catch {
				// keep the round folder
			}
			const folders = sessionFolders(ctx);
			const tops = (await Promise.all([ctx.cwd, ...folders].map(gitRoot))).filter((r): r is string => !!r);
			const roots = uniqueRoots([...tops, ...folders, ctx.cwd].map((r) => r.replace(/\\/g, "/")));
			const spec: RunnerGuardSpec = { roots, deny: cfg.test.runnerDeny, pathFlags: cfg.test.runnerPathFlags, pathEnv: cfg.test.runnerPathEnv };
			const runnerTools = cfg.test.runnerTools.filter((t) => !/^(edit|write)$/.test(t));
			const sections = await scheduleTasks(tasks, cfg.test.concurrency, async (task) => {
				const card = taskCard(task, ctx.cwd, dir);
				const { result, run } = await runnerSlots(task.resource, () =>
					runAgent(
						"runner",
						`[${task.resource}] ${task.id}`,
						{ systemPrompts: [prompts.RUNNER], tools: runnerTools, task: card, cwd: ctx.cwd, signal, env: { [RUNNER_GUARD_ENV]: JSON.stringify(spec) }, extensions: [RUNNER_GUARD_EXTENSION], timeoutMs: cfg.test.runnerTimeoutMs },
						progress.track,
					),
				);
				addUsage(usage, result.usage);
				const reply = parseRunnerReply(result.ok ? result.text : "");
				const verified = verifyRun(reply, result.toolCalls);
				const status = result.ok ? verified.status : `ERROR: ${result.error ?? "the runner failed"}`;
				let record: string | undefined = path.join(dir, `${task.id}.md`);
				try {
					fs.writeFileSync(record, taskRecord(card, result.ok ? result.text : `(failed: ${result.error})`, result.toolCalls));
				} catch {
					record = undefined;
				}
				if (result.ok) view.finish(run, status === "PASS", status.length > 30 ? `${status.slice(0, 30)}…` : status);
				progress.track(run);
				return formatTaskResult({ id: task.id, resource: task.resource, status, reply: result.ok ? reply : undefined, ran: verified.ran, record });
			});
			return { content: [{ type: "text", text: [`Artifacts folder: ${dir}`, ...sections, ...notes].join("\n\n") }], details: { runs: progress.snapshot() }, usage };
		},
		renderCall(args, theme) {
			const n = Array.isArray(args.tasks) ? args.tasks.length : 0;
			return new Text(`${title(theme, "test_run", "runner")}${theme.fg("accent", ` ${n} task${n === 1 ? "" : "s"}`)}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 0),
	});
}
