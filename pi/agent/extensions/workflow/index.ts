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
} from "./config.ts";
import { afterPass, arbiterFirst, fixableFindings, hasPlanFlaw, isPlanReady, judgeCapReached, minorFixOpen, parseArbiter, phaseAfterFlow, shouldResume, skipJudge } from "./agent-end.ts";
import { countTokens, type Tok } from "./tokens.ts";
import * as prompts from "./prompts.ts";
import { branchName, type Delivery, DELIVERIES, DELIVERY_LABELS, deliveryChoices, deliveryInstruction, deliveryMenuLabel, deliveryOutcome, freshPr, isDelivery, planTitle, type PrState } from "./delivery.ts";
import { pushProblem } from "./push-guard.ts";
import { planToolProblem, planToolRefused } from "./readonly-tools.ts";
import { addUsage, emptyUsage, mapLimit, type RunResult, runSubagent } from "./subagent.ts";
import {
	type Deviation,
	deviationBlock,
	forwardedServers,
	judgeKnowledge,
	type KnowledgeStatus,
	knowledgeFooter,
	mergeKnowledgePass,
	parseDeviations,
	roleTools,
} from "./knowledge.ts";
import {
	emptyFlowUsage,
	emptyStageTokens,
	type FlowSummary,
	type FlowUsage,
	FlowView,
	fmtTok,
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
	/** Rounds spent fixing minor findings of passed reviews since the last commit. */
	minorRounds?: number;
	/** Diff the last minor-fix message was sent for. */
	minorSentFor?: string;
	/** Hash of the last diff the judge passed. */
	passedDiff?: string;
	/** The last judge round, so the next one reviews only what changed since. */
	lastJudge?: LastJudge;
	/** Active tools before plan mode switched some off. */
	toolsBeforePlan?: string[];
	/** Tokens spent per pipeline stage this session. */
	tokens?: Record<Stage, Tok>;
	/** "both": each count holds the raw total and the cost-weighted one. Counts saved before that are dropped. */
	tokenUnit?: "both";
	/** The current flow's breakdown, until its summary is shown. */
	flow?: FlowUsage;
	flowStarted?: number;
	/** Set when the commit step's instruction goes out; the run after it ends the flow. `branch`: the branch the commits go on. `prBefore`: a closed or merged PR gh already showed for the branch before the step ran; it is not this flow's. */
	commitPending?: { mode: Exclude<Delivery, "off">; head: string; branch?: string; prBefore?: number };
	/** What happens after the judge passes in this flow, chosen at approval; unset means `delivery.default`. */
	delivery?: Delivery;
	/** Plan flaws go straight to the arbiter in this flow, chosen at approval; unset means `cfg.planFlaw`. */
	planFlaw?: "auto";
	/** Passed diffs whose flow already ended (or will, at the commit run's end). */
	summarizedPasses?: string[];
	/** The plan the user approved (the final plan, plus arbiter amendments); the judge and the arbiter read it. */
	approvedPlan?: string;
	/** The planner is writing the final execution plan; its reply becomes approvedPlan. */
	finalizing?: boolean;
	/** Amendments the arbiter added in this flow. */
	planRevisions?: number;
	/** A judge report that questions the plan, waiting for the end of the executor's turn. */
	pendingPlanFlaw?: string;
	/** The knowledge check of the last judge round (only when knowledge is active). */
	lastKnowledge?: LastKnowledge;
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

interface LastKnowledge {
	/** Hash of the diff it checked. */
	hash: string;
	status: "checked" | "unavailable";
	reason?: string;
	deviations: Deviation[];
}

const STATE_ENTRY = "workflow-state";
/** Display-only entry (never sent to the model) with the token breakdown of a finished flow. */
const SUMMARY_ENTRY = "workflow-summary";
const APPROVED = "Plan approved. Execute it now, step by step, following the workflow rules.";
const APPROVED_FINAL = "The final plan above is approved. Execute it exactly, step by step, following the workflow rules.";
const FIX_MESSAGE =
	"Fix every blocker and major finding by following its Fix directions, and the minor ones too (except [knowledge ...] deviations: give your reason in `disputes` to keep the code). If a finding is wrong, put it in the `disputes` parameter of your next judge call instead of changing code. Then call judge again.";
/** The judge reads at most this much of the plan; the end (the arbiter's amendments) is kept. */
const MAX_PLAN_CHARS = 60_000;
const OWN_TOOLS = new Set(["explore", "advisor", "judge"]);
const EXPLORE_REASONS = ["question", "broad_search", "timeout", "too_much_output", "location_unknown", "parallel_lookups"] as const;
const execFileAsync = promisify(execFile);
/** Subagent-only extension that registers forwarded MCP servers (see mcp-forward.ts). */
const FORWARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "workflow", "mcp-forward.ts");

interface Diff {
	text: string;
	hash: string;
	files: number;
	truncated: boolean;
	base: string;
	/** Every changed or new file. */
	names: string[];
	/** The files the knowledge check covers: current paths (renames under their new name), no deleted files. */
	checkNames: string[];
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
	/** The planner's last reply has a "Plan:" section and no open question; only then does a typed "go" / "do it" approve. */
	let planReady = false;
	/** The planner's last finished reply, kept as the approved plan when finalizePlan is off. */
	let lastPlanText = "";
	let guardTokens: number | null = null;
	let compacting = false;
	/** The guard threshold was crossed during a run; compact when the run settles. */
	let compactPending = false;
	/** An overflow compaction is retrying the turn; the bridge may answer that retry with an empty reply. */
	let overflowRetry = false;
	/** Automatic resumes since the user's last prompt. */
	let resumes = 0;
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
		state.tokenUnit = "both";
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

	/** A flow has ended: back to the plan phase when returnToPlan says so. */
	async function endFlow(ctx: ExtensionContext): Promise<void> {
		if (phaseAfterFlow(cfg.returnToPlan, state.phase) !== "plan") return;
		await setPhase(ctx, "plan");
		ctx.ui.notify(`workflow: flow done, back to planning on ${describeRole(cfg.roles.plan)}`, "info");
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
		const allowed = planAllowedTools();
		pi.setActiveTools(state.toolsBeforePlan.filter((t) => !planToolRefused(t, allowed, cfg.planBlockedTools)));
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
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.commitPending = undefined;
		state.finalizing = undefined;
		state.planRevisions = undefined;
		state.pendingPlanFlaw = undefined;
		if (phase === "plan") {
			state.approvedPlan = undefined;
			state.delivery = undefined;
			state.planFlaw = undefined;
		}
		consecutiveErrors = 0;
		if (phase !== "off") await applyRole(ctx, phase);
		persist();
		updateStatus(ctx);
	}

	async function approve(ctx: ExtensionContext, delivery?: Delivery, arbiterOnFlaw = false): Promise<void> {
		state.delivery = delivery ?? (await chooseDelivery(ctx));
		state.planFlaw = arbiterOnFlaw ? "auto" : undefined;
		if (cfg.finalizePlan) {
			// One more planner reply, the final execution plan, before the execute model starts.
			planReady = false;
			state.finalizing = true;
			persist();
			pi.sendMessage({ customType: "workflow-finalize", content: prompts.finalize(cfg.delivery.splitCommits), display: true }, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		await setPhase(ctx, "execute");
		state.approvedPlan = lastPlanText || undefined;
		persist();
		pi.sendMessage({ customType: "workflow-execute", content: APPROVED, display: true }, { triggerTurn: true, deliverAs: "followUp" });
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

	function defaultDelivery(): Delivery {
		return isDelivery(cfg.delivery.default) ? cfg.delivery.default : "commit";
	}

	/** The menu's first and Escape choice: the one set with /flow delivery, else the configured default. */
	function menuDefault(): Delivery {
		return state.delivery ?? defaultDelivery();
	}

	/** Asks what happens after the judge passes (default first); Escape, no UI or `ask: false` gives the default. */
	async function chooseDelivery(ctx: ExtensionContext): Promise<Delivery> {
		const def = menuDefault();
		if (!cfg.delivery.ask || !ctx.hasUI) return def;
		const options = deliveryChoices(def);
		const labels = options.map((d) => deliveryMenuLabel(d, def));
		const choice = await ctx.ui.select("After the judge passes", labels);
		const i = choice ? labels.indexOf(choice) : -1;
		return i >= 0 ? options[i] : def;
	}

	// ----------------------------------------------------------------------
	// Subagent helpers
	// ----------------------------------------------------------------------

	/** The knowledge tools and server config a subagent role gets, or undefined when knowledge is off for it. */
	function knowledgeFor(role: Role): { tools: string[]; servers: Record<string, Record<string, unknown>> } | undefined {
		const k = cfg.knowledge;
		if (!k.server || !k.roles.includes(role) || !fs.existsSync(FORWARD_EXTENSION)) return undefined;
		const servers = forwardedServers(pi.getMcpServers(), k);
		return servers[k.server] ? { tools: roleTools(role, k), servers } : undefined;
	}

	/** The server whose check the judge must run, or undefined. */
	function judgeKnowledgeServer(): string | undefined {
		return cfg.knowledge.judgeCheck && knowledgeFor("judge") ? cfg.knowledge.server : undefined;
	}

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
		const k = knowledgeFor(role);
		const result = await runSubagent({
			...rest,
			tools: k ? [...rest.tools, ...k.tools] : rest.tools,
			systemPrompts: k && role !== "judge" ? [...rest.systemPrompts, prompts.knowledgeTools(k.tools)] : rest.systemPrompts,
			mcp: k ? { servers: k.servers, extension: FORWARD_EXTENSION } : undefined,
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
		let current = await git(cwd, "diff", "--name-only", "-z", "--diff-filter=d", base);
		if (current.code !== 0) current = await git(cwd, "diff", "--name-only", "-z", "--diff-filter=d");
		const checkNames = [...current.stdout.split("\0").filter(Boolean), ...untracked];
		return { text, hash, files, truncated, base, names, checkNames, chars: full.length };
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
	async function reviewPlan(cwd: string, diff: Diff, full: boolean, skipSame = false): Promise<ReviewPlan> {
		const prev = state.lastJudge;
		if (!full && !skipSame && prev?.hash === diff.hash) return { kind: "same", prev };
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
	async function judge(ctx: ExtensionContext, diff: Diff, focus: string | undefined, signal?: AbortSignal, onChange?: (run: RunView) => void, full = false, disputes?: string): Promise<JudgeResult & { run: RunView }> {
		// Disputes need a fresh look at the code, so they never get the "no changes" shortcut (a recheck still applies).
		const plan = await reviewPlan(ctx.cwd, diff, full, Boolean(disputes));
		if (plan.kind === "same") {
			const run = view.start("judge", "no changes since the last round");
			view.finish(run, plan.prev.verdict === "PASS", `${plan.prev.verdict} · unchanged, previous result`);
			onChange?.(run);
			seenDiffs.add(diff.hash);
			return { verdict: plan.prev.verdict, text: `No changes since the last judge round; its result stands.\n\n${plan.prev.text}`, hash: diff.hash, usage: emptyUsage(), run };
		}
		let r = await judgeOnce(ctx, diff, focus, plan, signal, onChange, disputes);
		const limit = cfg.judge.finalFullReviewOverChars;
		if (r.verdict === "PASS" && plan.kind === "recheck" && limit > 0 && diff.chars > limit) {
			const final = await judgeOnce(ctx, diff, focus, { kind: "full", tree: plan.tree, head: plan.head }, signal, onChange, disputes);
			r = { ...final, usage: addUsage(addUsage(emptyUsage(), r.usage), final.usage) };
		}
		// A pass that questions the plan is not a pass yet: resolvePlanFlaw decides.
		if (r.verdict === "PASS" && !hasPlanFlaw(r.text)) markPassed(diff.hash);
		return r;
	}

	function markPassed(hash: string): void {
		state.passedDiff = hash;
		state.judgeRounds = 0;
		persist();
	}

	/** The approved plan for the judge and the arbiter; a very long one loses its middle, never its amendments. */
	function planForJudge(): string {
		const plan = state.approvedPlan;
		if (!plan) return "None recorded: judge the diff on its own.";
		if (plan.length <= MAX_PLAN_CHARS) return plan;
		return `${plan.slice(0, 45_000)}\n\n[... middle of the plan omitted ...]\n\n${plan.slice(-15_000)}`;
	}

	/** D4: a knowledge-only judge run, when the judge skipped its knowledge step. */
	async function knowledgePass(
		ctx: ExtensionContext,
		diff: Diff,
		findings: string,
		server: string,
		signal?: AbortSignal,
		onChange?: (run: RunView) => void,
	): Promise<{ text?: string; status: { status: "checked" } | { status: "unavailable"; reason: string }; usage: ReturnType<typeof emptyUsage> }> {
		const { result, run } = await runRole(
			"judge",
			"knowledge check",
			{
				systemPrompts: [
					prompts.JUDGE_KNOWLEDGE_ONLY,
					prompts.judgeKnowledge(server, false, diff.checkNames),
					`## Approved plan\n\n${planForJudge()}`,
					`## The judge's findings\n\n${findings}`,
					`## Diff (${diff.files} file(s)${diff.truncated ? ", truncated" : ""})\n\n${diff.text}`,
				],
				tools: cfg.judge.tools,
				task: "Run the knowledge check described in your system prompt.",
				cwd: ctx.cwd,
				signal,
			},
			onChange,
		);
		if (!result.ok) return { status: { status: "unavailable", reason: `knowledge check failed: ${result.error}` }, usage: result.usage };
		const s = judgeKnowledge(result.toolCalls, result.text, diff.checkNames, server);
		view.finish(run, s.status === "checked", s.status === "checked" ? "knowledge checked" : "knowledge not checked");
		onChange?.(run);
		const status = s.status === "checked" ? s : { status: "unavailable" as const, reason: s.status === "skipped" ? `the knowledge step was skipped twice (${s.reason})` : s.reason };
		return { text: result.text, status, usage: result.usage };
	}

	/** One judge run: the whole diff, or for a re-review the changes since the last round with its findings. */
	async function judgeOnce(
		ctx: ExtensionContext,
		diff: Diff,
		focus: string | undefined,
		plan: Exclude<ReviewPlan, { kind: "same" }>,
		signal?: AbortSignal,
		onChange?: (run: RunView) => void,
		disputes?: string,
	): Promise<JudgeResult & { run: RunView }> {
		const recheck = plan.kind === "recheck";
		const server = judgeKnowledgeServer();
		const max = cfg.judge.maxDiffChars;
		const systemPrompts = recheck
			? [
					prompts.JUDGE,
					prompts.JUDGE_RECHECK,
					`## Approved plan\n\n${planForJudge()}`,
					`## Findings of the last round (${plan.prev.verdict})\n\n${plan.prev.text}`,
					`## Every file in the whole change (${diff.names.length})\n\n${diff.names.join("\n")}`,
					`## Changes since the last round\n\n${plan.delta.length > max ? `${plan.delta.slice(0, max)}\n\n[truncated; read the files for the rest]` : plan.delta}`,
				]
			: [prompts.JUDGE, `## Approved plan\n\n${planForJudge()}`, `## Diff under review (${diff.files} file(s)${diff.truncated ? ", truncated" : ""})\n\n${diff.text}`];
		if (server) systemPrompts.splice(recheck ? 2 : 1, 0, prompts.judgeKnowledge(server, recheck, diff.checkNames));
		if (disputes) systemPrompts.push(`## Executor's disputes (claims; verify each against the code)\n\n${disputes}`);
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
		let text = result.text;
		let usage = result.usage;
		let knowledge: LastKnowledge | undefined;
		if (server) {
			let status: KnowledgeStatus = judgeKnowledge(result.toolCalls, text, diff.checkNames, server);
			if (status.status === "skipped") {
				const pass = await knowledgePass(ctx, diff, text, server, signal, onChange);
				usage = addUsage(addUsage(emptyUsage(), usage), pass.usage);
				if (pass.text !== undefined) text = mergeKnowledgePass(text, pass.text);
				status = pass.status;
			}
			const final = status.status === "checked" ? { status: "checked" as const } : { status: "unavailable" as const, reason: status.reason };
			const deviations = parseDeviations(text);
			text += `\n\n${knowledgeFooter(final, deviations.length)}`;
			knowledge = { hash: diff.hash, ...final, deviations };
		}
		const verdict = /VERDICT:\s*PASS/i.test(text) && !/VERDICT:\s*FAIL/i.test(text) ? "PASS" : "FAIL";
		const findings = countFindings(text);
		const knowledgeNote = knowledge ? ` · knowledge ${knowledge.status === "checked" ? "checked" : "not checked"}` : "";
		view.finish(run, verdict === "PASS", `${verdict} · ${findings} finding${findings === 1 ? "" : "s"}${recheck ? " · re-review" : ""}${knowledgeNote}`);
		onChange?.(run);
		// Back to the phase's stage either way; finishPassed moves to commit once the commit is actually handed over.
		view.stage = state.phase === "plan" ? "plan" : "execute";
		state.lastJudge = plan.tree ? { hash: diff.hash, tree: plan.tree, head: plan.head, base: diff.base, verdict, text } : undefined;
		state.lastKnowledge = knowledge;
		persist();
		return { verdict, text, hash: diff.hash, usage, run };
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
			const queries = params.queries.slice(0, cfg.explore.maxQueries);
			const progress = toolProgress(onUpdate);
			const results = await mapLimit(queries, cfg.explore.concurrency, async (q) => {
				const { result, run } = await runRole("explore", `[${params.reason}] ${q}`, { systemPrompts: [prompts.EXPLORE], tools: cfg.explore.tools, task: q, cwd: ctx.cwd, signal }, progress.track);
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
			"Adversarial review of the current uncommitted diff (plus untracked files) by a stronger model that assumes the change is wrong. Returns one line per finding and VERDICT: PASS or FAIL. Call it when the diff is ready; fix blocker and major findings and call it again. On a pass, end your turn: the workflow decides whether minor findings get a fix round. Rounds after the first review only the changes since the last round, with its findings. Do not commit before PASS.",
		promptSnippet: "judge: adversarial review of the current diff; must PASS before commit",
		parameters: Type.Object({
			focus: Type.Optional(Type.String({ description: "What the change is meant to do, or areas to scrutinize" })),
			base: Type.Optional(Type.String({ description: "Git ref to diff against. Default HEAD" })),
			full: Type.Optional(
				Type.Boolean({ description: "Review the whole diff, not only the changes since the last round. Use once before committing a risky change." }),
			),
			disputes: Type.Optional(
				Type.String({ description: "Findings from the last round you believe are wrong, and the evidence (file:line). The judge verifies them against the code; it does not take them on trust." }),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const diff = await collectDiff(ctx.cwd, params.base || "HEAD");
			if (!diff) throw new Error("not a git work tree; the judge reviews git diffs");
			if (!diff.text) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const progress = toolProgress(onUpdate);
			const r = await judge(ctx, diff, params.focus, signal, progress.track, params.full === true, params.disputes);
			if (r.verdict === "ERROR") throw new Error(r.text);
			if (r.verdict === "FAIL") state.judgeRounds++;
			let text = r.text;
			// Every call replaces the pending report, so a stale one never outlives a clean review.
			state.pendingPlanFlaw = hasPlanFlaw(r.text) ? r.text : undefined;
			if (state.pendingPlanFlaw) {
				text += "\n\nThis review questions the plan. Do not change the plan's design yourself: end your turn now; the workflow resolves it.";
			}
			persist();
			return { content: [{ type: "text", text }], details: { runs: progress.snapshot(), verdict: r.verdict }, usage: r.usage };
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
		if (state.phase === "plan") return { systemPrompt: `${event.systemPrompt}\n\n${prompts.planPhase(cfg.finalizePlan)}` };
		if (state.phase === "execute") return { systemPrompt: `${event.systemPrompt}\n\n${prompts.EXECUTE_PHASE}` };
	});

	// Plan phase is read-only: the planner settles the approach, the execute model changes things.
	// Nested calls (codemode's tools.bash) pass through here too.
	pi.on("tool_call", async (event, ctx) => {
		if (state.phase === "execute") {
			// Pushing is the workflow's job after the judge passes; the executor may not publish or skip hooks.
			const input = (event.input ?? {}) as Record<string, unknown>;
			const texts: string[] = [];
			if (/(^|__)bash$/.test(event.toolName)) texts.push(String(input.command ?? ""));
			else if (/(^|__)ctx_execute(_file)?$/.test(event.toolName)) {
				const language = String(input.language ?? "").toLowerCase();
				const code = String(input.code ?? "");
				if (["shell", "bash", "sh", "zsh", "powershell", "pwsh", "ps1"].includes(language)) texts.push(code);
				else if (/\bgit\b/.test(code) && /\bpush\b|\bcommit\b|--no-verify|hooksPath|GIT_CONFIG/i.test(code)) {
					return { block: true, reason: "Refused: code that runs git push, skips hooks or changes hooks. The workflow commits and pushes after the judge passes." };
				} else if (/\bgh\b/.test(code) && /\b(pr|api)\b/.test(code)) {
					return { block: true, reason: "Refused: code that runs gh pr or gh api. The workflow opens and merges pull requests after the judge passes." };
				}
			}
			else if (/(^|__)ctx_batch_execute$/.test(event.toolName) && Array.isArray(input.commands)) {
				for (const c of input.commands) texts.push(String((c as { command?: unknown })?.command ?? ""));
			}
			const gitTexts = texts.filter((t) => /\bgit\b|\bgh\b/i.test(t));
			if (gitTexts.length === 0) return;
			const branch = (await git(ctx.cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
			for (const text of gitTexts) {
				const mode = state.commitPending?.mode;
				const problem = pushProblem(text, {
					branch,
					protectedBranches: cfg.protectedBranches,
					pushAllowed: mode === "push" || mode === "pr" || mode === "merge",
					prAllowed: mode === "pr" || mode === "merge",
					mergeAllowed: mode === "merge",
				});
				if (problem) return { block: true, reason: `Refused: ${problem}. Do not push, open or merge pull requests, or skip hooks yourself; the workflow does that after the judge passes, as this flow's delivery says.` };
			}
			return;
		}
		if (state.phase !== "plan") return;
		const refused = planToolRefused(event.toolName, planAllowedTools(), cfg.planBlockedTools);
		if (refused) return { block: true, reason: planBlocked(refused) };
		if (!cfg.planReadOnlyBash) return;
		if (event.toolName === "powershell") return { block: true, reason: planBlocked("PowerShell commands are not checked, so they are off while planning") };
		const problem = planToolProblem(event.toolName, (event.input ?? {}) as Record<string, unknown>, planAllow());
		if (problem) return { block: true, reason: planBlocked(problem) };
	});

	function planAllowedTools(): RegExp[] {
		return cfg.planAllowedTools.flatMap((p) => {
			try {
				return [new RegExp(p)];
			} catch {
				return [];
			}
		});
	}

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
		if (event.message.role === "assistant" && event.message.usage) view.mainUsage(countTokens(event.message.usage, cfg.tokenWeights), false);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) view.mainUsage(countTokens(event.message.usage, cfg.tokenWeights), true, event.message.model);
	});

	pi.registerEntryRenderer<FlowSummary>(SUMMARY_ENTRY, (entry, _opts, theme) => (entry.data ? new Text(summaryLines(entry.data, theme).join("\n"), 1, 0) : undefined));

	pi.on("agent_settled", async (event, ctx) => {
		view.settleMain();
		const tracked = state.phase !== "off" || state.tokens !== undefined;
		if (tracked && STAGES.some((s) => view.used[s].raw !== (state.tokens?.[s]?.raw ?? 0) || view.used[s].cost !== (state.tokens?.[s]?.cost ?? 0))) persist();
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
		if (event.source !== "extension") resumes = 0;
		if (state.phase !== "plan" || event.source === "extension" || event.streamingBehavior) return { action: "continue" };
		// Without a plan on screen, "yes, do that" answers a question; it doesn't approve anything.
		if (!planReady || !approveRe().test(event.text.trim())) return { action: "continue" };
		state.delivery = await chooseDelivery(ctx);
		state.planFlaw = undefined;
		if (cfg.finalizePlan) {
			// Same as the menu: the planner writes the final plan first, in its reply to this message.
			planReady = false;
			state.finalizing = true;
			persist();
			ctx.ui.notify(`workflow: plan approved (then ${DELIVERY_LABELS[state.delivery]}), the planner writes the final plan`, "info");
			return { action: "transform", text: `${event.text.trim()}\n\n${prompts.finalize(cfg.delivery.splitCommits)}` };
		}
		await setPhase(ctx, "execute");
		state.approvedPlan = lastPlanText || undefined;
		persist();
		ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(cfg.roles.execute)}, then ${DELIVERY_LABELS[state.delivery]}`, "info");
		return { action: "transform", text: `${event.text.trim()}\n\n${APPROVED}` };
	});

	pi.on("session_compact", async (event) => {
		if (event.reason === "overflow" && event.willRetry) overflowRetry = true;
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = [...event.messages].reverse().find((m) => m.role === "assistant");

		// "Prompt is too long": pi compacts and retries, but the retry ends on a tool result and the
		// bridge answers it with an empty reply, so the run stops. Ask the model to carry on.
		if (overflowRetry) {
			overflowRetry = false;
			if (shouldResume(true, last, resumes)) {
				resumes++;
				pi.sendMessage(
					{
						customType: "workflow-resume",
						content: "The conversation got too long for the model and was compacted. Continue the task from where you stopped, using the summary, without redoing finished steps.",
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}
		}

		if (state.phase === "plan" && state.finalizing) {
			state.finalizing = false;
			const finalText = assistantText(last).trim();
			if (last?.role === "assistant" && last.stopReason === "stop" && /^##\s*Plan:/m.test(finalText)) {
				await setPhase(ctx, "execute");
				state.approvedPlan = finalText;
				persist();
				pi.sendMessage({ customType: "workflow-execute", content: APPROVED_FINAL, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			// Not a final plan (error, abort, or a question back): nothing starts; the normal plan handling below offers the menu again.
			persist();
			ctx.ui.notify("workflow: that reply is not a final plan (a '## Plan:' section). Approve again to retry.", "warning");
		}

		if (!ctx.hasUI) return;
		const stoppedNormally = last?.role === "assistant" && last.stopReason === "stop" && assistantText(last).trim().length > 0;

		if (state.phase === "plan") {
			// Every finished reply offers the choice; aborted or errored ones do not.
			// A typed "go" approves only a finished plan that is not waiting on an answer.
			const text = assistantText(last).trim();
			planReady = isPlanReady(text, stoppedNormally);
			if (!stoppedNormally) return;
			lastPlanText = text;
			if (!cfg.planPrompt) {
				ctx.ui.notify(`workflow: say "go" to execute on ${describeRole(cfg.roles.execute)}, or keep discussing.`, "info");
				return;
			}
			const def = menuDefault();
			const options = cfg.delivery.ask ? deliveryChoices(def) : [def];
			const labels = options.map((d) => `Approve → ${deliveryMenuLabel(d, def)}`);
			const arbiterLabel = "Approve, arbiter solves plan flaws →";
			const choice = await ctx.ui.select(`Plan phase · execute on ${describeRole(cfg.roles.execute)}`, [...labels, ...(cfg.planFlaw === "ask" ? [arbiterLabel] : []), "Keep discussing"]);
			if (choice === arbiterLabel && cfg.planFlaw === "ask") {
				await approve(ctx, undefined, true);
				return;
			}
			const i = choice ? labels.indexOf(choice) : -1;
			if (i >= 0) await approve(ctx, options[i]);
			return;
		}

		if (state.phase !== "execute") return;
		if (skipJudge(last)) return;
		if (state.pendingPlanFlaw) {
			// The executor's own judge call questioned the plan; it was told to stop, so the workflow decides.
			const report = state.pendingPlanFlaw;
			state.pendingPlanFlaw = undefined;
			persist();
			const flawed = await collectDiff(ctx.cwd);
			if (flawed) {
				const outcome = await resolvePlanFlaw(ctx, report, flawed);
				if (outcome !== "continue") return;
				if (state.lastJudge?.hash === flawed.hash) {
					if (state.lastJudge.verdict === "PASS") markPassed(flawed.hash);
					else {
						await fixOrAsk(ctx, undefined);
						return;
					}
				} else {
					// No record of that review: let reviewDiff judge this diff again.
					seenDiffs.delete(flawed.hash);
				}
			}
		}
		if (state.commitPending) {
			await summarizeCommit(ctx);
			if (state.phase !== "execute") return; // the flow ended and went back to planning
		}
		await reviewDiff(ctx, false);
	});

	async function summarizeCommit(ctx: ExtensionContext): Promise<void> {
		const { mode, head, branch, prBefore } = state.commitPending!;
		state.commitPending = undefined;
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.delivery = undefined; // the flow is over; the next one chooses again
		state.planFlaw = undefined;
		// The commits' branch; HEAD when detached, unknown (state saved by an older version) or gone (deleted after the merge).
		const named = !!branch && branch !== "HEAD" && (await git(ctx.cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;
		const rev = named ? (branch as string) : "HEAD";
		const now = (await git(ctx.cwd, "rev-parse", rev)).stdout.trim();
		const pr = (mode === "pr" || mode === "merge") && branch && branch !== "HEAD" ? freshPr(await prState(ctx.cwd, branch), prBefore) : null;
		let shown: boolean;
		if (pr?.state !== "MERGED" && (!now || now === head)) shown = summarizeFlow("commit step ended without a commit", false);
		else {
			// A merge that deleted the branch leaves HEAD on the base branch, whose count would include other commits.
			const counted = named || !branch || branch === "HEAD" ? await git(ctx.cwd, "rev-list", "--count", `${head}..${rev}`) : undefined;
			const commits = counted?.code === 0 ? Number(counted.stdout.trim()) : undefined;
			const ahead = mode === "commit" ? undefined : await git(ctx.cwd, "rev-list", "--count", `${named ? branch : ""}@{u}..${rev}`);
			const pushed = ahead?.code === 0 && ahead.stdout.trim() === "0";
			const outcome = deliveryOutcome(mode, commits, pushed, pr);
			shown = summarizeFlow(outcome.text, outcome.ok);
		}
		if (!shown) persist(); // commitPending was cleared
		await endFlow(ctx);
	}

	/** The pull request for `branch` as gh sees it, or null when there is none or gh fails. */
	async function prState(cwd: string, branch: string): Promise<PrState | null> {
		try {
			const r = await pi.exec("gh", ["pr", "view", branch, "--json", "number,state"], { cwd, timeout: 30_000 });
			if (r.code !== 0) return null;
			const j = JSON.parse(r.stdout) as { number?: unknown; state?: unknown };
			return typeof j.number === "number" && typeof j.state === "string" ? { number: j.number, state: j.state } : null;
		} catch {
			return null;
		}
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
			const prior = state.lastJudge?.hash === diff.hash ? state.lastJudge.text : "";
			const open = minorFixOpen({
				committed: committedDiffs.has(diff.hash),
				commitPending: !!state.commitPending,
				summarized: !!state.summarizedPasses?.includes(diff.hash),
				sentFor: state.minorSentFor,
				hash: diff.hash,
			});
			if (open && fixMinorFindings(prior, diff.hash)) return;
			if (!(await finishPassed(ctx, diff.hash, prior ? `**Judge: PASS**\n\n${prior}` : undefined))) await summarizePass(ctx, diff.hash);
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
		if (hasPlanFlaw(r.text)) {
			const outcome = await resolvePlanFlaw(ctx, report, diff);
			if (outcome !== "continue") return;
			if (r.verdict === "PASS") markPassed(diff.hash);
		}
		if (r.verdict === "FAIL") {
			state.judgeRounds++;
			persist();
			await fixOrAsk(ctx, report);
			return;
		}

		if (fixMinorFindings(r.text, diff.hash, report)) return;
		if (!(await finishPassed(ctx, diff.hash, report))) {
			pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			await summarizePass(ctx, diff.hash);
		}
	}

	/** After a failed judge round: send the executor back to fix, or ask what to do once the round cap is hit. */
	async function fixOrAsk(ctx: ExtensionContext, report: string | undefined): Promise<void> {
		if (judgeCapReached(state.judgeRounds, cfg.maxJudgeRounds)) {
			if (report) pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			const choice = await ctx.ui.select(`Judge failed ${state.judgeRounds} rounds in a row`, ["Keep fixing", "Escalate and keep fixing", "Stop"]);
			if (choice === "Keep fixing" || choice === "Escalate and keep fixing") {
				if (choice !== "Keep fixing") await escalate(ctx);
				state.judgeRounds = 0;
				persist();
				pi.sendMessage({ customType: "workflow-fix", content: FIX_MESSAGE, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			ctx.ui.notify(`workflow: stopped after ${state.judgeRounds} failed judge rounds`, "warning");
			summarizeFlow(`stopped: judge failed ${state.judgeRounds} rounds`, false);
			await endFlow(ctx);
			return;
		}
		pi.sendMessage(
			{ customType: "workflow-fix", content: report ? `${report}\n\n${FIX_MESSAGE}` : FIX_MESSAGE, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	/**
	 * The judge says the approved plan itself is flawed. In "ask" mode the user decides; in "auto" mode
	 * (or on request, or when chosen at approval) the arbiter does, and asks the user only when it cannot decide.
	 * "continue": carry on with the verdict. "amended": the plan was changed and the executor is on it.
	 * "stop": back to planning, or the flow ended.
	 */
	async function resolvePlanFlaw(ctx: ExtensionContext, report: string, diff: Diff): Promise<"continue" | "amended" | "stop"> {
		let arbiter = arbiterFirst(state.planFlaw, cfg.planFlaw);
		let canAsk = true;
		for (;;) {
			if (arbiter) {
				arbiter = false;
				const outcome = await runArbiter(ctx, report, diff);
				if (outcome !== "ask") return outcome;
				canAsk = false; // the arbiter had its say; offer the rest
			}
			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
				summarizeFlow("stopped: judge questions the plan", false);
				await endFlow(ctx);
				return "stop";
			}
			const options = ["Back to planning", ...(canAsk ? ["Let the arbiter decide"] : []), "Ignore and continue", "Stop"];
			const choice = await ctx.ui.select("Judge questions the plan", options);
			if (choice === "Back to planning") {
				await setPhase(ctx, "plan");
				pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
				return "stop";
			}
			if (choice === "Let the arbiter decide") {
				arbiter = true;
				continue;
			}
			if (choice === "Ignore and continue") {
				// Recorded, so the next review does not raise the same flaw and ask again.
				const flaws = report.split("\n").filter((l) => /\[plan-flaw\]/.test(l));
				state.approvedPlan = `${state.approvedPlan ?? ""}\n\n## Plan choices upheld by the user\n${flaws.join("\n")}`;
				persist();
				return "continue";
			}
			pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			summarizeFlow("stopped: judge questions the plan", false);
			await endFlow(ctx);
			return "stop";
		}
	}

	/** Runs the arbiter on the judge's plan-flaw report. "ask" means it could not or may not decide. */
	async function runArbiter(ctx: ExtensionContext, report: string, diff: Diff): Promise<"continue" | "amended" | "ask"> {
		ctx.ui.setWorkingMessage("arbiter checking the plan…");
		let text: string;
		try {
			const max = cfg.judge.maxDiffChars;
			const { result, run } = await runRole("arbiter", "plan-flaw", {
				systemPrompts: [prompts.ARBITER, `## Approved plan\n\n${planForJudge()}`, `## Judge report\n\n${report}`, `## Diff\n\n${diff.text.length > max ? diff.text.slice(0, max) : diff.text}`],
				tools: cfg.arbiter.tools,
				task: "Decide on the [plan-flaw] findings in your system prompt.",
				cwd: ctx.cwd,
			});
			if (!result.ok) {
				ctx.ui.notify(`workflow: arbiter failed: ${result.error}`, "error");
				return "ask";
			}
			text = result.text;
			view.finish(run, true, parseArbiter(text)?.decision ?? "no decision");
		} finally {
			ctx.ui.setWorkingMessage();
		}
		const d = parseArbiter(text);
		if (!d) {
			ctx.ui.notify("workflow: the arbiter gave no decision", "warning");
			return "ask";
		}
		if (d.decision === "KEEP") {
			state.approvedPlan = `${state.approvedPlan ?? ""}\n\n## Plan choices upheld by the arbiter\n${d.reason}`;
			persist();
			pi.sendMessage({ customType: "workflow-judge", content: `**Arbiter: the plan stands.**\n\n${d.reason}`, display: true }, { triggerTurn: false });
			return "continue";
		}
		if (d.decision === "REVISE") {
			const done = state.planRevisions ?? 0;
			if (done >= cfg.maxPlanRevisions) {
				ctx.ui.notify(`workflow: the plan was already amended ${done} time(s); asking you instead`, "warning");
				return "ask";
			}
			state.planRevisions = done + 1;
			state.approvedPlan = `${state.approvedPlan ?? ""}\n\n## Amendment ${done + 1} (arbiter)\n${d.amendment}`;
			persist();
			pi.sendMessage(
				{
					customType: "workflow-amend",
					content: `${report}\n\n**Arbiter: the plan is amended.**\n\n${d.reason}\n\n${d.amendment}\n\nImplement this amendment exactly, fix the other blocker and major findings above, then call judge again.`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return "amended";
		}
		ctx.ui.notify(`workflow: the arbiter hands this to you: ${d.reason.split("\n")[0]}`, "info");
		return "ask";
	}

	/** A pass with findings goes back for a fix round, up to maxMinorRounds. True if it sent the fix message. */
	function fixMinorFindings(text: string, hash: string, report?: string): boolean {
		const findings = fixableFindings(text);
		// Same diff as the last fix message: the executor skipped the findings, so don't ask again.
		if (state.minorSentFor === hash) return false;
		if (afterPass(findings, state.minorRounds ?? 0, cfg.maxMinorRounds) !== "fix") return false;
		state.minorRounds = (state.minorRounds ?? 0) + 1;
		state.minorSentFor = hash;
		persist();
		const shown = report ?? `**Judge: PASS**\n\n${text}`;
		pi.sendMessage(
			{
				customType: "workflow-fix",
				content: `${shown}\n\nThe judge passed with ${findings} finding(s) to fix (knowledge deviations excluded; give a reason in \`disputes\` to keep one). Fix them by following their Fix directions, or put a wrong one in the \`disputes\` parameter of your next judge call instead of changing code. Then call judge again.`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return true;
	}

	/** Remembers a passed diff's flow as ended, so later runs on the same diff don't end another one. */
	function markPassSummarized(hash: string): void {
		state.summarizedPasses = [...(state.summarizedPasses ?? []).filter((h) => h !== hash), hash].slice(-20);
	}

	/** The flow ends at a pass that won't be committed (delivery off, or Stop at the knowledge prompt), and may go back to planning. */
	async function summarizePass(ctx: ExtensionContext, hash: string): Promise<void> {
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.delivery = undefined;
		state.planFlaw = undefined;
		if (state.summarizedPasses?.includes(hash)) return;
		markPassSummarized(hash);
		view.stage = "execute";
		if (!summarizeFlow("judge passed, not committed", true)) persist();
		await endFlow(ctx);
	}

	/** Diffs already handed to the commit step, so a pass is committed once. */
	const committedDiffs = new Set<string>();

	/** Sends the commit step's instruction (commit, push, pull request, merge, as this flow's delivery says), prefixed with `report`. False if nothing was sent. */
	async function finishPassed(ctx: ExtensionContext, hash: string, report?: string): Promise<boolean> {
		const chosen = state.delivery ?? defaultDelivery();
		if (chosen === "off" || committedDiffs.has(hash)) return false;
		committedDiffs.add(hash);
		const knowledge = state.lastKnowledge?.hash === hash ? state.lastKnowledge : undefined;
		// D5: a pass without a knowledge check commits only when you say so.
		if (knowledge?.status === "unavailable" && ctx.hasUI) {
			const choice = await ctx.ui.select(`Judge passed, knowledge not checked: ${knowledge.reason}`, ["Commit anyway", "Stop"]);
			if (choice !== "Commit anyway") return false;
		}

		let mode: Exclude<Delivery, "off"> = chosen;
		const current = (await git(ctx.cwd, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
		const unsafe = !current || current === "HEAD" || cfg.protectedBranches.includes(current);
		let branch = current;
		let from: string | undefined;
		if (unsafe && mode === "push") {
			mode = "commit";
			ctx.ui.notify(`workflow: on ${current || "a detached HEAD"}, committing without pushing`, "warning");
		} else if (unsafe && (mode === "pr" || mode === "merge")) {
			// A pull request never comes from a protected branch; the commits go on a new one.
			from = current || "HEAD";
			branch = await freeBranchName(ctx.cwd, branchName(cfg.delivery.branchPrefix, planTitle(state.approvedPlan), new Date()));
			ctx.ui.notify(`workflow: on ${current || "a detached HEAD"}, committing on new branch ${branch}`, "info");
		}
		const base = cfg.delivery.base || (from && from !== "HEAD" ? from : "");

		// An old closed or merged PR on this branch must not pass as this flow's (gh pr view falls back to it when none is open).
		let prBefore: number | undefined;
		if ((mode === "pr" || mode === "merge") && !from) {
			const old = await prState(ctx.cwd, branch);
			if (old && old.state !== "OPEN") prBefore = old.number;
		}

		view.stage = "commit";
		view.changed();
		state.commitPending = { mode, head: (await git(ctx.cwd, "rev-parse", "HEAD")).stdout.trim(), branch, prBefore };
		markPassSummarized(hash); // the commit run's end summarizes this flow
		persist();
		const instruction = deliveryInstruction({
			mode,
			branch,
			from,
			base,
			split: cfg.delivery.splitCommits,
			mergeMethod: cfg.delivery.mergeMethod,
			deleteBranch: cfg.delivery.deleteBranch,
			deviations: knowledge ? deviationBlock(knowledge.deviations) : "",
		});
		pi.sendMessage(
			{ customType: "workflow-commit", content: report ? `${report}\n\n${instruction}` : instruction, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return true;
	}

	/** `name`, or `name-2`, `name-3`, ... when a local branch already has it. */
	async function freeBranchName(cwd: string, name: string): Promise<string> {
		for (let n = 1; n < 100; n++) {
			const candidate = n === 1 ? name : `${name}-${n}`;
			if ((await git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`)).code !== 0) return candidate;
		}
		return `${name}-${Date.now()}`;
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
			if (state.tokenUnit !== "both") {
				// Saved before counts carried both raw and cost-weighted totals; the old ones would mislead.
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
		{ value: "delivery", label: "delivery <commit|push|pr|merge|off> - what happens after the judge passes, this flow" },
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
			`judge     ${state.judgeRounds} failed round(s); auto=${cfg.autoJudge}; then ${DELIVERY_LABELS[state.delivery ?? defaultDelivery()]}${state.delivery ? "" : " (default)"}`,
			state.planFlaw === "auto" ? "flaws     arbiter (this flow)" : `flaws     ${cfg.planFlaw === "auto" ? "arbiter" : "ask"} (config)`,
			`guard     compact at ${cfg.contextGuardTokens || "off"} tokens`,
			`tokens    ${STAGES.map((s) => `${s} ${fmtTok(view.sessionTokens(s))}`).join(" · ")} · session total ${fmtTok(STAGES.reduce((n, s) => ({ raw: n.raw + view.sessionTokens(s).raw, cost: n.cost + view.sessionTokens(s).cost }), { raw: 0, cost: 0 }))}`,
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
			if (parts[0] === "delivery" && parts.length === 2) {
				return DELIVERIES.filter((d) => d.startsWith(parts[1])).map((d) => ({ value: `delivery ${d}`, label: `${d} - ${DELIVERY_LABELS[d]}` }));
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
				case "delivery": {
					const want = rest[0]?.toLowerCase();
					if (!want) {
						ctx.ui.notify(`workflow: after the judge passes: ${DELIVERY_LABELS[state.delivery ?? defaultDelivery()]}. Usage: /flow delivery <${DELIVERIES.join("|")}>`, "info");
						return;
					}
					if (!isDelivery(want)) {
						ctx.ui.notify(`Usage: /flow delivery <${DELIVERIES.join("|")}>`, "warning");
						return;
					}
					state.delivery = want;
					persist();
					ctx.ui.notify(`workflow: after the judge passes: ${DELIVERY_LABELS[want]} (this flow)`, "info");
					return;
				}
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
