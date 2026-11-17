/**
 * Agents extension: helpers that run as separate `pi` processes, usable in every session.
 *
 *   explore    cheap read-only model answers open questions about the code (parallel)
 *   advisor    stronger model reads the whole transcript at a decision point
 *   test_run   cheap runners execute test task cards, results verified against the commands run
 *   judge      adversarial read-only review of the session's diff (can be taken over: agents:judge-call)
 *   critic     adversarial read-only review of a document against the code
 *
 * Models, thinking levels and limits come from ~/.pi/agent/agents.json. Each finished run emits
 * `agents:subagent-finished` on pi.events. Other extensions use the library through api.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { agentsCompletions, agentsDescription, agentsUnknown } from "./commands.ts";
import { branchTranscript } from "../shared/transcript.ts";
import { emitClaims } from "../shared/claims.ts";
import { type Finding } from "../shared/findings.ts";
import { AGENT_ROLES, type AgentRole, CONFIG_PATH, loadConfig, saveRole } from "./config.ts";
import { ADVISOR_CAP_ENV, advisorGate, parseCap, toolEnabled, TOOLS_ENV } from "./env.ts";
import { acquireLock } from "./lock.ts";
import * as prompts from "./prompts.ts";
import { renderRuns, toolProgress } from "./render.ts";
import { collectDiffParts, runCritic, runJudge } from "./review.ts";
import { type RoleRunResult, RUNNER_GUARD_EXTENSION, runRole } from "./run-role.ts";
import { RUNNER_GUARD_ENV, type RunnerGuardSpec } from "./runner-guard.ts";
import { addUsage, emptyUsage, mapLimit } from "./subagent.ts";
import { callDir, formatTaskResult, LOCK_LOST, parseRunnerReply, runnerGate, sanitizeIds, scheduleTasks, taskCard, taskRecord, type TestTask, verifyRun } from "./test-run.ts";
import { endRun, type RunView, shortModel } from "../shared/runs.ts";
import { describeRole, parseRoleSpec, pickRoleSpec } from "../shared/roles.ts";
import { foldersForCwd } from "../shared/session-folders.ts";
import { uniqueRoots } from "../shared/repos.ts";

const EXPLORE_REASONS = ["question", "broad_search", "timeout", "too_much_output", "location_unknown", "parallel_lookups"] as const;

/** A document argument this short, on one line, naming an existing file is read from that file. */
const MAX_PATH_CHARS = 400;

/** The critic's document: the file's text when `arg` is one short line naming an existing file (relative to `cwd`), else `arg` itself. */
export function readDocument(arg: string, cwd: string): string {
	const p = arg.trim();
	if (!p || /[\r\n]/.test(p) || p.length > MAX_PATH_CHARS) return arg;
	try {
		const file = path.resolve(cwd, p);
		if (fs.statSync(file).isFile()) return fs.readFileSync(file, "utf8");
	} catch {
		// not a file: the text itself
	}
	return arg;
}

export default function agents(pi: ExtensionAPI) {
	/** Models with auth, for the `/agents model` completions; set once a session starts. */
	let availableModels: () => { provider: string; id: string; name?: string }[] = () => [];
	/** The last own judge review's findings per session, passed to the next call. */
	const lastFindings = new Map<string, Finding[]>();
	pi.on("session_start", (_e, ctx) => {
		availableModels = () => ctx.modelRegistry.getAvailable();
		const { error, warning } = loadConfig();
		if (error || warning) ctx.ui.notify(`agents: ${error ?? warning}`, "warning");
	});
	const runnerSlots = runnerGate(() => loadConfig().config.test.concurrency, (resource, signal) => acquireLock(resource, { signal }));
	const enabled = (name: string) => toolEnabled(name, process.env[TOOLS_ENV]);
	const advisorCalls = advisorGate(parseCap(process.env[ADVISOR_CAP_ENV]));
	const sessionKey = (ctx: ExtensionContext) => ctx.sessionManager.getSessionFile?.() ?? `mem-${process.pid}`;

	/** Runs a role as a subagent with a live row; `onChange` fires on every update. */
	function runAgent(
		role: AgentRole,
		label: string,
		opts: { systemPrompts: string[]; tools: string[]; task: string; cwd: string; signal?: AbortSignal; env?: Record<string, string>; extensions?: string[]; timeoutMs?: number },
		onChange?: (run: RunView) => void,
	): Promise<RoleRunResult> {
		return runRole({ ...opts, role, label, events: pi.events, mcpServers: pi.getMcpServers(), onRun: onChange });
	}

	const title = (theme: { fg: (c: string, s: string) => string; bold: (s: string) => string }, name: string, role: AgentRole) =>
		theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", shortModel(loadConfig().config.roles[role].model));

	/** The whole branch, compactions included, as text. */
	function transcript(ctx: ExtensionContext): string {
		return branchTranscript(ctx.sessionManager.getBranch(), loadConfig().config.advisor.maxTranscriptChars);
	}

	/** Folders added to this session (newest `session-folders` entry for this working folder) that still exist. */
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

	if (enabled("explore")) pi.registerTool({
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
					endRun(run, true, refs ? `${refs} ref${refs === 1 ? "" : "s"}` : "nothing found");
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

	if (enabled("advisor")) pi.registerTool({
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
			const refused = advisorCalls.take();
			if (refused) throw new Error(refused);
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
			endRun(run, true, "guidance ready");
			return { content: [{ type: "text", text: result.text }], details: { runs: progress.snapshot() }, usage: result.usage };
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "advisor", "advisor")} ${theme.fg("accent", `[${args.situation ?? "…"}]`)} ${theme.fg("dim", String(args.question ?? ""))}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 8),
	});

	if (enabled("test_run")) pi.registerTool({
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
				let held: RoleRunResult;
				let lost = false;
				try {
					held = await runnerSlots(
						task.resource,
						async (lockSignal) => {
							// a lost resource lock (another process took it over) stops the runner
							const r = await runAgent(
								"runner",
								`[${task.resource}] ${task.id}`,
								{ systemPrompts: [prompts.RUNNER], tools: runnerTools, task: card, cwd: ctx.cwd, signal: lockSignal ? AbortSignal.any([lockSignal, ...(signal ? [signal] : [])]) : signal, env: { [RUNNER_GUARD_ENV]: JSON.stringify(spec) }, extensions: [RUNNER_GUARD_EXTENSION], timeoutMs: cfg.test.runnerTimeoutMs },
								progress.track,
							);
							lost = !!lockSignal?.aborted;
							return r;
						},
						signal,
					);
				} catch (e) {
					// Aborted while waiting for the resource, another process's lock or a runner slot.
					return formatTaskResult({ id: task.id, resource: task.resource, status: `ERROR: ${(e as Error).message || "not run"}`, ran: [] });
				}
				const { result, run } = held;
				addUsage(usage, result.usage);
				if (lost) {
					endRun(run, false, LOCK_LOST);
					progress.track(run);
					return formatTaskResult({ id: task.id, resource: task.resource, status: `ERROR: ${LOCK_LOST}`, ran: [] });
				}
				const reply = parseRunnerReply(result.ok ? result.text : "");
				const verified = verifyRun(reply, result.toolCalls);
				const status = result.ok ? verified.status : `ERROR: ${result.error ?? "the runner failed"}`;
				let record: string | undefined = path.join(dir, `${task.id}.md`);
				try {
					fs.writeFileSync(record, taskRecord(card, result.ok ? result.text : `(failed: ${result.error})`, result.toolCalls));
				} catch {
					record = undefined;
				}
				if (result.ok) endRun(run, status === "PASS", status.length > 30 ? `${status.slice(0, 30)}…` : status);
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

	/** The git roots of the session: the working folder's repo and every repo of the session's added folders. */
	async function sessionRepos(ctx: ExtensionContext): Promise<string[]> {
		const tops = (await Promise.all([ctx.cwd, ...sessionFolders(ctx)].map(gitRoot))).filter((r): r is string => !!r);
		return uniqueRoots(tops.map((r) => r.replace(/\\/g, "/")));
	}

	const WHEN = "Run it when the user asks for a review, or when your current instructions (e.g. an active workflow) require it.";

	if (enabled("judge")) pi.registerTool({
		name: "judge",
		label: "Judge",
		description: `Adversarial read-only review of the current change by a stronger model that assumes it is wrong: the diff of the working folder's repo and of every repo added to this session, against the merge-base with the origin default branch (or \`base\`), plus uncommitted and untracked files. Returns findings (blocker, major, minor) and VERDICT: PASS or FAIL. ${WHEN} Fix blocker and major findings and call it again; the next call gets the previous findings.`,
		promptSnippet: "judge: adversarial review of the current diff (findings + VERDICT); run it when asked or when your instructions require it",
		parameters: Type.Object({
			base: Type.Optional(Type.String({ description: "Git ref to diff against. Default: the merge-base of HEAD with the origin default branch" })),
			focus: Type.Optional(Type.String({ description: "What the change is meant to do, or areas to scrutinize" })),
			disputes: Type.Optional(Type.String({ description: "Findings from the last review you believe are wrong, with file:line evidence. The judge verifies them against the code." })),
			full: Type.Optional(Type.Boolean({ description: "Review the whole diff. A takeover may use it; the built-in judge always reviews in full." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			// Another extension may take the call over (e.g. one that runs its own review rounds).
			const claims = emitClaims((d) => pi.events.emit("agents:judge-call", d), { v: 1, params, ctx, signal, onUpdate }, 0);
			if (claims.claimed) {
				const answer = await claims.answer;
				if (answer && typeof answer === "object" && "error" in answer && !("content" in answer)) throw new Error(String((answer as { error: unknown }).error));
				if (answer !== null && answer !== undefined) return answer as never;
			}
			const git = async (cwd: string, ...args: string[]) => {
				const r = await pi.exec("git", ["-C", cwd, ...args], { timeout: 120_000 });
				return { code: r.code, stdout: r.stdout };
			};
			const repos = await sessionRepos(ctx);
			if (!repos.length) throw new Error("no git work tree in this session (working folder or added folders); the judge reviews git diffs");
			const parts = await collectDiffParts(git, repos, params.base);
			if (!parts.some((p) => p.full.trim())) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const progress = toolProgress(onUpdate);
			const key = sessionKey(ctx);
			const r = await runJudge({
				diff: parts,
				focus: params.focus,
				disputes: params.disputes,
				previousFindings: lastFindings.get(key),
				mode: "full",
				cwd: ctx.cwd,
				signal,
				onRun: progress.track,
				events: pi.events,
				mcpServers: pi.getMcpServers(),
			});
			if (!r.ok) throw new Error(`judge failed: ${r.error}`);
			lastFindings.set(key, r.findings);
			return { content: [{ type: "text", text: r.text }], details: { runs: progress.snapshot(), verdict: r.verdict }, usage: r.usage };
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "judge", "judge")} ${theme.fg("dim", String(args.focus ?? "current diff"))}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 40),
	});

	if (enabled("critic")) pi.registerTool({
		name: "critic",
		label: "Critic",
		description: `Adversarial read-only review of a document (a plan, a brief, a design) against the code by a stronger model that assumes it is wrong: false assumptions about the code, gaps, requirements that cannot be checked, risks. Returns findings (blocker, major, minor) and VERDICT: PASS or FAIL. ${WHEN}`,
		promptSnippet: "critic: adversarial review of a document against the code (findings + VERDICT); run it when asked or when your instructions require it",
		parameters: Type.Object({
			document: Type.String({ description: "The document's text, or the path of a file holding it" }),
			about: Type.String({ description: "One line: what the document is and what it is for" }),
			criteria: Type.Optional(Type.String({ description: "What else to check" })),
			output: Type.Optional(Type.String({ description: "Extra sections the critic adds after its findings" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const document = readDocument(params.document, ctx.cwd);
			const progress = toolProgress(onUpdate);
			const r = await runCritic({
				document,
				about: params.about,
				criteria: params.criteria,
				output: params.output,
				cwd: ctx.cwd,
				signal,
				onRun: progress.track,
				events: pi.events,
				mcpServers: pi.getMcpServers(),
			});
			if (!r.ok) throw new Error(`critic failed: ${r.error}`);
			return { content: [{ type: "text", text: r.text }], details: { runs: progress.snapshot(), verdict: r.verdict }, usage: r.usage };
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "critic", "critic")} ${theme.fg("dim", String(args.about ?? "document"))}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 40),
	});

	// ----------------------------------------------------------------------
	// /agents
	// ----------------------------------------------------------------------

	const ROLES: readonly string[] = AGENT_ROLES;
	const specOf = (role: string) => loadConfig().config.roles[role as AgentRole];

	pi.registerCommand("agents", {
		description: agentsDescription(),
		getArgumentCompletions: (prefix) => agentsCompletions(prefix, { roles: ROLES, specOf, models: availableModels }),
		handler: async (args, ctx) => {
			const [sub = "status", role, spec] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "status") {
				const { error } = loadConfig();
				const lines = [...ROLES.map((r) => `${r.padEnd(8)} ${describeRole(specOf(r))}`), "", `config   ${CONFIG_PATH}${fs.existsSync(CONFIG_PATH) ? "" : " (not created, using defaults)"}`];
				if (error) lines.push(`error    ${error}`);
				ctx.ui.notify(lines.join("\n"), error ? "error" : "info");
				return;
			}
			if (sub !== "model") {
				ctx.ui.notify(agentsUnknown(sub), "warning");
				return;
			}
			const usage = () => ctx.ui.notify(`Usage: /agents model <${ROLES.join("|")}> <provider/id[:thinking]>`, "warning");
			let picked = role;
			if (!picked && ctx.hasUI) {
				const pick = await ctx.ui.select("Role", ROLES.map((r) => `${r} (${describeRole(specOf(r))})`));
				if (!pick) return;
				picked = pick.split(" ")[0];
			}
			if (!picked || !ROLES.includes(picked) || (!spec && !ctx.hasUI)) {
				usage();
				return;
			}
			const parsed = spec ? parseRoleSpec(spec) : await pickRoleSpec(ctx.ui, picked, specOf(picked), () => ctx.modelRegistry.getAvailable());
			if (!parsed) return;
			if (typeof parsed === "string") {
				ctx.ui.notify(`agents: ${parsed}`, "error");
				return;
			}
			saveRole(picked as AgentRole, parsed);
			ctx.ui.notify(`agents: ${picked} -> ${describeRole(parsed)} (saved to agents.json; used from the next call)`, "info");
		},
	});
}
