/**
 * Workflow extension: one model per job.
 *
 *   you -> plan (Opus, high) -> approve -> execute (Sonnet, medium) -> judge (Opus) -> commit
 *                                             |-- explore (Haiku, parallel): file:line only
 *                                             `-- advisor (Opus): reads the full transcript at decision points
 *
 *   escalation (manual)  /flow escalate -> Fable, /flow back -> the phase's own model
 *   context guard        compact at ~140k tokens on every model, once the run settles
 *
 * plan and execute switch the main session's model. explore, advisor and judge
 * are tools that run their role in a separate `pi` process (see subagent.ts).
 * Every model and thinking level comes from ~/.pi/agent/workflow.json, which
 * pi-config syncs between machines; `/flow model` edits it.
 *
 * view.ts draws it live: the pipeline above the editor with the active stage
 * and its model, plus a row per running subagent with what it is doing now.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, StringEnum } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	serializeConversation,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CONFIG_PATH,
	DEFAULTS,
	describeRole,
	loadConfig,
	parseRoleSpec,
	ROLES,
	type Role,
	saveRole,
	type Thinking,
	type WorkflowConfig,
	weighTokens,
} from "./config.ts";
import * as prompts from "./prompts.ts";
import { planToolProblem } from "./readonly-tools.ts";
import { addUsage, emptyUsage, mapLimit, type RunResult, runSubagent } from "./subagent.ts";
import {
	emptyFlowUsage,
	emptyStageTokens,
	type FlowSummary,
	type FlowUsage,
	FlowView,
	formatTokens,
	type RunView,
	runLine,
	STAGES,
	type Stage,
	shortModel,
	type SubRole,
	summaryLines,
} from "./view.ts";

type Phase = "off" | "plan" | "execute";

interface FlowState {
	phase: Phase;
	/** Main session is on the escalate model instead of the phase's own. */
	escalated: boolean;
	judgeRounds: number;
	/** Hash of the last diff the judge passed. */
	passedDiff?: string;
	/** The last judge round, so the next one reviews only what changed since. */
	lastJudge?: LastJudge;
	/** Active tools before plan mode switched some off. */
	toolsBeforePlan?: string[];
	/** Tokens spent per pipeline stage this session. */
	tokens?: Record<Stage, number>;
	/** "weighted": tokens are cost-weighted (tokenWeights). Counts saved before that were raw and are dropped. */
	tokenUnit?: "weighted";
	/** The current flow's breakdown, until its summary is shown. */
	flow?: FlowUsage;
	flowStarted?: number;
	/** Set when the commit (and push) instruction goes out; the run after it ends the flow. */
	commitPending?: { mode: "commit" | "push"; head: string };
	/** Passed diffs whose flow already ended (or will, at the commit run's end). */
	summarizedPasses?: string[];
}

interface LastJudge {
	/** Hash of the full diff it reviewed. */
	hash: string;
	/** The working tree it reviewed, as a git tree id. */
	tree: string;
	head: string;
	base: string;
	verdict: "PASS" | "FAIL";
	text: string;
}

const STATE_ENTRY = "workflow-state";
/** Display-only entry (never sent to the model) with the token breakdown of a finished flow. */
const SUMMARY_ENTRY = "workflow-summary";
const APPROVED = "Plan approved. Execute it now, step by step, following the workflow rules.";
const OWN_TOOLS = new Set(["explore", "advisor", "judge"]);
const EXPLORE_REASONS = ["timeout", "too_much_output", "location_unknown", "parallel_lookups"] as const;
const execFileAsync = promisify(execFile);

interface Diff {
	text: string;
	hash: string;
	files: number;
	truncated: boolean;
	base: string;
	/** Every changed or new file. */
	names: string[];
	/** Length of the untruncated diff. */
	chars: number;
}

function assistantText(m: AgentMessage | undefined): string {
	if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
	return m.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

interface ToolDetails {
	runs: RunView[];
	verdict?: "PASS" | "FAIL";
}

/** Calls `fn` at most every `ms`, always delivering the last call. */
function throttle(fn: () => void, ms: number): () => void {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return () => {
		const wait = last + ms - Date.now();
		if (wait <= 0) {
			last = Date.now();
			fn();
		} else if (!timer) {
			timer = setTimeout(() => {
				timer = undefined;
				last = Date.now();
				fn();
			}, wait);
		}
	};
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function countFindings(text: string): number {
	return text.split("\n").filter((l) => /\s-\s*(blocker|major|minor)\s*-/i.test(l)).length;
}

export default function workflow(pi: ExtensionAPI) {
	let { config: cfg, error: configError } = loadConfig();
	let state: FlowState = { phase: "off", escalated: false, judgeRounds: 0 };
	/** Diffs already judged or declined this session, so agent_end doesn't ask twice. */
	const seenDiffs = new Set<string>();
	let consecutiveErrors = 0;
	/** The planner's last reply ended with a plan; only then does a typed "go" / "do it" approve. */
	let planReady = false;
	let guardTokens: number | null = null;
	let compacting = false;
	/** The guard threshold was crossed during a run; compact when the run settles. */
	let compactPending = false;
	const view = new FlowView(cfg.roles);

	pi.registerFlag("flow", {
		description: "Workflow phase to start in: plan, execute or off (default from workflow.json)",
		type: "string",
	});

	// ----------------------------------------------------------------------
	// Phases and models
	// ----------------------------------------------------------------------

	function persist(): void {
		state.tokens = { ...view.used };
		state.tokenUnit = "weighted";
		state.flow = structuredClone(view.flow);
		state.flowStarted = view.flowStarted;
		pi.appendEntry(STATE_ENTRY, state);
	}

	/** Ends the current flow: shows its token breakdown and starts counting the next one. False if it had none. */
	function summarizeFlow(outcome: string, ok: boolean): boolean {
		view.settleMain();
		if (!view.hasFlowUsage()) return false;
		pi.appendEntry(SUMMARY_ENTRY, view.endFlow(outcome, ok));
		persist();
		return true;
	}

	function updateStatus(ctx: ExtensionContext): void {
		view.roles = cfg.roles;
		view.weights = cfg.tokenWeights;
		view.phase = state.phase;
		view.escalated = state.escalated;
		if (state.phase === "plan") view.stage = "plan";
		else if (view.stage === "plan") view.stage = "execute";
		if (ctx.hasUI) view.mount(ctx.ui);
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
		planReady = false;
		if (state.phase === "plan" && phase !== "plan") restorePlanTools();
		if (phase === "plan") blockPlanTools();
		state.phase = phase;
		state.escalated = false;
		state.judgeRounds = 0;
		state.commitPending = undefined;
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
				content: APPROVED,
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

	/** Runs a role as a subagent with a live row in the view; `onChange` fires on every update. */
	async function runRole(
		role: SubRole,
		label: string,
		opts: { systemPrompts: string[]; tools: string[]; task: string; cwd: string; signal?: AbortSignal; thinking?: Thinking },
		onChange?: (run: RunView) => void,
	): Promise<{ result: RunResult; run: RunView }> {
		const run = view.start(role, label);
		onChange?.(run);
		const { thinking, ...rest } = opts;
		const result = await runSubagent({
			...rest,
			role: thinking ? { ...cfg.roles[role], thinking } : cfg.roles[role],
			extensions: cfg.subagent.extensions,
			timeoutMs: cfg.subagent.timeoutMs,
			onEvent: (e) => {
				view.event(run, e, opts.cwd);
				onChange?.(run);
			},
		});
		if (!result.ok) view.finish(run, false, result.error ?? "failed");
		return { result, run };
	}

	/** Streams a tool's live rows into its transcript entry. */
	function toolProgress(onUpdate: ((p: { content: { type: "text"; text: string }[]; details: ToolDetails }) => void) | undefined) {
		const runs: RunView[] = [];
		const push = throttle(() => {
			const summary = runs.map((r) => `${r.role} ${r.status}: ${r.activity}`).join("\n");
			onUpdate?.({ content: [{ type: "text", text: summary }], details: { runs: runs.map((r) => ({ ...r })) } });
		}, 150);
		return {
			runs,
			track: (run: RunView) => {
				if (!runs.includes(run)) runs.push(run);
				push();
			},
			snapshot: (): RunView[] => runs.map((r) => ({ ...r })),
		};
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
		const names = [...[...tracked.stdout.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]), ...untracked];
		return { text, hash, files, truncated, base, names, chars: full.length };
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

	/** The working tree (tracked and untracked files, minus ignored ones) as a git tree id, or null. Uses a temporary index. */
	async function snapshotTree(cwd: string): Promise<string | null> {
		const tmp = path.join(os.tmpdir(), `workflow-judge-index-${process.pid}-${Date.now()}`);
		const run = (args: string[]) =>
			execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_INDEX_FILE: tmp }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
		try {
			const index = path.resolve(cwd, (await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-path", "index"])).stdout.trim());
			if (fs.existsSync(index)) fs.copyFileSync(index, tmp); // warm start: only changed files get hashed
			await run(["add", "-A"]);
			return (await run(["write-tree"])).stdout.trim() || null;
		} catch {
			return null;
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	}

	type ReviewPlan =
		| { kind: "full"; tree: string | null; head: string }
		| { kind: "recheck"; tree: string; head: string; prev: LastJudge; delta: string }
		| { kind: "same"; prev: LastJudge };

	/** Whether the judge reviews the whole diff, only the changes since its last round, or nothing (no changes since). */
	async function reviewPlan(cwd: string, diff: Diff, full: boolean): Promise<ReviewPlan> {
		const prev = state.lastJudge;
		if (!full && prev?.hash === diff.hash) return { kind: "same", prev };
		const [tree, head] = await Promise.all([snapshotTree(cwd), git(cwd, "rev-parse", "HEAD").then((r) => r.stdout.trim())]);
		const fullPlan = { kind: "full" as const, tree, head };
		// A commit, rebase or branch switch since, or another base: the last round no longer lines up.
		if (full || !cfg.judge.recheck || !prev || !tree || prev.head !== head || prev.base !== diff.base) return fullPlan;
		const delta = (await git(cwd, "diff", "--no-color", prev.tree, tree)).stdout;
		// Fixes that rewrite most of the change get a full review: little to save, more to miss.
		if (!delta.trim() || delta.length > diff.chars * cfg.judge.recheckMaxShare) return fullPlan;
		return { kind: "recheck", tree, head, prev, delta };
	}

	/**
	 * Reviews `diff`. The first round sees the whole diff; later rounds see only the changes since the
	 * last round plus its findings (cheaper, fresh each time). A large change that passes on a
	 * re-review gets one final full review. `full` forces a full review.
	 */
	async function judge(ctx: ExtensionContext, diff: Diff, focus: string | undefined, signal?: AbortSignal, onChange?: (run: RunView) => void, full = false): Promise<JudgeResult & { run: RunView }> {
		const plan = await reviewPlan(ctx.cwd, diff, full);
		if (plan.kind === "same") {
			const run = view.start("judge", "no changes since the last round");
			view.finish(run, plan.prev.verdict === "PASS", `${plan.prev.verdict} · unchanged, previous result`);
			onChange?.(run);
			seenDiffs.add(diff.hash);
			return { verdict: plan.prev.verdict, text: `No changes since the last judge round; its result stands.\n\n${plan.prev.text}`, hash: diff.hash, usage: emptyUsage(), run };
		}
		let r = await judgeOnce(ctx, diff, focus, plan, signal, onChange);
		const limit = cfg.judge.finalFullReviewOverChars;
		if (r.verdict === "PASS" && plan.kind === "recheck" && limit > 0 && diff.chars > limit) {
			const final = await judgeOnce(ctx, diff, focus, { kind: "full", tree: plan.tree, head: plan.head }, signal, onChange);
			r = { ...final, usage: addUsage(addUsage(emptyUsage(), r.usage), final.usage) };
		}
		if (r.verdict === "PASS") {
			state.passedDiff = diff.hash;
			state.judgeRounds = 0;
			persist();
		}
		return r;
	}

	/** One judge run: the whole diff, or for a re-review the changes since the last round with its findings. */
	async function judgeOnce(
		ctx: ExtensionContext,
		diff: Diff,
		focus: string | undefined,
		plan: Exclude<ReviewPlan, { kind: "same" }>,
		signal?: AbortSignal,
		onChange?: (run: RunView) => void,
	): Promise<JudgeResult & { run: RunView }> {
		const recheck = plan.kind === "recheck";
		const max = cfg.judge.maxDiffChars;
		const systemPrompts = recheck
			? [
					prompts.JUDGE,
					prompts.JUDGE_RECHECK,
					`## Findings of the last round (${plan.prev.verdict})\n\n${plan.prev.text}`,
					`## Every file in the whole change (${diff.names.length})\n\n${diff.names.join("\n")}`,
					`## Changes since the last round\n\n${plan.delta.length > max ? `${plan.delta.slice(0, max)}\n\n[truncated; read the files for the rest]` : plan.delta}`,
				]
			: [prompts.JUDGE, `## Diff under review (${diff.files} file(s)${diff.truncated ? ", truncated" : ""})\n\n${diff.text}`];
		const focusNote = focus ? ` Focus: ${focus}` : "";
		view.stage = "judge";
		const { result, run } = await runRole(
			"judge",
			recheck ? `re-review: changes since the last round${focus ? ` · ${focus}` : ""}` : focus || `${diff.files} changed file(s)`,
			{
				systemPrompts,
				tools: cfg.judge.tools,
				thinking: recheck ? cfg.judge.recheckThinking : undefined,
				task: recheck ? `Re-review the changes in your system prompt against the last round's findings.${focusNote}` : `Review the diff in your system prompt.${focusNote}`,
				cwd: ctx.cwd,
				signal,
			},
			onChange,
		);
		seenDiffs.add(diff.hash);
		if (!result.ok) {
			view.stage = state.phase === "plan" ? "plan" : "execute";
			return { verdict: "ERROR", text: `judge failed: ${result.error}`, hash: diff.hash, usage: result.usage, run };
		}
		const verdict = /VERDICT:\s*PASS/i.test(result.text) && !/VERDICT:\s*FAIL/i.test(result.text) ? "PASS" : "FAIL";
		const findings = countFindings(result.text);
		view.finish(run, verdict === "PASS", `${verdict} · ${findings} finding${findings === 1 ? "" : "s"}${recheck ? " · re-review" : ""}`);
		onChange?.(run);
		// Back to the phase's stage either way; finishPassed moves to commit once the commit is actually handed over.
		view.stage = state.phase === "plan" ? "plan" : "execute";
		state.lastJudge = plan.tree ? { hash: diff.hash, tree: plan.tree, head: plan.head, base: diff.base, verdict, text: result.text } : undefined;
		persist();
		return { verdict, text: result.text, hash: diff.hash, usage: result.usage, run };
	}

	// ----------------------------------------------------------------------
	// Tools
	// ----------------------------------------------------------------------

	const title = (theme: Theme, name: string, role: Role) =>
		theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", shortModel(cfg.roles[role].model));

	/** Live rows while running; rows plus the output (or a preview of it) when done. */
	function renderRuns(
		result: { content: { type: string; text?: string }[]; details?: unknown },
		opts: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		previewLines: number,
	): Component {
		const details = result.details as ToolDetails | undefined;
		const rows = (details?.runs ?? []).map((r) => runLine(r, theme, { showRole: false }));
		if (opts.isPartial) return new Text(rows.join("\n") || theme.fg("dim", "starting…"), 0, 0);
		const body = textOf(result).trim();
		if (!details) return new Text(theme.fg("toolOutput", body), 0, 0);
		const lines = body.split("\n");
		const shown = opts.expanded || lines.length <= previewLines ? lines : [...lines.slice(0, previewLines), theme.fg("dim", `… ${lines.length - previewLines} more lines (expand to see all)`)];
		const colored = shown.map((l) =>
			/VERDICT:\s*PASS/i.test(l) ? theme.fg("success", theme.bold(l)) : /VERDICT:\s*FAIL/i.test(l) ? theme.fg("error", theme.bold(l)) : /\s-\s*blocker\s*-/i.test(l) ? theme.fg("error", l) : /\s-\s*major\s*-/i.test(l) ? theme.fg("warning", l) : theme.fg("toolOutput", l),
		);
		return new Text([...rows, ...(previewLines > 0 || opts.expanded ? ["", ...colored] : [])].join("\n"), 0, 0);
	}

	pi.registerTool({
		name: "explore",
		label: "Explore",
		description:
			"Fallback for code lookups when the normal search tools are not enough. Fans out read/grep lookups to cheap parallel reader agents. Each query is a self-contained question about the codebase (e.g. 'where is the save system serialized?'). Returns only file:line references with a short note, so you can read just the lines you need.",
		promptSnippet: "explore: fallback parallel codebase lookups (file:line references) when normal search is not enough",
		parameters: Type.Object({
			reason: StringEnum(EXPLORE_REASONS, {
				description:
					"Why the normal tools are not enough: timeout (a search timed out), too_much_output (a search returned too much to narrow), location_unknown (no idea where to look), parallel_lookups (several independent lookups, e.g. across repos)",
			}),
			queries: Type.Array(Type.String({ description: "One self-contained lookup question" }), {
				description: "Lookups to run in parallel",
				minItems: 1,
			}),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const queries = params.queries.slice(0, cfg.explore.maxQueries);
			const progress = toolProgress(onUpdate);
			const results = await mapLimit(queries, cfg.explore.concurrency, async (q) => {
				const { result, run } = await runRole("explore", `[${params.reason}] ${q}`, { systemPrompts: [prompts.EXPLORE], tools: cfg.explore.tools, task: q, cwd: ctx.cwd, signal }, progress.track);
				if (result.ok) {
					const refs = result.text.trim() === "none" ? 0 : result.text.split("\n").filter((l) => /:\d/.test(l)).length;
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
			consecutiveErrors = 0;
			const progress = toolProgress(onUpdate);
			const { result, run } = await runRole(
				"advisor",
				`[${params.situation}] ${params.question}`,
				{
					systemPrompts: [prompts.ADVISOR, `## Transcript of the execution agent\n\n${transcript(ctx)}`],
					tools: cfg.advisor.tools,
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
		name: "judge",
		label: "Judge",
		description:
			"Adversarial review of the current uncommitted diff (plus untracked files) by a stronger model that assumes the change is wrong. Returns one line per finding and VERDICT: PASS or FAIL. Call it when the diff is ready; fix blocker and major findings and call it again. Rounds after the first review only the changes since the last round, with its findings. Do not commit before PASS.",
		promptSnippet: "judge: adversarial review of the current diff; must PASS before commit",
		parameters: Type.Object({
			focus: Type.Optional(Type.String({ description: "What the change is meant to do, or areas to scrutinize" })),
			base: Type.Optional(Type.String({ description: "Git ref to diff against. Default HEAD" })),
			full: Type.Optional(
				Type.Boolean({ description: "Review the whole diff, not only the changes since the last round. Use once before committing a risky change." }),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const diff = await collectDiff(ctx.cwd, params.base || "HEAD");
			if (!diff) throw new Error("not a git work tree; the judge reviews git diffs");
			if (!diff.text) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const progress = toolProgress(onUpdate);
			const r = await judge(ctx, diff, params.focus, signal, progress.track, params.full === true);
			if (r.verdict === "ERROR") throw new Error(r.text);
			if (r.verdict === "FAIL") state.judgeRounds++;
			return { content: [{ type: "text", text: r.text }], details: { runs: progress.snapshot(), verdict: r.verdict }, usage: r.usage };
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "judge", "judge")} ${theme.fg("dim", String(args.focus ?? "current diff"))}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 40),
	});

	// ----------------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------------

	pi.on("before_agent_start", async (event) => {
		if (state.phase === "plan") return { systemPrompt: `${event.systemPrompt}\n\n${prompts.PLAN_PHASE}` };
		if (state.phase === "execute") return { systemPrompt: `${event.systemPrompt}\n\n${prompts.EXECUTE_PHASE}` };
	});

	// Plan phase is read-only: the planner settles the approach, the execute model changes things.
	// Nested calls (codemode's tools.bash) pass through here too.
	pi.on("tool_call", async (event) => {
		if (state.phase !== "plan") return;
		if (cfg.planBlockedTools.includes(event.toolName)) return { block: true, reason: planBlocked(`${event.toolName} is off while planning`) };
		if (!cfg.planReadOnlyBash) return;
		if (event.toolName === "powershell") return { block: true, reason: planBlocked("PowerShell commands are not checked, so they are off while planning") };
		const problem = planToolProblem(event.toolName, (event.input ?? {}) as Record<string, unknown>, planAllow());
		if (problem) return { block: true, reason: planBlocked(problem) };
	});

	function planAllow(): RegExp[] {
		return cfg.planBashAllow.flatMap((p) => {
			try {
				return [new RegExp(p)];
			} catch {
				return [];
			}
		});
	}

	function planBlocked(problem: string): string {
		return [
			`Plan phase is read-only: ${problem}.`,
			"Do not work around this (no other tool, no script). Put the step in the plan instead: it runs after the user approves, on the execute model.",
			"Reading is fine: ls, cat, grep, find, git status/log/diff/show, gh ... view/list/checks, gh api GET.",
		].join(" ");
	}

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
	// turn_end only notes the crossing: ctx.compact() aborts the running turn first,
	// so calling it mid-run killed the agent's next step ("This operation was
	// aborted"). The compaction runs in agent_settled, when nothing is left to abort;
	// pi's own auto-compaction still covers a run that nears the model's window.
	pi.on("turn_end", async (_event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		if (tokens === null || cfg.contextGuardTokens <= 0) return;
		const crossed = guardTokens !== null && guardTokens <= cfg.contextGuardTokens && tokens > cfg.contextGuardTokens;
		guardTokens = tokens;
		if (crossed) compactPending = true;
	});

	// Live token count per stage: usage is cumulative while a message streams.
	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) view.mainUsage(weighTokens(event.message.usage, cfg.tokenWeights), false);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) view.mainUsage(weighTokens(event.message.usage, cfg.tokenWeights), true, event.message.model);
	});

	pi.registerEntryRenderer<FlowSummary>(SUMMARY_ENTRY, (entry, _opts, theme) => (entry.data ? new Text(summaryLines(entry.data, theme).join("\n"), 1, 0) : undefined));

	pi.on("agent_settled", async (event, ctx) => {
		view.settleMain();
		const tracked = state.phase !== "off" || state.tokens !== undefined;
		if (tracked && STAGES.some((s) => view.used[s] !== (state.tokens?.[s] ?? 0))) persist();
		if (!compactPending || compacting || event.aborted || !ctx.isIdle()) return;
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		compactPending = false;
		if (tokens === null || tokens <= cfg.contextGuardTokens) return;
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

	// Rows from the previous run stay visible a little while, then make room.
	pi.on("agent_start", async () => {
		view.clearFinished(15_000);
	});

	function approveRe(): RegExp {
		try {
			return new RegExp(cfg.approvePattern, "i");
		} catch {
			return new RegExp(DEFAULTS.approvePattern, "i");
		}
	}

	// Saying "go" in plan phase approves the plan: switch to execute and send the message on as the start signal.
	pi.on("input", async (event, ctx) => {
		if (state.phase !== "plan" || event.source === "extension" || event.streamingBehavior) return { action: "continue" };
		// Without a plan on screen, "yes, do that" answers a question; it doesn't approve anything.
		if (!planReady || !approveRe().test(event.text.trim())) return { action: "continue" };
		await setPhase(ctx, "execute");
		ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(cfg.roles.execute)}`, "info");
		return { action: "transform", text: `${event.text.trim()}\n\n${APPROVED}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const last = [...event.messages].reverse().find((m) => m.role === "assistant");

		if (state.phase === "plan") {
			// A plan is any reply with a numbered list of at least two steps.
			planReady = /(^|\n)\s*(\*\*)?1[.)][\s\S]*\n\s*(\*\*)?2[.)]/.test(assistantText(last));
			if (!planReady) return;
			if (!cfg.planPrompt) {
				ctx.ui.notify(`workflow: plan ready. Say "go" to execute on ${describeRole(cfg.roles.execute)}, or keep discussing.`, "info");
				return;
			}
			const choice = await ctx.ui.select("Plan ready", [
				`Approve: execute on ${describeRole(cfg.roles.execute)}`,
				"Keep planning",
			]);
			if (choice?.startsWith("Approve")) await approve(ctx);
			return;
		}

		if (state.phase !== "execute") return;
		if (state.commitPending) await summarizeCommit(ctx);
		await reviewDiff(ctx, false);
	});

	async function summarizeCommit(ctx: ExtensionContext): Promise<void> {
		const { mode, head } = state.commitPending!;
		state.commitPending = undefined;
		const now = (await git(ctx.cwd, "rev-parse", "HEAD")).stdout.trim();
		let shown: boolean;
		if (!now || now === head) shown = summarizeFlow("commit step ended without a commit", false);
		else if (mode === "commit") shown = summarizeFlow("committed", true);
		else {
			const ahead = await git(ctx.cwd, "rev-list", "--count", "@{u}..HEAD");
			const pushed = ahead.code === 0 && ahead.stdout.trim() === "0";
			shown = summarizeFlow(pushed ? "committed and pushed" : "committed, not pushed", pushed);
		}
		if (!shown) persist(); // commitPending was cleared
	}

	/** diff ready -> judge -> fix loop, or commit (and push) once it passes. */
	async function reviewDiff(ctx: ExtensionContext, manual: boolean): Promise<void> {
		const diff = await collectDiff(ctx.cwd);
		// Committed, or changed since the judge passed: back to executing.
		if (view.stage === "commit" && diff?.hash !== state.passedDiff) {
			view.stage = "execute";
			view.changed();
		}
		if (!diff?.text) {
			if (manual) ctx.ui.notify("workflow: no changes to review", "info");
			return;
		}
		// Already passed, e.g. the executor called judge itself: straight to commit.
		if (!manual && diff.hash === state.passedDiff) {
			if (!(await finishPassed(ctx, diff.hash))) summarizePass(diff.hash);
			return;
		}
		if (!manual && (cfg.autoJudge === "off" || seenDiffs.has(diff.hash))) return;
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
		// The verdict travels with the next instruction, so they reach the transcript in order.
		const report = `**Judge: ${r.verdict}**\n\n${r.text}`;
		if (r.verdict === "FAIL") {
			state.judgeRounds++;
			persist();
			if (state.judgeRounds >= cfg.maxJudgeRounds) {
				pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
				ctx.ui.notify(`workflow: judge failed ${state.judgeRounds} rounds in a row — your call (/flow escalate?)`, "warning");
				summarizeFlow(`stopped: judge failed ${state.judgeRounds} rounds`, false);
				return;
			}
			pi.sendMessage(
				{ customType: "workflow-fix", content: `${report}\n\nFix the blocker and major findings above, then call judge again.`, display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return;
		}

		if (!(await finishPassed(ctx, diff.hash, report))) {
			pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			summarizePass(diff.hash);
		}
	}

	/** Remembers a passed diff's flow as ended, so later runs on the same diff don't end another one. */
	function markPassSummarized(hash: string): void {
		state.summarizedPasses = [...(state.summarizedPasses ?? []).filter((h) => h !== hash), hash].slice(-20);
	}

	/** The flow ends at a pass that won't be committed (autoCommit off, or "Not yet"). */
	function summarizePass(hash: string): void {
		if (state.summarizedPasses?.includes(hash)) return;
		markPassSummarized(hash);
		view.stage = "execute";
		if (!summarizeFlow("judge passed, not committed", true)) persist();
	}

	/** Diffs already handed to the commit step, so a pass is committed once. */
	const committedDiffs = new Set<string>();

	/** Sends the commit (and push) instruction, prefixed with `report`. False if nothing was sent. */
	async function finishPassed(ctx: ExtensionContext, hash: string, report?: string): Promise<boolean> {
		if (cfg.autoCommit === "off" || committedDiffs.has(hash)) return false;
		committedDiffs.add(hash);

		let mode: "commit" | "push" = cfg.autoCommit === "commit" ? "commit" : "push";
		if (cfg.autoCommit === "ask") {
			const choice = await ctx.ui.select("Judge passed", ["Commit and push", "Commit", "Not yet"]);
			if (!choice || choice === "Not yet") return false;
			mode = choice === "Commit" ? "commit" : "push";
		}

		const branch = (await git(ctx.cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
		if (mode === "push" && (!branch || branch === "HEAD" || cfg.protectedBranches.includes(branch))) {
			mode = "commit";
			ctx.ui.notify(`workflow: on ${branch || "a detached HEAD"}, committing without pushing`, "warning");
		}

		view.stage = "commit";
		view.changed();
		state.commitPending = { mode, head: (await git(ctx.cwd, "rev-parse", "HEAD")).stdout.trim() };
		markPassSummarized(hash); // the commit run's end summarizes this flow
		persist();
		const commit =
			"The judge passed. Commit exactly the reviewed changes now: stage the changed and new files from the diff without editing anything first, and write a clear message that follows the repo's conventions.";
		const push = ` Then push branch \`${branch}\` (\`git push\`, or \`git push -u origin ${branch}\` if it has no upstream).`;
		const rules = " Never force-push or use --no-verify. If a hook, the commit or the push fails, stop and report it instead of working around it.";
		const instruction = commit + (mode === "push" ? push : "") + rules;
		pi.sendMessage(
			{ customType: "workflow-commit", content: report ? `${report}\n\n${instruction}` : instruction, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return true;
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
			if (state.tokenUnit !== "weighted") {
				// Saved before counts were cost-weighted; mixing raw and weighted would mislead.
				state.tokens = undefined;
				state.flow = undefined;
				state.flowStarted = undefined;
			}
			view.used = { ...emptyStageTokens(), ...state.tokens };
			view.flow = { ...emptyFlowUsage(), ...structuredClone(state.flow) };
			view.flowStarted = state.flowStarted;
			if (state.commitPending) view.stage = "commit";
			if (state.phase === "plan") blockPlanTools();
			updateStatus(ctx);
			return;
		}
		if (event.reason === "reload") return;

		const flag = pi.getFlag("flow");
		const start = (typeof flag === "string" && ["plan", "execute", "off"].includes(flag) ? flag : cfg.startPhase) as Phase;
		state = { phase: "off", escalated: false, judgeRounds: 0 };
		view.used = emptyStageTokens();
		view.flow = emptyFlowUsage();
		view.flowStarted = undefined;
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
		{ value: "tokens", label: "tokens - token breakdown of the current flow so far" },
		{ value: "model", label: "model <role> <provider/id[:thinking]> - set a role's model" },
		{ value: "reload", label: "reload - re-read workflow.json" },
	];

	function statusText(): string {
		const lines = [
			`phase      ${state.phase}${state.escalated ? " (escalated)" : ""}`,
			`judge     ${state.judgeRounds} failed round(s); auto=${cfg.autoJudge}; then ${cfg.autoCommit}`,
			`guard     compact at ${cfg.contextGuardTokens || "off"} tokens`,
			`tokens    ${STAGES.map((s) => `${s} ${formatTokens(view.sessionTokens(s))}`).join(" · ")} · session total ${formatTokens(STAGES.reduce((n, s) => n + view.sessionTokens(s), 0))}`,
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
				case "tokens":
					if (!view.hasFlowUsage()) {
						ctx.ui.notify("workflow: no tokens spent in this flow yet", "info");
						return;
					}
					pi.appendEntry(SUMMARY_ENTRY, { ...view.peekFlow(`stage ${view.stage}`, true), title: "flow so far" });
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
