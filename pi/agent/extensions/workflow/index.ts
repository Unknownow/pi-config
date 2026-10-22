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

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
	getAgentDir,
	getShellConfig,
	loadProjectContextFiles,
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
	THINKING_LEVELS,
	type Role,
	saveRole,
	type Thinking,
	type WorkflowConfig,
} from "./config.ts";
import { handoverAction, afterPass, noChangeStage, arbiterFirst, fixableFindings, canApprove, hasPlanFlaw, planFlawLines, planFlawOnPass, hasPlanLine, isPlanReady, judgeCapReached, minorFixOpen, selfCommitted, parseArbiter, phaseAfterFlow, shouldResume, skipJudge } from "./agent-end.ts";
import { countTokens, type Tok } from "./tokens.ts";
import { idleReason, notifyCommand, notifyDue } from "./notify.ts";
import * as prompts from "./prompts.ts";
import { branchName, combineOutcomes, type Delivery, type DeliveryOptions, DELIVERIES, DELIVERY_LABELS, deliveryChoices, deliveryInstruction, deliveryMenuLabel, deliveryOutcome, freshPr, isDelivery, landedBranch, planTitle, pushSkipReason, type PrState, repoDeliveryInstruction } from "./delivery.ts";
import { modelChoices, pathCompletions } from "./pickers.ts";
import { ghCandidates, withPathDir } from "./gh-path.ts";
import { citeNames, collectRepoDiff as collectRepoDiffImpl, needsFinalFullReview, type RepoDiff } from "./repo-diff.ts";
import { combineRepoTexts, followFolders, parseAddDir, parseWorktreeList, repoKey, uniqueRoots } from "./repos.ts";
import { askFolderAdd } from "./folder-add.ts";
import { shellProblem } from "./push-guard.ts";
import { COMMIT_GUARD_ENV, type CommitGuardSpec } from "./commit-guard.ts";
import { RUNNER_GUARD_ENV, type RunnerGuardSpec } from "./runner-guard.ts";
import { parseTestReport } from "./test-report.ts";
import { amendmentTail, answerItem, askOptions, bodyField, newTestFlow, nextAction, normalize, openBugs, pendingFromFlaws, recordReport, skipItem, testOutcome, testPlan, type TestFlow } from "./test-flow.ts";
import { callDir, formatTaskResult, parseRunnerReply, runnerGate, sanitizeIds, scheduleTasks, taskCard, taskRecord, type TestTask, verifyRun } from "./test-run.ts";
import { commitPlan, type Finished, mergeChecklist, newFlowId, openStepsReminder, parseChecklist, type PlanStatus, planCard, pruneIds, renderPlanFile, splitPlanFile, type ChecklistItem } from "./plan-doc.ts";
import { addToRegistry, liveEvents, type LiveInfo, readLive } from "./board.ts";
import { adoptHigher, claimLive, commitRef, dropClaim, pidAlive, readClaim, writeClaim, deleteLocal, deleteRef, fetchMirror, type Git, listRefs, plansDir, pushRef, readLocalStatuses, readPlanMd, refRev, remoteOf, repoInfo, type RefEntry, writeLocal } from "./plan-store.ts";
import { type FlowFinding, recordFindings, reportFindings, type ReportStep } from "./flow-report.ts";
import { readOnlyProblem } from "./readonly-bash.ts";
import { checkpointAmendment, checkpointNote, checkpointOutcome, hasCheckpointAmendment, checkpointText, isPlannedTag, modeAllowed, parseDeliverStep, withCheckpoints } from "./checkpoints.ts";
import { pushArgs, tagDecision } from "./tags.ts";
import { type CheckVerdict, autopilotAmendment, autopilotReply, checkTitle, checkVerdict, parseWaitStep, pollDecision, resumePrefix, waitAmendment } from "./waits.ts";
import { nextStage, parseStages, stageDelivery, stageLine, stageNote, stageStart, stagesOutcome } from "./stages.ts";
import { planToolProblem, planToolRefused } from "./readonly-tools.ts";
import { MetricsQueue, type MetricEvent, subagentMetric } from "./metrics.ts";
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
	recheckKnowledgeFiles,
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

type Phase = "off" | "plan" | "execute" | "test";

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
	commitPending?: { mode: Exclude<Delivery, "off">; head: string; branch?: string; prBefore?: number; pushSkipped?: string; repos?: { root: string; mode: Exclude<Delivery, "off">; head: string; branch?: string; prBefore?: number; pushSkipped?: string }[] };
	/** What happens after the judge passes in this flow, chosen at approval; unset means `delivery.default`. */
	delivery?: Delivery;
	/** Plan flaws go straight to the arbiter in this flow, chosen at approval; unset means `cfg.planFlaw`. */
	planFlaw?: "auto";
	/** Passed diffs whose flow already ended (or will, at the commit run's end). */
	summarizedPasses?: string[];
	/** The plan the user approved (the final plan, plus arbiter amendments); the judge and the arbiter read it. */
	approvedPlan?: string;
	/** The plan's steps (S1, S2, ...) with the executor's ticks; claims, not proof. */
	checklist?: ChecklistItem[];
	/** Every finding the judge raised in this flow, for the end-of-flow card. */
	flowFindings?: FlowFinding[];
	/** The end-of-flow card of this flow has been written. */
	flowSummarized?: boolean;
	/** The plan's file in the repo's git folder: its flow ID, how many milestones wrote it, the repos it covers, and how the flow ended. */
	planDoc?: { flowId: string; rev: number; roots: string[]; finished?: Finished };
	/** The planner is writing the final execution plan; its reply becomes approvedPlan. */
	finalizing?: boolean;
	/** Amendments the arbiter added in this flow. */
	planRevisions?: number;
	/** A judge report that questions the plan, waiting for the end of the executor's turn. */
	pendingPlanFlaw?: string;
	/** Plan flaws the arbiter could not settle at a pass in this flow; the flow summary flags them. */
	unresolvedPlanFlaws?: number;
	/** The knowledge check of the last judge round (only when knowledge is active). */
	lastKnowledge?: LastKnowledge;
	/** The current stage (1-based) of a staged plan; unset when the plan is not staged. */
	stage?: number;
	/** The executor asked for a review in the current stage: a no-change turn may then end the stage. */
	stageJudged?: boolean;
	/** Outcomes of the stages delivered so far in this flow. */
	stageOutcomes?: { text: string; ok: boolean }[];
	/** Folders added with /folders or --add-dir: absolute, forward slashes, in the order added. */
	folders?: string[];
	/** Git roots edited in this flow that are neither the working folder's repo nor an added folder's repo. */
	touchedRepos?: string[];
	/** Set while a test-and-fix flow is active (phase "test"). */
	testFlow?: TestFlow;
	/** The flow waits for a person (and maybe a check) before it continues; no judge, delivery or stage advance meanwhile. */
	waiting?: { reason: string; check?: string; step?: string; stage?: number; since: string; planned: boolean; atStageStart?: boolean; checkPassed?: boolean; held?: string };
	/** Deliveries made inside the plan, before the end of a stage or flow. */
	checkpoints?: { step?: string; stage?: number; text: string; ok: boolean }[];
}

interface LastJudge {
	/** Hash of the full diff it reviewed. */
	hash: string;
	/** Per repo (key: repoKey(root)): the working tree it reviewed, as a git tree id, and HEAD then. Absent in state saved by older versions. */
	repos?: Record<string, { tree: string; head: string }>;
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
/** Public contract K1: the session's working folder and added folders, `{ v: 1, cwd, folders }`. The workflow is its only writer. */
const FOLDERS_ENTRY = "session-folders";
/** Display-only entry (never sent to the model) with the token breakdown of a finished flow. */
const SUMMARY_ENTRY = "workflow-summary";
const APPROVED = "Plan approved. Execute it now, step by step, following the workflow rules.";
const APPROVED_FINAL = "The final plan is approved. Execute it exactly, step by step, following the workflow rules.";
const FIX_MESSAGE =
	"Fix every blocker and major finding by following its Fix directions, and the minor ones too (except [knowledge ...] deviations: give your reason in `disputes` to keep the code). If a finding is wrong, put it in the `disputes` parameter of your next judge call instead of changing code. Then call judge again.";
/** The judge reads at most this much of the plan; the end (the arbiter's amendments) is kept. */
const MAX_PLAN_CHARS = 60_000;
const OWN_TOOLS = new Set(["explore", "advisor", "judge"]);
const EXPLORE_REASONS = ["question", "broad_search", "timeout", "too_much_output", "location_unknown", "parallel_lookups"] as const;
const execFileAsync = promisify(execFile);
/** Subagent-only extension that registers forwarded MCP servers (see mcp-forward.ts). */
const FORWARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "workflow", "mcp-forward.ts");
const COMMIT_GUARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "workflow", "commit-guard.ts");
/** Subagent-only extension that guards the test runners (see runner-guard.ts). */
const RUNNER_GUARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "workflow", "runner-guard.ts");

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
	/** The repos of this flow; `changed` marks those with changes. */
	repos: RepoRef[];
	/** The diff combines several repos (each section headed `=== repo: <root> ===`). */
	multi: boolean;
}

interface RepoRef {
	root: string;
	/** Where git runs for it: the session's working folder for the primary repo, else the root. */
	dir: string;
	changed: boolean;
}

type Snaps = Record<string, { tree: string; head: string }>;

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
	/** A planner reply in the current plan discussion had a plan line; with planRecap "changes" a typed "go" then approves later replies without one. Reset when the phase changes. */
	let planProposed = false;
	/** The planner's last finished reply, kept as the approved plan when finalizePlan is off. */
	let lastPlanText = "";
	let guardTokens: number | null = null;
	let compacting = false;
	let commitHandoverInFlight = false; // the commit instruction waits for a handover compaction: a run ending meanwhile must not close the commit
	/** The guard threshold was crossed during a run; compact when the run settles. */
	let compactPending = false;
	/** A handover message (execute, fix round, next stage) sent from agent_end; it goes out when the run settles, after an optional compaction. */
	let pendingHandover: { customType: string; content: string } | undefined;
	let inAgentEnd = 0; // nesting depth: a run can end while a handler still waits on the commit subagent
	let lastNotifyAt: number | undefined;
	let notifiedSinceStart = false; // a notification already went out for this turn
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** A desktop notification that this session needs the user. Never throws; rate-limited. */
	function notifyUser(ctx: ExtensionContext, why: string): void {
		try {
			const now = Date.now();
			if (!notifyDue({ enabled: cfg.notify.enabled, hasUI: ctx.hasUI, now, last: lastNotifyAt })) return;
			lastNotifyAt = now;
			notifiedSinceStart = true;
			const c = notifyCommand(process.platform, "pi", `${path.basename(ctx.cwd)}: ${why}`);
			if (!c) return;
			const child = spawn(c.command, c.args, { detached: true, stdio: "ignore", windowsHide: true });
			child.on("error", () => {});
			child.unref();
		} catch {}
	}
	/** A menu that waits for the user: notify, then ask. */
	function askUser(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
		notifyUser(ctx, title);
		return ctx.ui.select(title, options);
	}
	/** After a run settles, notify when the session stays idle; a new turn cancels it. */
	function scheduleIdleNotice(ctx: ExtensionContext): void {
		if (idleTimer) clearTimeout(idleTimer);
		if (!cfg.notify.enabled || !ctx.hasUI) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			try {
				if (notifiedSinceStart || !ctx.isIdle()) return;
				if (compacting || compactPending || pendingHandover || commitHandoverInFlight || commitSubagentRunning) return scheduleIdleNotice(ctx);
				notifyUser(ctx, idleReason({ phase: state.phase, waiting: state.waiting?.reason }));
			} catch {}
		}, cfg.notify.idleMs);
		idleTimer.unref?.();
	}
	let commitSubagentRunning = false; // a run ending meanwhile must not close the commit
	/** An overflow compaction is retrying the turn; the bridge may answer that retry with an empty reply. */
	let overflowRetry = false;
	/** Automatic resumes since the user's last prompt. */
	let resumes = 0;
	/** /flow autopilot sets this for the session; it is not persisted, so a restart falls back to the config. */
	let autopilotOverride: boolean | undefined;
	const autopilotOn = (): boolean => autopilotOverride ?? cfg.autopilot;
	const view = new FlowView(cfg.roles);

	pi.registerFlag("add-dir", {
		description: "Extra folders for this session, separated by ; on Windows and : elsewhere",
		type: "string",
	});

	pi.registerFlag("flow", {
		description: "Workflow phase to start in: plan, execute, test or off (default from workflow.json)",
		type: "string",
	});

	// ----------------------------------------------------------------------
	// Phases and models
	// ----------------------------------------------------------------------

	let lastCtx: ExtensionContext | undefined;

	function persist(): void {
		state.tokens = { ...view.used };
		state.tokenUnit = "both";
		state.flow = structuredClone(view.flow);
		state.flowStarted = view.flowStarted;
		pi.appendEntry(STATE_ENTRY, state);
	}

	/** K1: appends the folder list as a `session-folders` entry when the newest one on the branch differs. */
	function publishFolders(ctx: ExtensionContext): void {
		const data = { v: 1, cwd: ctx.cwd.replace(/\\/g, "/"), folders: [...(state.folders ?? [])] };
		const newest = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === FOLDERS_ENTRY)
			.pop() as { data?: { cwd?: unknown; folders?: unknown } } | undefined;
		if (newest?.data && newest.data.cwd === data.cwd && JSON.stringify(newest.data.folders) === JSON.stringify(data.folders)) return;
		pi.appendEntry(FOLDERS_ENTRY, data);
	}

	/** Ends the current flow: shows its token breakdown and starts counting the next one. False if it had none. */
	function summarizeFlow(outcome: string, ok: boolean): boolean {
		if ((state.unresolvedPlanFlaws ?? 0) > 0) outcome += ` · ${state.unresolvedPlanFlaws} plan flaw(s) not settled (see the plan)`;
		state.unresolvedPlanFlaws = undefined;
		const steps: ReportStep[] | undefined = state.checklist?.length ? state.checklist.map((c) => ({ id: c.id, text: c.text, done: c.done })) : undefined;
		const found = reportFindings(state.flowFindings, state.approvedPlan);
		const findings = found.length ? found : undefined;
		const flowId = state.planDoc?.flowId;
		state.flowSummarized = true;
		state.flowFindings = undefined;
		if (state.planDoc && !state.planDoc.finished) planMilestone(undefined, { at: new Date().toISOString(), ok, text: outcome });
		state.touchedRepos = undefined;
		view.settleMain();
		if (!view.hasFlowUsage() && !steps && !findings) {
			if (flowId) {
				const empty = view.peekFlow(outcome, ok);
				recordMetric({ kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: empty.started, ended: empty.ended, stages: empty.stages });
			}
			persist();
			return false;
		}
		const summary = view.endFlow(outcome, ok);
		pi.appendEntry(SUMMARY_ENTRY, { ...summary, steps, findings });
		if (flowId) recordMetric({ kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: summary.started, ended: summary.ended, stages: summary.stages });
		persist();
		return true;
	}

	/** A flow has ended: back to the plan phase when returnToPlan says so. */
	async function endFlow(ctx: ExtensionContext): Promise<void> {
		notifyUser(ctx, "flow finished");
		state.waiting = undefined;
		stopWaitTimer();
		if (state.testFlow) {
			state.testFlow = undefined;
			state.delivery = undefined;
			state.planFlaw = undefined;
			persist();
		}
		updateStatus(ctx);
		if (phaseAfterFlow(cfg.returnToPlan, state.phase) !== "plan") return;
		await setPhase(ctx, "plan");
		ctx.ui.notify(`workflow: flow done, back to planning on ${describeRole(cfg.roles.plan)}`, "info");
	}

	function updateStatus(ctx: ExtensionContext): void {
		lastCtx = ctx;
		view.roles = cfg.roles;
		view.weights = cfg.tokenWeights;
		view.phase = state.phase;
		view.escalated = state.escalated;
		if (state.phase === "plan") view.stage = "plan";
		else if (state.phase === "test") view.stage = "test";
		else if (view.stage === "plan" || view.stage === "test") view.stage = "execute";
		if (ctx.hasUI) view.mount(ctx.ui);
		const n = existingFolders().length + (state.touchedRepos?.length ?? 0);
		const cl = state.checklist;
		if (ctx.hasUI) ctx.ui.setStatus("workflow-plan", cl?.length && state.phase === "execute" ? `plan ${cl.filter((i) => i.done).length}/${cl.length}` : undefined);
		if (ctx.hasUI) ctx.ui.setStatus("workflow-wait", state.waiting && state.phase === "execute" ? `waiting: ${state.waiting.reason.slice(0, 40)}` : undefined);
		if (ctx.hasUI) ctx.ui.setStatus("workflow-autopilot", autopilotOn() ? "autopilot" : undefined);
		if (ctx.hasUI) ctx.ui.setStatus("workflow-folders", n ? `+${n} folder${n === 1 ? "" : "s"}` : undefined);
		if (state.approvedPlan && cl?.length && (state.phase === "execute" || state.phase === "test")) {
			const st = currentStages();
			const open = cl.find((i) => !i.done);
			view.progress = {
				...(st ? { stage: st.current, stages: st.stages.length } : {}),
				done: cl.filter((i) => i.done).length,
				total: cl.length,
				...(open ? { current: `${open.id} ${open.text}` } : {}),
				judgeRound: state.judgeRounds,
				...(state.waiting ? { waiting: state.waiting.reason } : {}),
			};
		} else view.progress = undefined;
		emitStatus();
		liveTick();
	}

	let lastStatusEvent = "";
	/** K4: tells other extensions the phase and stage; only when it changed. */
	function emitStatus(): void {
		const st = currentStages();
		const payload = {
			v: 1,
			phase: state.phase,
			...(state.planDoc?.flowId ? { flowId: state.planDoc.flowId } : {}),
			...(state.approvedPlan ? { title: planTitle(state.approvedPlan) } : {}),
			...(st ? { stage: st.current, stages: st.stages.length } : {}),
		};
		const json = JSON.stringify(payload);
		if (json === lastStatusEvent) return;
		lastStatusEvent = json;
		try {
			pi.events.emit("workflow:status", payload);
		} catch {}
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

	/** The read-only tool set of plan phase; the test phase adds test_run and drops judge and plan_check. */
	function blockPlanTools(phase: "plan" | "test" = "plan"): void {
		state.toolsBeforePlan ??= pi.getActiveTools();
		const allowed = phase === "test" ? testAllowedTools() : planAllowedTools();
		const blocked = phase === "test" ? testBlockedTools() : cfg.planBlockedTools;
		pi.setActiveTools(state.toolsBeforePlan.filter((t) => !planToolRefused(t, allowed, blocked)));
	}

	function testAllowedTools(): RegExp[] {
		return [...planAllowedTools(), /^test_run$/];
	}

	function testBlockedTools(): string[] {
		return [...cfg.planBlockedTools, "judge", "plan_check", "wait_for_user", "deliver"];
	}

	/** The widget stage the main session is in. */
	function phaseStage(): Stage {
		return state.phase === "plan" ? "plan" : state.phase === "test" ? "test" : "execute";
	}

	function restorePlanTools(): void {
		if (!state.toolsBeforePlan) return;
		const extra = pi.getActiveTools().filter((t) => !state.toolsBeforePlan!.includes(t));
		pi.setActiveTools([...state.toolsBeforePlan, ...extra]);
		state.toolsBeforePlan = undefined;
	}

	async function setPhase(ctx: ExtensionContext, phase: Phase): Promise<void> {
		const leavingFlow = (state.phase === "execute" || state.phase === "test") && phase !== state.phase;
		if (leavingFlow && state.approvedPlan && !state.flowSummarized) {
			summarizeFlow(stoppedSummary(phase === "plan" ? "back to planning" : "abandoned"), false);
		}
		planReady = false;
		planProposed = false;
		const readOnly = (p: Phase) => p === "plan" || p === "test";
		if (readOnly(state.phase) && phase !== state.phase) restorePlanTools();
		if (readOnly(phase) && phase !== state.phase) blockPlanTools(phase as "plan" | "test");
		if (leavingFlow && state.planDoc && !state.planDoc.finished) planMilestone(ctx, { at: new Date().toISOString(), ok: false, text: "abandoned" });
		const leftTest = state.phase === "test";
		state.testFlow = undefined;
		state.phase = phase;
		state.escalated = false;
		state.judgeRounds = 0;
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.commitPending = undefined;
		state.waiting = undefined;
		state.checkpoints = undefined;
		stopWaitTimer();
		state.finalizing = undefined;
		state.planRevisions = undefined;
		state.pendingPlanFlaw = undefined;
		state.unresolvedPlanFlaws = undefined;
		state.touchedRepos = undefined;
		state.stage = undefined;
		state.stageJudged = undefined;
		state.stageOutcomes = undefined;
		if (phase === "plan" || leftTest) {
			state.approvedPlan = undefined;
			state.checklist = undefined;
			state.planDoc = undefined;
			state.delivery = undefined;
			state.planFlaw = undefined;
		}
		consecutiveErrors = 0;
		if (phase !== "off") await applyRole(ctx, phase);
		persist();
		updateStatus(ctx);
	}

	/** Re-reads the steps from the approved plan (after an amendment too), keeping the ticks of the steps still in it. */
	function refreshChecklist(): void {
		const list = state.approvedPlan ? mergeChecklist(state.approvedPlan, state.checklist) : [];
		state.checklist = list.length ? list : undefined;
	}

	/** Records the plan that starts executing; for a staged plan also stage 1. Returns the text to add to the start message. */
	function startExecution(ctx: ExtensionContext, plan: string | undefined): string {
		state.approvedPlan = plan || undefined;
		state.checklist = undefined;
		state.planDoc = undefined;
		state.flowFindings = undefined;
		state.flowSummarized = undefined;
		refreshChecklist();
		updateStatus(ctx);
		state.stageOutcomes = undefined;
		state.stageJudged = undefined;
		const stages = parseStages(plan);
		state.stage = stages.length ? 1 : undefined;
		planMilestone(ctx);
		if (!stages.length) return "";
		ctx.ui.notify(`workflow: staged plan, ${stages.length} stages; stage 1: ${stages[0].title}`, "info");
		const first = stageStart(stages, 1, state.delivery ?? defaultDelivery());
		if (holdForStageWait(ctx, stages[0], first)) return `\n\nStage 1 waits for: ${stages[0].after?.reason}. Don't start it; end your turn now. The workflow sends you the stage when the wait is over.`;
		return `\n\n${first}`;
	}

	/** The stages of the approved plan and the current one, or null when the plan is not staged. */
	function currentStages() {
		const stages = state.stage ? parseStages(state.approvedPlan) : [];
		return stages.length && state.stage ? { stages, current: state.stage } : null;
	}

	async function approve(ctx: ExtensionContext, delivery?: Delivery, arbiterOnFlaw = false): Promise<void> {
		state.delivery = delivery ?? (await chooseDelivery(ctx));
		state.planFlaw = arbiterOnFlaw ? "auto" : undefined;
		if (cfg.finalizePlan) {
			// One more planner reply, the final execution plan, before the execute model starts.
			planReady = false;
			state.finalizing = true;
			persist();
			pi.sendMessage({ customType: "workflow-finalize", content: prompts.finalize(cfg.delivery.splitCommits, DELIVERY_LABELS[state.delivery], cfg.stagedPlans), display: true }, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		await setPhase(ctx, "execute");
		const extra = startExecution(ctx, lastPlanText);
		persist();
		pi.sendMessage({ customType: "workflow-execute", content: APPROVED + extra, display: true }, { triggerTurn: true, deliverAs: "followUp" });
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
		if (!cfg.delivery.ask || !ctx.hasUI || autopilotOn()) return def;
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
		opts: { systemPrompts: string[]; tools: string[]; task: string; cwd: string; signal?: AbortSignal; thinking?: Thinking; env?: Record<string, string>; extensions?: string[]; timeoutMs?: number },
		onChange?: (run: RunView) => void,
	): Promise<{ result: RunResult; run: RunView }> {
		const run = view.start(role, label);
		onChange?.(run);
		const { thinking, extensions, timeoutMs, ...rest } = opts;
		const k = knowledgeFor(role);
		const started = Date.now();
		const result = await runSubagent({
			...rest,
			tools: k ? [...rest.tools, ...k.tools] : rest.tools,
			systemPrompts: k && role !== "judge" ? [...rest.systemPrompts, prompts.knowledgeTools(k.tools)] : rest.systemPrompts,
			mcp: k ? { servers: k.servers, extension: FORWARD_EXTENSION } : undefined,
			role: thinking ? { ...cfg.roles[role], thinking } : cfg.roles[role],
			extensions: extensions ? [...cfg.subagent.extensions, ...extensions] : cfg.subagent.extensions,
			timeoutMs: timeoutMs ?? cfg.subagent.timeoutMs,
			idleTimeoutMs: cfg.subagent.idleTimeoutMs,
			onEvent: (e) => {
				view.event(run, e, opts.cwd);
				onChange?.(run);
			},
		});
		recordMetric(subagentMetric(role, label, run.stage, result.model ?? cfg.roles[role].model, started, Date.now(), result));
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

	/** Tracked changes against `base` plus untracked files of one repo (untruncated), or null outside a git work tree. */
	function collectRepoDiff(cwd: string, base = "HEAD"): Promise<RepoDiff | null> {
		return collectRepoDiffImpl(git, cwd, base);
	}

	/** A Diff from untruncated text: hash over all of it, text cut at the judge's limit. */
	function makeDiff(full: string, files: number, names: string[], checkNames: string[], base: string, repos: RepoRef[], multi: boolean): Diff {
		const hash = createHash("sha1").update(full).digest("hex");
		const truncated = full.length > cfg.judge.maxDiffChars;
		const text = truncated ? `${full.slice(0, cfg.judge.maxDiffChars)}\n\n[diff truncated; read the files for the rest]` : full;
		return { text, hash, files, truncated, base, names, checkNames, chars: full.length, repos, multi };
	}

	/** One repo's diff, or null outside a git work tree. */
	async function collectDiff(cwd: string, base = "HEAD"): Promise<Diff | null> {
		const r = await collectRepoDiff(cwd, base);
		if (!r) return null;
		const root = (await gitRoot(cwd)) ?? cwd;
		return makeDiff(r.full, r.files, r.names, r.checkNames, base, [{ root, dir: cwd, changed: r.full.length > 0 }], false);
	}

	const rootCache = new Map<string, string>();

	/** The git work tree's top folder containing `dir`, or null. Only successes are cached. */
	async function gitRoot(dir: string): Promise<string | null> {
		const k = repoKey(dir);
		const hit = rootCache.get(k);
		if (hit) return hit;
		if (!fs.existsSync(dir)) return null;
		const r = await git(dir, "rev-parse", "--show-toplevel");
		const root = r.code === 0 ? r.stdout.trim() : "";
		if (!root) return null;
		rootCache.set(k, root);
		return root;
	}

	/** Folders added to the session that still exist. */
	function existingFolders(): string[] {
		return (state.folders ?? []).filter((f) => {
			try {
				return fs.statSync(f).isDirectory();
			} catch {
				return false;
			}
		});
	}

	/** The repos of this flow: the working folder's, the added folders', then those edited in the flow; git work trees only, no repeats. */
	async function flowRepos(ctx: ExtensionContext): Promise<RepoRef[]> {
		const out: RepoRef[] = [];
		const seen = new Set<string>();
		const add = (root: string | null, dir: string) => {
			if (!root || seen.has(repoKey(root))) return;
			seen.add(repoKey(root));
			out.push({ root, dir, changed: false });
		};
		add(await gitRoot(ctx.cwd), ctx.cwd);
		for (const f of existingFolders()) {
			const root = await gitRoot(f);
			add(root, root ?? f);
		}
		for (const t of state.touchedRepos ?? []) {
			const root = await gitRoot(t);
			add(root, root ?? t);
		}
		return out;
	}

	/** The diff of every repo in this flow. With only the working folder's repo it is exactly collectDiff(ctx.cwd). */
	async function collectFlowDiff(ctx: ExtensionContext, base = "HEAD"): Promise<Diff | null> {
		const refs = await flowRepos(ctx);
		if (refs.length === 0) return null;
		if (refs.length === 1 && refs[0].dir === ctx.cwd) return collectDiff(ctx.cwd, base);
		const per = await mapLimit(refs, 4, async (ref) => {
			let b = base;
			// A base that exists only in the working folder's repo means HEAD in the others.
			if (ref.dir !== ctx.cwd && base !== "HEAD" && (await git(ref.dir, "rev-parse", "--verify", "--quiet", `${base}^{commit}`)).code !== 0) b = "HEAD";
			return collectRepoDiff(ref.dir, b);
		});
		const parts: { root: string; text: string }[] = [];
		const names: string[] = [];
		const checkNames: string[] = [];
		let files = 0;
		const repos = refs.map((ref, i) => {
			const r = per[i];
			if (r) {
				parts.push({ root: ref.root, text: r.full });
				names.push(...r.rootNames.map((n) => `${ref.root}/${n}`));
				for (const n of r.checkNames) if (!checkNames.includes(n)) checkNames.push(n);
				files += r.files;
			}
			return { ...ref, changed: !!r && r.full.length > 0 };
		});
		return makeDiff(combineRepoTexts(parts), files, names, checkNames, base, repos, true);
	}

	function repoRoots(diff: Diff): string[] {
		return diff.repos.filter((r) => r.changed).map((r) => r.root);
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
		const tmp = path.join(os.tmpdir(), `workflow-judge-index-${process.pid}-${randomUUID()}`); // unique: snapshotRepos runs this for several repos at once
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
		| { kind: "full"; snaps: Snaps | null }
		| { kind: "recheck"; snaps: Snaps; prev: LastJudge; delta: string; changed: string[]; cites: string[] }
		| { kind: "same"; prev: LastJudge };

	/** Each repo's working tree and HEAD, or null when a tree cannot be built. */
	async function snapshotRepos(diff: Diff): Promise<Snaps | null> {
		const per = await Promise.all(
			diff.repos.map(async (r) => {
				const [tree, head] = await Promise.all([snapshotTree(r.dir), git(r.dir, "rev-parse", "HEAD")]);
				return { key: repoKey(r.root), tree, head: head.stdout.trim() };
			}),
		);
		const snaps: Snaps = {};
		for (const p of per) {
			if (!p.tree) return null;
			snaps[p.key] = { tree: p.tree, head: p.head };
		}
		return snaps;
	}

	/** Whether the judge reviews the whole diff, only the changes since its last round, or nothing (no changes since). */
	async function reviewPlan(diff: Diff, full: boolean, skipSame = false): Promise<ReviewPlan> {
		const prev = state.lastJudge;
		if (!full && !skipSame && prev?.hash === diff.hash) return { kind: "same", prev };
		const snaps = await snapshotRepos(diff);
		const fullPlan = { kind: "full" as const, snaps };
		// A commit, rebase or branch switch since, another base or another set of repos: the last round no longer lines up.
		if (full || !cfg.judge.recheck || !prev?.repos || !snaps || prev.base !== diff.base) return fullPlan;
		const before = prev.repos;
		const keys = Object.keys(snaps);
		if (keys.length !== Object.keys(before).length || keys.some((k) => before[k]?.head !== snaps[k].head)) return fullPlan;
		const per = await Promise.all(
			diff.repos.map(async (r) => {
				const k = repoKey(r.root);
				const [d, n] = await Promise.all([
					git(r.dir, "diff", "--no-color", before[k].tree, snaps[k].tree),
					git(r.dir, "diff", "--name-only", "-z", "--diff-filter=d", before[k].tree, snaps[k].tree),
				]);
				return { root: r.root, text: d.stdout, names: n.stdout.split("\0").filter(Boolean) };
			}),
		);
		const delta = diff.multi ? combineRepoTexts(per) : per[0].text;
		// Fixes that rewrite most of the change get a full review: little to save, more to miss.
		if (!delta.trim() || delta.length > diff.chars * cfg.judge.recheckMaxShare) return fullPlan;
		const changed: string[] = [];
		for (const p of per) for (const n of p.names) if (!changed.includes(n)) changed.push(n);
		return { kind: "recheck", snaps, prev, delta, changed, cites: citeNames(per, diff.multi) };
	}

	/**
	 * Reviews `diff`. The first round sees the whole diff; later rounds see only the changes since the
	 * last round plus its findings (cheaper, fresh each time). A large change that passes on a
	 * re-review gets one final full review when the changes since touched a file the last findings did not cite. `full` forces a full review.
	 */
	async function judge(ctx: ExtensionContext, diff: Diff, focus: string | undefined, signal?: AbortSignal, onChange?: (run: RunView) => void, full = false, disputes?: string): Promise<JudgeResult & { run: RunView }> {
		// Disputes need a fresh look at the code, so they never get the "no changes" shortcut (a recheck still applies).
		const plan = await reviewPlan(diff, full, Boolean(disputes));
		if (plan.kind === "same") {
			const run = view.start("judge", "no changes since the last round");
			view.finish(run, plan.prev.verdict === "PASS", `${plan.prev.verdict} · unchanged, previous result`);
			onChange?.(run);
			seenDiffs.add(diff.hash);
			return { verdict: plan.prev.verdict, text: `No changes since the last judge round; its result stands.\n\n${plan.prev.text}`, hash: diff.hash, usage: emptyUsage(), run };
		}
		let r = await judgeOnce(ctx, diff, focus, plan, signal, onChange, disputes);
		const limit = cfg.judge.finalFullReviewOverChars;
		if (r.verdict === "PASS" && plan.kind === "recheck" && limit > 0 && diff.chars > limit && needsFinalFullReview(cfg.judge.finalFullReviewNewFilesOnly, plan.prev.text, plan.cites)) {
			const final = await judgeOnce(ctx, diff, focus, { kind: "full", snaps: plan.snaps }, signal, onChange, disputes);
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
		const staged = currentStages();
		const note = staged ? `\n\n${stageNote(staged.stages, staged.current)}` : "";
		const list = state.checklist?.length ? `\n\n## Executor's checklist (claims, not proof)\n${state.checklist.map((i) => `- [${i.done ? "x" : " "}] ${i.id} ${i.text}`).join("\n")}` : "";
		return trimPlan(plan) + note + list + checkpointSection();
	}

	/** Checkpoints delivered earlier: this stage's in a staged plan, all of them otherwise. */
	function stageCheckpoints(): NonNullable<FlowState["checkpoints"]> {
		const staged = currentStages();
		return (state.checkpoints ?? []).filter((c) => !staged || c.stage === staged.current);
	}

	function checkpointSection(): string {
		const note = checkpointNote(stageCheckpoints());
		return note ? `\n\n${note}` : "";
	}

	/** N of the next `## Amendment N`: the amendments already in the approved plan + 1 (shared by the arbiter and the executor). */
	function nextAmendmentNumber(): number {
		return (state.approvedPlan?.match(/^## Amendment \d+/gm) ?? []).length + 1;
	}

	/** The commit step's view of the plan: goal, commits, amendments and the stage being delivered; the whole plan when it has no Commits section. */
	function commitExcerpt(): string {
		const excerpt = commitPlan(state.approvedPlan ?? "");
		if (!excerpt) return `## Approved plan\n\n${planForJudge()}`;
		const staged = currentStages();
		return (staged ? `${excerpt}\n\n${stageNote(staged.stages, staged.current)}` : excerpt) + checkpointSection();
	}

	/** `planCardText` once the plan file is written: waits for the plan write queue, at most 10 s, so the card can name the file. */
	async function planCardReady(): Promise<string> {
		if (!planFilePath()) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([planChain, new Promise<void>((resolve) => (timer = setTimeout(resolve, 10_000)))]);
			clearTimeout(timer);
		}
		return planCardText();
	}

	/** The short plan sent after a compaction in place of the full plan. Without a plan file it carries the (trimmed) plan itself. */
	function planCardText(): string {
		const staged = currentStages();
		const file = planFilePath();
		const plan = state.approvedPlan ?? "";
		return planCard(file ? plan : trimPlan(plan), state.checklist, staged?.current, staged?.stages.length, file, state.waiting?.reason);
	}

	// ----------------------------------------------------------------------
	// Plan files
	// ----------------------------------------------------------------------

	const gitEnv: Git = async (cwd, args, env) => {
		try {
			const r = await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
			return { code: 0, stdout: String(r.stdout), stderr: String(r.stderr) };
		} catch (e) {
			const err = e as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
			return { code: typeof err.code === "number" ? err.code : 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") };
		}
	};

	/** Where each flow's plan folder lives, and what was last written there (so the file can be rewritten without git calls). */
	const planDirs = new Map<string, string>();
	const planLast = new Map<string, { dir: string; status: PlanStatus }>();
	const planWarned = new Set<string>();

	/** Metrics wait here until the flow has a plan folder. */
	const metrics = new MetricsQueue();
	const metricsFolder = (id: string) => {
		const d = planDirs.get(id);
		return d ? path.join(d, id) : undefined;
	};
	const metricsFlushAll = () => metrics.flush(metricsFolder, state.planDoc && !state.planDoc.finished ? state.planDoc.flowId : undefined);
	function recordMetric(e: MetricEvent): void {
		metrics.record(e);
		metricsFlushAll();
	}
	let planChain: Promise<void> = Promise.resolve();
	/** Plan folder per repo root: `plansDir` runs git, and the answer does not change during a session. */
	const plansDirCache = new Map<string, string>();
	async function planDirFor(root: string | null): Promise<string> {
		if (root === null) return plansDir(gitEnv, null, getAgentDir());
		const key = repoKey(root);
		let dir = plansDirCache.get(key);
		if (dir === undefined) {
			let answered = false;
			dir = await plansDir(async (cwd, args, env) => {
				const r = await gitEnv(cwd, args, env);
				answered = r.code === 0;
				return r;
			}, root, getAgentDir());
			if (answered) plansDirCache.set(key, dir);
		}
		return dir;
	}

	interface PlanSnap {
		flowId: string;
		rev: number;
		roots: string[];
		plan: string;
		checklist?: ChecklistItem[];
		stage?: number;
		delivery?: string;
		kind?: "test";
		touched: string[];
		finished?: Finished;
		waiting?: NonNullable<PlanStatus["waiting"]>;
		checkpoints?: { step?: string; stage?: number; text: string; ok: boolean }[];
		/** A restore of the file (no new rev): never commits over a newer ref. */
		retry?: boolean;
	}

	/** S2: this session's claim on its unfinished flow, rewritten every 60 s so others can tell it is alive. */
	let claimedFlow: string | undefined;
	let claimTimer: ReturnType<typeof setInterval> | undefined;
	let claimCwd = "";
	function refreshClaim(): void {
		const dir = claimedFlow ? planDirs.get(claimedFlow) : undefined;
		if (!claimedFlow || !dir) return;
		try {
			writeClaim(dir, claimedFlow, { v: 1, pid: process.pid, host: os.hostname(), cwd: claimCwd || process.cwd(), updated: new Date().toISOString() });
		} catch {}
	}
	function stopClaimTimer(): void {
		if (claimTimer) clearInterval(claimTimer);
		claimTimer = undefined;
		claimedFlow = undefined;
	}

	/** The flow's `live.json`: what the board shows of this session. Written on change and every 60 s. */
	let liveLast: LiveInfo | undefined;
	let liveLastJson = "";
	let liveLastWrite = 0;
	let liveEventLog: { at: string; text: string }[] = [];
	let liveTimer: ReturnType<typeof setInterval> | undefined;
	let liveFlow: string | undefined;
	const liveRegistered = new Set<string>();
	function liveSnapshot(): LiveInfo | undefined {
		const flowId = state.planDoc?.flowId;
		if (!flowId || !planDirs.get(flowId)) return undefined;
		const st = currentStages();
		return {
			v: 1,
			flowId,
			title: state.approvedPlan ? planTitle(state.approvedPlan) : flowId,
			pid: process.pid,
			host: os.hostname(),
			cwd: claimCwd || process.cwd(),
			updated: new Date().toISOString(),
			phase: state.phase,
			...(st ? { stage: st.current, stages: st.stages.length } : {}),
			steps: (state.checklist ?? []).map((i) => ({ id: i.id, text: i.text.slice(0, 80), done: i.done })),
			judgeRound: state.judgeRounds,
			autopilot: autopilotOn(),
			...(state.waiting ? { waiting: state.waiting.reason.slice(0, 120) } : {}),
			runs: view.runs.filter((r) => r.status === "running").slice(0, 6).map((r) => ({ role: r.role, label: r.label.slice(0, 80), activity: (r.activity ?? "").slice(0, 80) })),
			events: [],
		};
	}
	function stopLiveTimer(): void {
		if (liveTimer) clearInterval(liveTimer);
		liveTimer = undefined;
	}
	/** Ends the snapshot of a flow this session no longer holds in `state`: no wait, no runs, a final event. */
	function liveFinish(dir: string, flowId: string, text: string): void {
		try {
			const cur = readLive(dir, flowId);
			if (!cur) return;
			cur.waiting = undefined;
			cur.runs = [];
			cur.updated = new Date().toISOString();
			cur.events = [...cur.events, { at: cur.updated, text: `finished: ${text}` }].slice(-20);
			fs.writeFileSync(path.join(dir, flowId, "live.json"), `${JSON.stringify(cur, null, 2)}
`);
		} catch {}
	}
	function liveTick(extra?: string): void {
		// Once the flow is finished only the final write (with `extra`) goes through.
		if (state.planDoc?.finished && !extra) {
			stopLiveTimer();
			return;
		}
		try {
			const snap = liveSnapshot();
			if (!snap) {
				stopLiveTimer();
				return;
			}
			if (liveFlow !== snap.flowId) {
				liveFlow = snap.flowId;
				liveLast = undefined;
				liveLastJson = "";
				liveEventLog = [];
			}
			const now = Date.now();
			const at = new Date(now).toISOString();
			const texts = [...liveEvents(liveLast, snap), ...(extra ? [extra] : [])];
			const log = [...liveEventLog, ...texts.map((text) => ({ at, text }))].slice(-20);
			snap.events = log;
			const key = JSON.stringify({ ...snap, updated: "" });
			if (key === liveLastJson && now - liveLastWrite < 60_000) return;
			const dir = planDirs.get(snap.flowId)!;
			const folder = path.join(dir, snap.flowId);
			fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(path.join(folder, "live.json"), `${JSON.stringify(snap, null, 2)}\n`);
			liveLast = snap;
			liveLastJson = key;
			liveLastWrite = now;
			liveEventLog = log;
			if (!liveRegistered.has(dir)) {
				liveRegistered.add(dir);
				addToRegistry(path.join(getAgentDir(), "workflow", "board.json"), dir, new Date());
			}
			if (!liveTimer && !state.planDoc?.finished) {
				liveTimer = setInterval(() => liveTick(), 5_000);
				liveTimer.unref?.();
			}
		} catch {}
	}

	async function writePlan(ctx: ExtensionContext, snap: PlanSnap): Promise<void> {
		claimCwd = ctx.cwd.replace(/\\/g, "/");
		const found = [...(await flowRepos(ctx)).map((r) => r.root), ...(await Promise.all(snap.touched.map((t) => gitRoot(t))))];
		const roots = uniqueRoots([...snap.roots, ...found.filter((r): r is string => !!r)]);
		const dir = planDirs.get(snap.flowId) ?? (await planDirFor(roots[0] ?? null));
		const infos = await Promise.all(roots.map((r) => repoInfo(gitEnv, r)));
		const status: PlanStatus = {
			v: 1,
			flowId: snap.flowId,
			rev: snap.rev,
			updated: new Date().toISOString(),
			title: planTitle(snap.plan),
			...(snap.stage ? { stage: snap.stage } : {}),
			...(snap.delivery ? { delivery: snap.delivery } : {}),
			...(snap.kind ? { kind: snap.kind } : {}),
			done: (snap.checklist ?? []).filter((i) => i.done).map((i) => i.id),
			...(snap.finished ? { finished: snap.finished } : {}),
			...(snap.waiting ? { waiting: snap.waiting } : {}),
			...(snap.checkpoints?.length ? { checkpoints: snap.checkpoints } : {}),
			repos: infos.map((info, i) => ({ ...info, primary: i === 0 })),
		};
		const planMd = renderPlanFile(snap.flowId, snap.plan, snap.checklist, snap.finished, snap.waiting?.reason);
		writeLocal(dir, snap.flowId, planMd, status);
		planDirs.set(snap.flowId, dir);
		planLast.set(snap.flowId, { dir, status });
		if (snap.finished) {
			dropClaim(dir, snap.flowId);
			if (claimedFlow === snap.flowId) stopClaimTimer();
			if (state.planDoc?.flowId === snap.flowId) {
				liveTick(`finished: ${snap.finished.text}`);
				stopLiveTimer();
			} else liveFinish(dir, snap.flowId, snap.finished.text);
		} else if (state.planDoc?.flowId === snap.flowId) {
			claimedFlow = snap.flowId;
			refreshClaim();
			claimTimer ??= setInterval(refreshClaim, 60_000);
			claimTimer.unref?.();
		}
		metricsFlushAll();
		const live = state.planDoc?.flowId === snap.flowId ? state.planDoc : undefined;
		if (live && roots.join("\n") !== live.roots.join("\n")) {
			live.roots = roots;
			persist();
		}
		const revs = await mapLimit(roots, 3, (root) => syncRoot(ctx, root, snap, planMd, status));
		const top = Math.max(snap.rev, ...revs);
		if (live && top > live.rev) {
			live.rev = top;
			persist();
		}
		if (snap.finished && cfg.plans.keepCount === 0) deleteLocal(dir, snap.flowId);
	}

	function planWarn(ctx: ExtensionContext, flowId: string, text: string): void {
		if (planWarned.has(flowId)) return;
		planWarned.add(flowId);
		ctx.ui.notify(`workflow: ${text}`, "warning");
	}

	/** Whether plan refs of a repo with this remote URL may be pushed. */
	function syncAllowed(url: string): boolean {
		const u = url.toLowerCase();
		return cfg.plans.sync === "remote" && !cfg.plans.localOnly.some((s) => s && u.includes(s.toLowerCase()));
	}

	/** Commits the plan into the repo's plan ref and pushes it. Returns the highest rev written (a rejected push is redone on top of the remote's commit). Never throws. */
	async function syncRoot(ctx: ExtensionContext, root: string, snap: PlanSnap, planMd: string, status0: PlanStatus): Promise<number> {
		let status = status0;
		try {
			const remote = await remoteOf(gitEnv, root);
			const push = !!remote && syncAllowed(remote.url);
			if (snap.finished && cfg.plans.keepCount === 0) {
				await deleteRef(gitEnv, root, snap.flowId, push ? remote?.name : undefined);
				return 0;
			}
			const cur = await refRev(gitEnv, root, snap.flowId);
			if (cur !== null) {
				if (snap.retry) {
					if (cur > status.rev) {
						planWarn(ctx, snap.flowId, "this flow moved on in another device; use /flow resume");
						return cur;
					}
				} else if (cur >= status.rev) status = { ...status, rev: cur + 1 };
			}
			if (!(await commitRef(gitEnv, root, snap.flowId, planMd, `${JSON.stringify(status, null, 2)}\n`))) {
				planWarn(ctx, snap.flowId, `could not save the plan ref in ${root}`);
				return 0;
			}
			if (!push || !remote) return status.rev;
			const first = await pushRef(gitEnv, root, remote.name, snap.flowId);
			if (first === "ok") return status.rev;
			if (first === "failed") {
				planWarn(ctx, snap.flowId, `could not push the plan to ${remote.url} (it stays local; plans.sync "local" or plans.localOnly turns pushing off)`);
				return status.rev;
			}
			const theirs = (await fetchMirror(gitEnv, root, remote.name)) ? (await listRefs(gitEnv, root, "remote-plans")).find((e) => e.flowId === snap.flowId) : undefined;
			if (!theirs) {
				planWarn(ctx, snap.flowId, `could not push the plan to ${remote.url}: it changed there`);
				return status.rev;
			}
			const rev = Math.max(status.rev, theirs.status?.rev ?? 0) + 1;
			const next: PlanStatus = { ...status, rev };
			const commit = await commitRef(gitEnv, root, snap.flowId, planMd, `${JSON.stringify(next, null, 2)}\n`, theirs.commit);
			if (!commit || (await pushRef(gitEnv, root, remote.name, snap.flowId)) !== "ok") planWarn(ctx, snap.flowId, `could not push the plan to ${remote.url}: it changed there`);
			return rev;
		} catch (e) {
			planWarn(ctx, snap.flowId, `plan sync failed in ${root}: ${(e as Error).message}`);
			return 0;
		}
	}

	/** A point where the plan file is rewritten: approval, an amendment, a stage end, the flow's end. Runs in the background, in order; `bump: false` only restores the file. */
	/** The wait and checkpoints as they go into the plan's status. */
	function waitSnapshot(): Pick<PlanSnap, "waiting" | "checkpoints"> {
		const w = state.waiting;
		return {
			...(w ? { waiting: { reason: w.reason, ...(w.check ? { check: w.check } : {}), since: w.since, planned: w.planned, ...(w.atStageStart ? { atStageStart: true } : {}), ...(w.held ? { held: w.held } : {}) } } : {}),
			...(state.checkpoints?.length ? { checkpoints: state.checkpoints.map((c) => ({ ...(c.step ? { step: c.step } : {}), ...(c.stage ? { stage: c.stage } : {}), text: c.text, ok: c.ok })) } : {}),
		};
	}

	function planMilestone(ctx: ExtensionContext | undefined, finished?: Finished, bump = true): void {
		const plan = state.approvedPlan;
		if (!plan) return;
		const doc = (state.planDoc ??= { flowId: newFlowId(planTitle(plan), new Date(), randomUUID().slice(0, 4)), rev: 0, roots: [] });
		if (bump) doc.rev++;
		if (finished) doc.finished = finished;
		const snap: PlanSnap = {
			flowId: doc.flowId,
			rev: doc.rev,
			roots: [...doc.roots],
			plan,
			checklist: state.checklist?.map((i) => ({ ...i })),
			stage: state.stage,
			delivery: state.delivery,
			...(state.testFlow ? { kind: "test" as const } : {}),
			touched: [...(state.touchedRepos ?? [])],
			finished: doc.finished,
			...waitSnapshot(),
			retry: !bump,
		};
		const c = ctx ?? lastCtx;
		if (!c) return;
		planChain = planChain
			.then(() => writePlan(c, snap))
			.catch((e) => {
				if (planWarned.has(snap.flowId)) return;
				planWarned.add(snap.flowId);
				c.ui.notify(`workflow: could not save the plan file: ${(e as Error).message}`, "warning");
			});
	}

	/** Rewrites the current plan file from state (ticks changed). No rev, no git. Returns the path, or undefined when nothing was written before. */
	function rewritePlanFile(): string | undefined {
		const doc = state.planDoc;
		const last = doc && planLast.get(doc.flowId);
		if (!doc || !last || !state.approvedPlan) return undefined;
		try {
			const status: PlanStatus = { ...last.status, updated: new Date().toISOString(), done: (state.checklist ?? []).filter((i) => i.done).map((i) => i.id) };
			delete status.waiting;
			delete status.checkpoints;
			Object.assign(status, waitSnapshot());
			const file = writeLocal(last.dir, doc.flowId, renderPlanFile(doc.flowId, state.approvedPlan, state.checklist, doc.finished, state.waiting?.reason), status);
			last.status = status;
			return file;
		} catch {
			return undefined;
		}
	}

	/** The path of the plan file, rewritten from state first when it went missing; undefined when there is none yet. */
	function planFilePath(): string | undefined {
		const doc = state.planDoc;
		const dir = doc && planDirs.get(doc.flowId);
		if (!doc || !dir || !state.approvedPlan) return undefined;
		const file = path.join(dir, doc.flowId, "plan.md");
		if (fs.existsSync(file)) return file;
		if (doc.finished && cfg.plans.keepCount === 0) return undefined;
		return rewritePlanFile();
	}

	/** Deletes plans past the retention limits in this flow's plan folders, and restores the active flow's file. */
	async function planHousekeeping(ctx: ExtensionContext): Promise<void> {
		try {
			const repos = await flowRepos(ctx);
			const dirs = new Set<string>([await planDirFor(null)]);
			for (const r of repos) dirs.add(await planDirFor(r.root));
			const active = state.planDoc && !state.planDoc.finished ? state.planDoc.flowId : undefined;
			for (const dir of dirs) {
				const entries = readLocalStatuses(dir).map((e) => {
					const t = e.status ? Date.parse(e.status.updated) : NaN;
					return { flowId: e.flowId, updated: Number.isFinite(t) ? t : e.mtime, finished: e.status ? !!e.status.finished : true };
				});
				for (const id of pruneIds(entries, { keepDays: cfg.plans.keepDays, keepCount: cfg.plans.keepCount, now: Date.now(), activeId: active })) deleteLocal(dir, id);
			}
			planChain = planChain.then(() => mapLimit(repos, 3, (r) => pruneRefs(r.root, active))).then(() => {}, () => {});
			await planChain;
			if (active && state.approvedPlan) planMilestone(ctx, undefined, false);
		} catch {}
	}

	/** The plan refs of one repo: fetch the remote's, keep the higher revs, delete those past retention (also on the remote). */
	async function pruneRefs(root: string, activeId: string | undefined): Promise<void> {
		try {
			const remote = await remoteOf(gitEnv, root);
			const sync = !!remote && syncAllowed(remote.url);
			if (remote && sync && (await fetchMirror(gitEnv, root, remote.name))) {
				for (const e of await listRefs(gitEnv, root, "remote-plans")) await adoptHigher(gitEnv, root, e.flowId);
			}
			const entries = (await listRefs(gitEnv, root, "plans")).map((e) => {
				const t = e.status ? Date.parse(e.status.updated) : NaN;
				return { flowId: e.flowId, updated: Number.isFinite(t) ? t : e.date, finished: e.status ? !!e.status.finished : true };
			});
			for (const id of pruneIds(entries, { keepDays: cfg.plans.keepDays, keepCount: cfg.plans.keepCount, now: Date.now(), activeId })) {
				await deleteRef(gitEnv, root, id, sync ? remote?.name : undefined);
			}
		} catch {}
	}

	const isDir = (p: string): boolean => {
		try {
			return fs.statSync(p).isDirectory();
		} catch {
			return false;
		}
	};

	/** `/flow resume`: rebuilds an unfinished flow from its plan ref, found in the working folder's repo or an added folder. */
	async function resumeFlow(ctx: ExtensionContext, wanted: string | undefined): Promise<void> {
		const notify = (text: string, level: "info" | "warning" = "warning") => ctx.ui.notify(`workflow: ${text}`, level);
		const busy = (state.phase === "execute" || state.phase === "test") && state.planDoc && !state.planDoc.finished ? state.planDoc.flowId : undefined;
		if (busy && (!wanted || !busy.startsWith(wanted))) {
			notify(`a flow is already running (${busy}); finish or leave it before resuming another`);
			return;
		}
		const cwdRoot = await gitRoot(ctx.cwd);
		if (!cwdRoot) {
			notify("the working folder is not in a git repo, so there is no plan to resume");
			return;
		}
		const searchRoots: string[] = [cwdRoot];
		for (const f of existingFolders()) {
			const r = await gitRoot(f);
			if (r && !searchRoots.some((s) => repoKey(s) === repoKey(r))) searchRoots.push(r);
		}
		const found = new Map<string, { entry: RefEntry; root: string }>();
		planChain = planChain
			.then(async () => {
				for (const root of searchRoots) {
					const remote = await remoteOf(gitEnv, root);
					if (remote && (await fetchMirror(gitEnv, root, remote.name))) {
						for (const e of await listRefs(gitEnv, root, "remote-plans")) await adoptHigher(gitEnv, root, e.flowId);
					}
				}
			})
			.then(() => {}, () => {});
		await planChain;
		for (const root of searchRoots) {
			for (const e of await listRefs(gitEnv, root, "plans")) {
				if (!e.status || e.status.finished) continue;
				const prev = found.get(e.flowId);
				if (!prev || (prev.entry.status?.rev ?? 0) < e.status.rev) found.set(e.flowId, { entry: e, root });
			}
		}
		let candidates = [...found.values()].sort((a, b) => Date.parse(b.entry.status?.updated ?? "") - Date.parse(a.entry.status?.updated ?? ""));
		if (wanted) candidates = candidates.filter((c) => c.entry.flowId.startsWith(wanted));
		if (!candidates.length) {
			notify(wanted ? `no unfinished plan matches "${wanted}" in this repo or the added folders` : "no unfinished plan found in this repo or the added folders");
			return;
		}
		// S2: another live session may be running the flow.
		const claims = await Promise.all(
			candidates.map(async (c) => {
				const claim = readClaim(await planDirFor(c.root), c.entry.flowId);
				return claim && claim.pid !== process.pid ? claim : null;
			}),
		);
		const liveClaim = (i: number) => (claims[i] && claimLive(claims[i], Date.now(), os.hostname(), pidAlive) ? claims[i] : null);
		let pickIdx = 0;
		if (candidates.length > 1) {
			const labels = candidates.map((c, i) => {
				const live = liveClaim(i);
				return `${c.entry.status?.title} \u2014 ${c.entry.status?.updated.slice(0, 16).replace("T", " ")}${c.entry.status?.stage ? `, stage ${c.entry.status.stage}` : ""}${c.entry.status?.kind === "test" ? " (test flow)" : ""} (${c.entry.flowId})${live ? ` \u2014 running in ${live.cwd} (pid ${live.pid})` : ""}`;
			});
			const chosen = await ctx.ui.select("Resume which flow?", labels);
			const i = chosen ? labels.indexOf(chosen) : -1;
			if (i < 0) return;
			pickIdx = i;
		}
		const pick = candidates[pickIdx];
		const heldBy = liveClaim(pickIdx);
		if (heldBy) {
			notify(`${pick.entry.status?.title} is running in ${heldBy.cwd} (pid ${heldBy.pid}); finish or leave it there first`);
			return;
		}
		if (claims[pickIdx]) notify(`took over a stale claim from pid ${claims[pickIdx]!.pid}`, "info");
		if (busy && busy !== pick.entry.flowId) {
			notify(`a flow is already running (${busy}); finish or leave it before resuming another`);
			return;
		}
		const status = pick.entry.status;
		if (status?.kind === "test") {
			notify("test flows can't be resumed; start a new one with /flow test");
			return;
		}
		const md = await readPlanMd(gitEnv, pick.root, pick.entry.commit);
		if (!status || !md) {
			notify("the plan ref is unreadable");
			return;
		}
		const plan = splitPlanFile(md);

		const mine = new Map<string, string>();
		for (const root of searchRoots) {
			const remote = await remoteOf(gitEnv, root);
			if (remote) mine.set(remote.url, root);
		}
		const parent = path.dirname(cwdRoot);
		let siblings: string[] | undefined;
		const findSibling = async (url: string): Promise<string | undefined> => {
			if (!siblings) {
				try {
					siblings = fs.readdirSync(parent).slice(0, 200).map((n) => path.join(parent, n)).filter((d) => fs.existsSync(path.join(d, ".git")));
				} catch {
					siblings = [];
				}
			}
			for (const d of siblings) {
				const remote = await remoteOf(gitEnv, d);
				if (remote?.url === url) return (await gitRoot(d)) ?? undefined;
			}
			return undefined;
		};
		const roots: { root: string; branch?: string; remote?: string }[] = [];
		for (const r of status.repos) {
			let root = r.remote ? mine.get(r.remote) : undefined;
			if (!root && r.remote) root = await findSibling(r.remote);
			if (!root) {
				const label = r.remote ?? "a repo without a remote";
				const answer = r.remote ? (await ctx.ui.input(`Where is ${label} on this device?`, "path to the repo, empty to skip"))?.trim() : "";
				const abs = answer ? path.resolve(ctx.cwd, answer).replace(/\\/g, "/") : "";
				root = abs && isDir(abs) ? ((await gitRoot(abs)) ?? undefined) : undefined;
				if (!root) {
					notify(`${label}: not found on this device, skipped`);
					continue;
				}
			}
			if (!roots.some((x) => repoKey(x.root) === repoKey(root))) roots.push({ root, branch: r.branch, remote: r.remote });
		}
		if (!roots.some((x) => repoKey(x.root) === repoKey(cwdRoot))) roots.unshift({ root: cwdRoot });

		for (const r of roots) {
			if (!r.branch) continue;
			if (r.branch.startsWith("-") || r.branch.includes("@{") || (await gitEnv(r.root, ["check-ref-format", "--branch", r.branch])).code !== 0) {
				notify(`${r.root}: the plan names an invalid branch, left alone`);
				continue;
			}
			const info = await repoInfo(gitEnv, r.root);
			const dirty = await gitEnv(r.root, ["status", "--porcelain"]);
			if (dirty.code !== 0 || dirty.stdout.trim()) {
				notify(`${r.root} has uncommitted changes; it stays on ${info.branch ?? "a detached HEAD"} (the flow used ${r.branch})`);
				continue;
			}
			const remote = await remoteOf(gitEnv, r.root);
			const fetched = remote ? (await gitEnv(r.root, ["fetch", "--quiet", remote.name, `+refs/heads/${r.branch}:refs/remotes/${remote.name}/${r.branch}`])).code === 0 : false;
			const stuck = () => notify(`${r.root}: could not bring ${r.branch} up to ${remote?.name ?? "the remote"}/${r.branch}; check it by hand`);
			if (info.branch !== r.branch && (await gitEnv(r.root, ["switch", "--quiet", r.branch])).code !== 0) {
				stuck();
				continue;
			}
			if (remote && fetched && (await gitEnv(r.root, ["merge", "--ff-only", "--quiet", `${remote.name}/${r.branch}`])).code !== 0) stuck();
		}

		await setPhase(ctx, "execute");
		const folders = [...(state.folders ?? [])];
		let added = 0;
		for (const r of roots) {
			const abs = path.resolve(r.root).replace(/\\/g, "/");
			if (repoKey(abs) === repoKey(ctx.cwd) || repoKey(abs) === repoKey(cwdRoot) || folders.some((f) => repoKey(f) === repoKey(abs))) continue;
			folders.push(abs);
			added++;
		}
		state.folders = folders;
		state.approvedPlan = plan;
		state.delivery = isDelivery(status.delivery) ? status.delivery : defaultDelivery();
		state.stage = status.stage;
		state.stageOutcomes = undefined;
		state.stageJudged = undefined;
		state.checklist = parseChecklist(plan).map((i) => ({ ...i, done: status.done.includes(i.id) }));
		if (!state.checklist.length) state.checklist = undefined;
		state.checkpoints = status.checkpoints?.map((c) => ({ ...c }));
		state.waiting = undefined;
		if (status.waiting) {
			// Older status files lack the held text and the flags: rebuild the plain stage start for a stage that declares this wait.
			const resumedStages = state.stage ? parseStages(plan) : [];
			const after = state.stage ? resumedStages[state.stage - 1]?.after : undefined;
			const atStart = status.waiting.atStageStart ?? (!!after && after.reason === status.waiting.reason);
			const held = status.waiting.held ?? (atStart && state.stage ? stageStart(resumedStages, state.stage, state.delivery ?? defaultDelivery()) : undefined);
			state.waiting = {
				reason: status.waiting.reason,
				...(status.waiting.check ? { check: status.waiting.check } : {}),
				since: status.waiting.since,
				stage: state.stage,
				planned: status.waiting.planned ?? true,
				...(atStart ? { atStageStart: true } : {}),
				...(held ? { held } : {}),
			};
		}
		state.planDoc = { flowId: status.flowId, rev: status.rev, roots: roots.map((r) => r.root) };
		persist();
		publishFolders(ctx);
		updateStatus(ctx);
		planMilestone(ctx);
		startWaitTimer();
		await planChain;
		pi.sendMessage(
			{ customType: "workflow-resume-plan", content: `Resumed on this device: check \`git status\` and the branch in each repo, then continue with the open steps.\n\n${planCardText()}`, display: true },
			{ triggerTurn: false },
		);
		notify(`resumed "${status.title}"${status.stage ? ` at stage ${status.stage}` : ""}; send a message to continue${added ? ` (reloading to add ${added} folder${added === 1 ? "" : "s"})` : ""}`, "info");
		if (added) {
			await ctx.waitForIdle();
			await ctx.reload();
		}
	}

	/** A very long plan loses its middle, never its amendments. */
	function trimPlan(plan: string): string {
		if (plan.length <= MAX_PLAN_CHARS) return plan;
		return `${plan.slice(0, 45_000)}\n\n[... middle of the plan omitted ...]\n\n${plan.slice(-15_000)}`;
	}

	/** D4: a knowledge-only judge run, when the judge skipped its knowledge step. */
	async function knowledgePass(
		ctx: ExtensionContext,
		diff: Diff,
		findings: string,
		server: string,
		files: string[],
		signal?: AbortSignal,
		onChange?: (run: RunView) => void,
	): Promise<{ text?: string; status: { status: "checked" } | { status: "unavailable"; reason: string }; usage: ReturnType<typeof emptyUsage> }> {
		const { result, run } = await runRole(
			"judge",
			"knowledge check",
			{
				systemPrompts: [
					...(diff.multi ? [prompts.repoNote(repoRoots(diff))] : []),
					prompts.JUDGE_KNOWLEDGE_ONLY,
					prompts.judgeKnowledge(server, false, files),
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
		const s = judgeKnowledge(result.toolCalls, result.text, files, server);
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
		const prevChecked = plan.kind === "recheck" && state.lastKnowledge?.status === "checked" && state.lastKnowledge.hash === plan.prev.hash;
		const { files: knowledgeFiles, scoped } = plan.kind === "recheck" ? recheckKnowledgeFiles(prevChecked, plan.changed, diff.checkNames) : { files: diff.checkNames, scoped: false };
		const max = cfg.judge.maxDiffChars;
		const testJudge = state.testFlow ? prompts.JUDGE_TEST : "";
		const systemPrompts = recheck
			? [
					prompts.JUDGE + testJudge,
					prompts.JUDGE_RECHECK,
					`## Approved plan\n\n${planForJudge()}`,
					`## Findings of the last round (${plan.prev.verdict})\n\n${plan.prev.text}`,
					`## Every file in the whole change (${diff.names.length})\n\n${diff.names.join("\n")}`,
					`## Changes since the last round\n\n${plan.delta.length > max ? `${plan.delta.slice(0, max)}\n\n[truncated; read the files for the rest]` : plan.delta}`,
				]
			: [prompts.JUDGE + testJudge, `## Approved plan\n\n${planForJudge()}`, `## Diff under review (${diff.files} file(s)${diff.truncated ? ", truncated" : ""})\n\n${diff.text}`];
		if (server) systemPrompts.splice(recheck ? 2 : 1, 0, prompts.judgeKnowledge(server, recheck, knowledgeFiles, scoped));
		if (diff.multi) systemPrompts.splice(1, 0, prompts.repoNote(repoRoots(diff)));
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
			view.stage = phaseStage();
			return { verdict: "ERROR", text: `judge failed: ${result.error}`, hash: diff.hash, usage: result.usage, run };
		}
		let text = result.text;
		let usage = result.usage;
		let knowledge: LastKnowledge | undefined;
		if (server) {
			let status: KnowledgeStatus = judgeKnowledge(result.toolCalls, text, knowledgeFiles, server);
			if (status.status === "skipped") {
				// The fallback pass checks the whole change: it cannot carry over the last round's notes.
				const pass = await knowledgePass(ctx, diff, text, server, diff.checkNames, signal, onChange);
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
		view.stage = phaseStage();
		state.lastJudge = plan.snaps ? { hash: diff.hash, repos: plan.snaps, base: diff.base, verdict, text } : undefined;
		if (state.phase === "execute") state.flowFindings = recordFindings(state.flowFindings, state.stage, text);
		state.lastKnowledge = knowledge;
		persist();
		return { verdict, text, hash: diff.hash, usage, run };
	}

	// ----------------------------------------------------------------------
	// Tools
	// ----------------------------------------------------------------------

	// ----------------------------------------------------------------------
	// Test flow
	// ----------------------------------------------------------------------

	/** `git status --porcelain` lines of every repo of the flow, by repo key. */
	async function porcelain(ctx: ExtensionContext): Promise<Record<string, string[]>> {
		const out: Record<string, string[]> = {};
		for (const r of await flowRepos(ctx)) {
			const g = await git(r.root, "status", "--porcelain");
			const lines = g.code === 0 ? g.stdout.split(/\r?\n/).filter(Boolean) : [];
			// The hash tells a file that changed again from one that stayed as it was.
			out[repoKey(r.root)] = await mapLimit(lines, 8, async (l) => {
				const h = await git(r.root, "hash-object", "--", l.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, ""));
				return h.code === 0 ? `${l}\t#${h.stdout.trim()}` : l;
			});
		}
		return out;
	}

	/** Entries that appeared in the repos since `before`, as `repo: line`. */
	async function newPorcelain(ctx: ExtensionContext, before: Record<string, string[]> | undefined): Promise<string[]> {
		const now = await porcelain(ctx);
		const out: string[] = [];
		for (const [key, lines] of Object.entries(now)) {
			const had = new Set(before?.[key] ?? []);
			for (const l of lines) if (!had.has(l)) out.push(`${path.basename(key)}: ${l.replace(/\t#[0-9a-f]+$/, "")}`);
		}
		return out;
	}

	/** Starts a test flow for `scope` in the test phase (the caller has switched to it). Returns false when a flow is already active. */
	async function startTestFlow(ctx: ExtensionContext, scope: string): Promise<boolean> {
		if (state.testFlow) return false;
		state.testFlow = newTestFlow(scope, cfg.test.maxRounds, await porcelain(ctx));
		state.approvedPlan = testPlan(state.testFlow);
		state.checklist = undefined;
		state.planDoc = undefined;
		state.flowFindings = undefined;
		state.flowSummarized = undefined;
		state.delivery = cfg.test.delivery;
		state.planFlaw = "auto";
		refreshChecklist();
		planMilestone(ctx);
		persist();
		updateStatus(ctx);
		return true;
	}

	/** One gate for all test_run calls of this session: a resource is used by one runner at a time, and at most test.concurrency run at once. */
	const runnerSlots = runnerGate(() => cfg.test.concurrency);

	/** The folder for one round's runner logs and records: next to the plan file, else in the temp folder. */
	function runsDir(round: number): string {
		const plan = planFilePath();
		const base = plan ? path.dirname(plan) : path.join(os.tmpdir(), "pi-test-runs", state.planDoc?.flowId ?? `flow-${process.pid}`);
		const dir = path.join(base, "runs", String(round));
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	const reportRequest = (problems: string[]) => `Your report is not valid:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nEnd with the test report in the required format.`;

	/** The end of a supervisor turn in the test phase: check the report, record it, and end the flow. */
	async function onTestEnd(ctx: ExtensionContext, last: AgentMessage | undefined): Promise<void> {
		const tf = state.testFlow;
		if (!tf || turnAborted) return;
		if (skipJudge(last)) {
			const choice = await askUser(ctx, "The test supervisor's last reply ended in an error", ["Retry", "Stop"]);
			if (choice === "Retry") {
				pi.sendMessage({ customType: "workflow-retry", content: "Your last reply ended in an error. Continue the test round where you stopped.", display: true }, { triggerTurn: true, deliverAs: "followUp" });
			} else {
				ctx.ui.notify("workflow: stopped: the supervisor's reply failed", "warning");
				summarizeFlow("stopped: the supervisor's reply failed", false);
				state.testFlow = undefined;
				await endFlow(ctx);
			}
			return;
		}
		const text = assistantText(last).trim();
		const report = parseTestReport(text, { nextId: tf.nextId, known: Object.keys(tf.items), mustReport: tf.lastFixIds ?? [] });
		if (!report || report.problems.length) {
			const problems = report ? report.problems : ["the reply has no '## Test report: <scope>' heading and VERDICT line"];
			if (!tf.nudged) {
				tf.nudged = true;
				persist();
				pi.sendMessage({ customType: "workflow-test-report", content: reportRequest(problems), display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			const choice = await askUser(ctx, `The test report is still not valid (${problems[0]})`, ["Retry", "Stop"]);
			if (choice === "Retry") {
				pi.sendMessage({ customType: "workflow-test-report", content: reportRequest(problems), display: true }, { triggerTurn: true, deliverAs: "followUp" });
			} else {
				summarizeFlow("stopped: no valid test report", false);
				state.testFlow = undefined;
				await endFlow(ctx);
			}
			return;
		}
		const flow = recordReport(tf, report, cfg.test.refails);
		flow.strays = [...(tf.strays ?? []), ...(await newPorcelain(ctx, tf.snapshot))];
		state.testFlow = flow;
		if (flow.strays.length) ctx.ui.notify(`workflow: files changed during testing: ${flow.strays.join("; ")}`, "warning");
		persist();
		await afterTestRound(ctx);
	}

	/** Steps 4-8 of the end of a test round: fix, ask, or finish. */
	async function afterTestRound(ctx: ExtensionContext): Promise<void> {
		const flow = state.testFlow;
		if (!flow) return;
		const next = nextAction(flow, cfg.test);
		if (next === "fix") return startFixRound(ctx);
		if (next === "ask") return askBatch(ctx);
		if (next === "limit") {
			const more = `Run ${cfg.test.maxRounds} more fix rounds`;
			const choice = await askUser(ctx, `Fix round limit reached with ${openBugs(flow).length} open bug(s)`, [more, "Stop"]);
			if (choice === more) {
				state.testFlow = { ...normalize(flow), fixBudget: normalize(flow).fixBudget + cfg.test.maxRounds };
				return startFixRound(ctx);
			}
		}
		await finishTestFlow(ctx);
	}

	/** Ends the flow with the outcome line; the plan is regenerated so the record shows the last state. */
	async function finishTestFlow(ctx: ExtensionContext): Promise<void> {
		const flow = state.testFlow;
		if (!flow) return;
		const outcome = testOutcome(flow);
		state.approvedPlan = testPlan(flow, amendmentTail(state.approvedPlan));
		refreshChecklist();
		planMilestone(ctx);
		summarizeFlow(outcome.text, outcome.ok);
		await endFlow(ctx);
	}

	/** Moves the main session between the test and execute phases of a running test flow, keeping the flow's plan and state. */
	async function switchRoundPhase(ctx: ExtensionContext, phase: "test" | "execute"): Promise<void> {
		if (state.phase !== phase) {
			if (state.phase === "test") restorePlanTools();
			if (phase === "test") blockPlanTools("test");
			state.phase = phase;
		}
		state.escalated = false;
		state.judgeRounds = 0;
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.commitPending = undefined;
		state.finalizing = undefined;
		state.pendingPlanFlaw = undefined;
		state.stageJudged = undefined;
		if (state.passedDiff) markPassSummarized(state.passedDiff); // a leftover diff from the round before is not this round's
		state.lastJudge = undefined; // a new round gets a full review, not a re-review of the last one
		planReady = false;
		planProposed = false;
		consecutiveErrors = 0;
		await applyRole(ctx, phase);
		persist();
		updateStatus(ctx);
	}

	/** Starts a fix round for the open bugs: the plan is regenerated and the execute model gets the steps. */
	async function startFixRound(ctx: ExtensionContext): Promise<void> {
		let flow = normalize(state.testFlow!);
		const ids = openBugs(flow);
		const strays = flow.strays ?? [];
		flow = { ...flow, fixRounds: flow.fixRounds + 1, fixBudget: Math.max(0, flow.fixBudget - 1), lastFixIds: ids, strays: [], nudged: undefined };
		const escalating = !!flow.escalateNext;
		flow.escalateNext = false;
		state.testFlow = flow;
		state.approvedPlan = testPlan(flow, amendmentTail(state.approvedPlan));
		state.checklist = undefined;
		refreshChecklist();
		planMilestone(ctx);
		await switchRoundPhase(ctx, "execute");
		if (escalating) await escalate(ctx);
		persist();
		ctx.ui.notify(`workflow: fix round ${flow.fixRounds}: ${ids.join(", ")}${escalating ? " (escalated)" : ""}`, "info");
		handover("workflow-test-fix", prompts.fixRoundMessage(ids, strays));
	}

	/** Starts the next test round (after a committed fix round or the user's answers). */
	async function startTestRound(ctx: ExtensionContext, why: "retest" | "answers"): Promise<void> {
		const flow = normalize(state.testFlow!);
		const fixed = flow.lastFixIds.map((id) => ({ id, repro: bodyField(flow.items[id]?.body ?? "", "Repro") }));
		state.testFlow = { ...flow, round: flow.round + 1, nudged: undefined, snapshot: await porcelain(ctx), answersSent: flow.answers.length };
		await switchRoundPhase(ctx, "test");
		handover("workflow-test-round", prompts.testRoundMessage({ why, fixed, ran: flow.ran, answers: flow.answers.slice(flow.answersSent ?? 0), nextId: flow.nextId }));
	}

	/** The pending questions, one prompt each; then retest, fix again or finish. Escape skips a question. */
	async function askBatch(ctx: ExtensionContext): Promise<void> {
		let flow = normalize(state.testFlow!);
		let answered = false as boolean;
		let stop = false;
		const take = (id: string, answer: string | undefined) => {
			if (answer === undefined || !answer.trim()) {
				flow = skipItem(flow, id);
				return;
			}
			flow = answerItem(flow, id, answer);
			answered = true;
		};
		for (const p of flow.pending) {
			if (stop) break;
			const body = flow.items[p.id]?.body ?? "";
			if (p.kind === "ask") {
				const other = "Other (type it)";
				const choice = await askUser(ctx, `${p.id}: ${bodyField(body, "Question") || p.text}`, [...askOptions(body), other, "Skip"]);
				if (choice === other) take(p.id, await ctx.ui.input(`${p.id}: your answer`, ""));
				else take(p.id, choice === "Skip" ? undefined : choice);
			} else if (p.kind === "manual") {
				take(p.id, await ctx.ui.input(`Do: ${bodyField(body, "Steps")}. Look for: ${bodyField(body, "Look for")}. What did you see? (empty skips)`, ""));
			} else if (p.kind === "blocked") {
				const choice = await askUser(ctx, `${p.id} was blocked: ${bodyField(body, "Needs") || p.text}`, ["It's available now", "Skip", "Stop the flow"]);
				if (choice === "Stop the flow") stop = true;
				else take(p.id, choice === "It's available now" ? choice : undefined);
			} else if (p.kind === "refail") {
				const n = flow.refails[p.id] ?? 0;
				const keep = "Keep trying (escalated)";
				const choice = await askUser(ctx, `${p.id} still fails after ${n} fix${n === 1 ? "" : "es"}: ${p.text}`, [keep, "Skip this bug", "Stop the flow"]);
				if (choice === keep) flow = { ...flow, refails: { ...flow.refails, [p.id]: Math.max(0, n - 1) }, escalateNext: true };
				else if (choice === "Stop the flow") stop = true;
				else flow = skipItem(flow, p.id);
			} else {
				const right = "The test's Expected is right";
				const choice = await askUser(ctx, `Plan question: ${p.text}`, [right, "The fix is right; the Expected is wrong", "Skip"]);
				take(p.id, choice === "Skip" ? undefined : choice);
			}
		}
		state.testFlow = { ...flow, pending: [] };
		persist();
		if (stop) return finishTestFlow(ctx);
		if (openBugs(state.testFlow).length) return afterTestRound(ctx);
		if (answered) return startTestRound(ctx, "answers");
		await finishTestFlow(ctx);
	}

	/** Queues the plan-flaw lines of a judge report as dispute questions for the end of the round. */
	function queueDisputes(report: string): void {
		if (!state.testFlow) return;
		const flow = normalize(state.testFlow);
		const fresh = pendingFromFlaws(planFlawLines(report)).filter((p) => !flow.pending.some((x) => x.kind === p.kind && x.text === p.text));
		state.testFlow = { ...flow, pending: [...flow.pending, ...fresh] };
		persist();
	}

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
			const roundDir = runsDir(state.testFlow?.round ?? 1);
			let dir = roundDir;
			try {
				dir = callDir(roundDir, fs, path.join);
			} catch {
				// keep the round folder
			}
			const roots = uniqueRoots([...(await flowRepos(ctx)).map((r) => r.root), ...existingFolders(), ctx.cwd]);
			const spec: RunnerGuardSpec = { roots, deny: cfg.test.runnerDeny, pathFlags: cfg.test.runnerPathFlags, pathEnv: cfg.test.runnerPathEnv };
			const runnerTools = cfg.test.runnerTools.filter((t) => !/^(edit|write)$/.test(t));
			const sections = await scheduleTasks(tasks, cfg.test.concurrency, async (task) => {
				const card = taskCard(task, ctx.cwd, dir);
				const { result, run } = await runnerSlots(task.resource, () =>
					runRole(
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

	// ----------------------------------------------------------------------
	// Wait points
	// ----------------------------------------------------------------------

	let waitTimer: ReturnType<typeof setInterval> | undefined;
	let waitTimerStart = 0;
	let waitChecking = false;

	function stopWaitTimer(): void {
		if (waitTimer) clearInterval(waitTimer);
		waitTimer = undefined;
	}

	/** Polls the wait's check every `wait.pollMs` while the session is idle. A wait without a check, or whose check already passed, is not polled. */
	function startWaitTimer(): void {
		stopWaitTimer();
		const w = state.waiting;
		if (!w?.check || w.checkPassed) return;
		waitTimerStart = Date.now();
		waitTimer = setInterval(() => void waitTick(), cfg.wait.pollMs);
		(waitTimer as { unref?: () => void }).unref?.();
	}

	/** pi's own bash (Git Bash on Windows), looked up once; a failed lookup is cached too. */
	let waitShell: { shell: string; args: string[] } | { error: string } | undefined;
	function resolveWaitShell(): { shell: string; args: string[] } | { error: string } {
		if (waitShell) return waitShell;
		try {
			const c = getShellConfig();
			waitShell = c.commandTransport === "stdin" ? { error: "no usable bash: only a WSL bash that needs stdin was found" } : { shell: c.shell, args: c.args };
		} catch (e) {
			waitShell = { error: `no usable bash: ${e instanceof Error ? e.message : String(e)}` };
		}
		return waitShell;
	}

	/** Runs a wait's check in pi's bash. Exit 0 passes; a failure or timeout is "not yet"; a check that cannot run is broken. */
	async function runWaitCheck(check: string): Promise<CheckVerdict> {
		const sh = resolveWaitShell();
		if ("error" in sh) return checkVerdict(sh, cfg.wait.checkTimeoutMs);
		try {
			const r = await pi.exec(sh.shell, [...sh.args, check], { cwd: lastCtx?.cwd, timeout: cfg.wait.checkTimeoutMs });
			return checkVerdict({ code: r.code, stderr: r.stderr ?? "", killed: !!r.killed }, cfg.wait.checkTimeoutMs);
		} catch (e) {
			return checkVerdict({ error: e instanceof Error ? e.message : String(e) }, cfg.wait.checkTimeoutMs);
		}
	}

	/** The wait is over: clears it and records the new state. */
	function clearWait(ctx: ExtensionContext): void {
		state.waiting = undefined;
		stopWaitTimer();
		persist();
		updateStatus(ctx);
		planMilestone(ctx);
	}

	async function waitTick(): Promise<void> {
		const w = state.waiting;
		const ctx = lastCtx;
		if (!w || !ctx || waitChecking || state.phase !== "execute") return;
		const elapsedMs = Date.now() - waitTimerStart;
		const idle = ctx.isIdle() && (!ctx.hasUI || ctx.ui.getEditorText().trim() === "");
		const d = pollDecision({ waiting: true, hasCheck: !!w.check && !w.checkPassed, idle, elapsedMs, maxMs: cfg.wait.maxMs });
		if (d === "hold") return;
		if (d === "stop") {
			stopWaitTimer();
			if (w.check && elapsedMs >= cfg.wait.maxMs) {
				ctx.ui.notify(`workflow: stopped polling "${w.check}" after ${Math.round(elapsedMs / 60_000)} min; your next message checks again`, "warning");
				notifyUser(ctx, `stopped waiting for "${w.check}" after ${Math.round(elapsedMs / 60_000)} min`);
			}
			return;
		}
		waitChecking = true;
		try {
			const verdict = await runWaitCheck(w.check as string);
			if (state.waiting !== w) return;
			if (verdict.status === "broken") {
				stopWaitTimer();
				ctx.ui.notify(`workflow: wait check can't run (${verdict.detail}): ${w.check}; fix it or send a message to continue`, "warning");
				notifyUser(ctx, `wait check can't run: ${verdict.detail}`);
				return;
			}
			if (verdict.status !== "pass") return;
			stopWaitTimer();
			if (cfg.wait.autoResume) {
				clearWait(ctx);
				const body = w.held ?? "Continue with the open steps of the plan.";
				pi.sendMessage({ customType: "workflow-wait", content: `${resumePrefix(w.reason, "passed")} ${body}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
			} else {
				w.checkPassed = true;
				persist();
				ctx.ui.notify(`workflow: "${w.check}" passed; send any message to continue`, "info");
				notifyUser(ctx, `"${w.check}" passed; send any message to continue`);
			}
		} finally {
			waitChecking = false;
		}
	}

	pi.registerTool({
		name: "wait_for_user",
		label: "Wait for user",
		description:
			"Pause the flow until a person has done something you cannot (publish a package, open the Unity Editor). Optional `check` is a read-only command that exits 0 once it is done; the workflow runs it once at once, then every few minutes, and resumes you by itself. Then end your turn. With autopilot on, the tool tells you what to do instead of pausing, unless `manual: true`. Name the plan step as `step` when the plan has a `Wait:` step; otherwise the wait is added to the plan as an amendment.",
		promptSnippet: "wait_for_user: pause the flow until a person did something; resumes by check or by their reply",
		parameters: Type.Object({
			reason: Type.String({ description: "What the person must do, in one line" }),
			check: Type.Optional(Type.String({ description: "A read-only command that exits 0 once it is done, e.g. git ls-remote --exit-code --tags origin <tag>. It runs once at once, then every few minutes" })),
			step: Type.Optional(Type.String({ description: "The plan's Wait step, e.g. S7" })),
			kind: Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("act")], { description: "approve: a person only reviews and agrees; act (default): a person must do something" })),
			manual: Type.Optional(Type.Boolean({ description: "Pause even when autopilot is on" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			const plan = state.approvedPlan;
			if (state.phase !== "execute" || !plan) return reply("wait_for_user works only while executing an approved plan. Nothing changed.");
			const reason = params.reason.trim();
			if (!reason) return reply("Give a reason: what the person must do. Nothing changed.");
			const check = params.check?.trim() || undefined;
			if (check) {
				const problem = readOnlyProblem(check);
				if (problem) return reply(`The check must be read-only (${problem}). Nothing changed.`);
			}
			if (check) {
				const first = await runWaitCheck(check);
				if (first.status === "pass") return reply(`The check passes already: "${reason}" is done. Tick the step with plan_check and continue in this turn. Nothing to wait for.`);
				if (first.status === "broken") return reply(`The check can't run (${first.detail}). Fix the check (it runs in bash from ${ctx.cwd}) and call wait_for_user again. Nothing changed.`);
			}
			const step = params.step?.trim().toUpperCase() || undefined;
			const planned = !!step && !!parseWaitStep(plan, step);
			if (autopilotOn() && !params.manual) {
				const kind = params.kind === "approve" ? "approve" : "act";
				state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${autopilotAmendment(nextAmendmentNumber(), { reason, step, kind })}\n`;
				refreshChecklist();
				persist();
				planMilestone(ctx);
				return reply(autopilotReply(kind, reason, check));
			}
			if (!planned) {
				state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${waitAmendment(nextAmendmentNumber(), { reason, step, check })}\n`;
				refreshChecklist();
			}
			state.waiting = { reason, ...(check ? { check } : {}), ...(step ? { step } : {}), stage: state.stage, since: new Date().toISOString(), planned };
			persist();
			updateStatus(ctx);
			planMilestone(ctx);
			startWaitTimer();
			return reply(`Waiting for: ${reason}. End your turn now; the workflow resumes you when ${check ? "the check passes" : "the user replies"}.`);
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "wait_for_user", "execute")}${theme.fg("accent", ` ${String(args.reason ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_check",
		label: "Plan check",
		description: "Tick the plan's steps you finished (their IDs, e.g. S3), or untick ones with `undone`. Keeps the checklist in step with your work; the judge still checks the diff.",
		promptSnippet: "plan_check: tick finished plan steps by ID (S1, S2, ...)",
		parameters: Type.Object({
			done: Type.Array(Type.String({ description: "Step ID, e.g. S3" }), { description: "Steps you finished" }),
			undone: Type.Optional(Type.Array(Type.String({ description: "Step ID, e.g. S3" }), { description: "Steps to untick again" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const list = state.checklist;
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (state.phase !== "execute" || !list?.length) return reply("No plan checklist is active (it exists only while executing a plan whose steps are numbered S1, S2, ...). Nothing changed.");
			const norm = (ids: string[] | undefined) => (ids ?? []).map((s) => s.trim().toUpperCase());
			const unknown: string[] = [];
			for (const [ids, value] of [[norm(params.done), true], [norm(params.undone), false]] as const) {
				for (const id of ids) {
					const item = list.find((i) => i.id === id);
					if (item) item.done = value;
					else unknown.push(id);
				}
			}
			persist();
			updateStatus(ctx);
			rewritePlanFile();
			const staged = currentStages();
			const open = list.filter((i) => !i.done && (!staged || i.stage === undefined || i.stage === staged.current));
			const done = list.filter((i) => i.done).length;
			const head = `${done} of ${list.length} steps done${unknown.length ? `; unknown IDs: ${unknown.join(", ")}` : ""}.`;
			const rest = open.length ? `Open${staged ? ` in stage ${staged.current}` : ""}:\n${open.map((i) => `- ${i.id} ${i.text}`).join("\n")}` : `No open steps${staged ? " in this stage" : ""}.`;
			return reply(`${head}\n${rest}`);
		},
		renderCall(args, theme) {
			const ids = [...((args.done ?? []) as string[]), ...((args.undone ?? []) as string[]).map((s) => `-${s}`)];
			return new Text(`${title(theme, "plan_check", "execute")}${theme.fg("accent", ` ${ids.join(", ")}`)}`, 0, 0);
		},
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
			"Adversarial review of the current uncommitted diff (plus untracked files) of every git repo in this flow (the working folder's, the /folders ones, and repos edited this flow) by a stronger model that assumes the change is wrong. Returns one line per finding and VERDICT: PASS or FAIL. Call it when the diff is ready; fix blocker and major findings and call it again. On a pass, end your turn: the workflow decides whether minor findings get a fix round. Rounds after the first review only the changes since the last round, with its findings. Do not commit before PASS.",
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
			const diff = await collectFlowDiff(ctx, params.base || "HEAD");
			if (!diff) throw new Error("no git work tree in this flow (working folder, /folders, or repos edited this flow); the judge reviews git diffs");
			if (state.phase === "execute" && currentStages()) {
				state.stageJudged = true;
				persist();
			}
			if (!diff.text) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const progress = toolProgress(onUpdate);
			const r = await judge(ctx, diff, params.focus, signal, progress.track, params.full === true, params.disputes);
			if (r.verdict === "ERROR") throw new Error(r.text);
			if (r.verdict === "FAIL") state.judgeRounds++;
			let text = r.text;
			const reminder = state.phase === "execute" ? openStepsReminder(state.checklist, currentStages()?.current) : undefined;
			if (reminder) text += `\n\n${reminder}`;
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

	/** The tag part of `deliver`: creates or moves a tag on the remote default branch, safely. A wait is returned for the caller to set. */
	async function deliverTag(ctx: ExtensionContext, t: { name: string; commit?: string; move: boolean; repo?: string }, planned: boolean): Promise<{ text: string; ok: boolean; wait?: string }> {
		const fail = (text: string) => ({ text: `tag ${t.name}: ${text}`, ok: false });
		const refs = await flowRepos(ctx);
		const want = t.repo?.trim();
		const ref = want ? refs.find((r) => r.root === want || path.basename(r.root) === want || repoKey(r.root) === repoKey(want)) : undefined;
		if (want && !ref) return fail(`no repo of this flow matches "${want}"`);
		const dir = ref?.dir ?? ctx.cwd;
		const remotes = (await git(dir, "remote")).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		const remote = remotes.includes("origin") ? "origin" : remotes[0];
		if (!remote) return fail("the repo has no remote");
		const sym = await git(dir, "ls-remote", "--symref", remote, "HEAD");
		const head = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(sym.stdout);
		if (sym.code !== 0 || !head) return fail(`cannot read the default branch of ${remote}`);
		const branch = head[1];
		const fetched = await git(dir, "fetch", remote, branch);
		if (fetched.code !== 0) return fail(`cannot fetch ${remote} ${branch}`);
		const remoteRef = `${remote}/${branch}`;
		const resolved = await git(dir, "rev-parse", "--verify", "--quiet", `${t.commit?.trim() || remoteRef}^{commit}`);
		const target = resolved.stdout.trim();
		if (resolved.code !== 0 || !target) return fail(`cannot resolve ${t.commit?.trim() || remoteRef}`);
		const onDefault = (await git(dir, "merge-base", "--is-ancestor", target, remoteRef)).code === 0;

		const listed = await git(dir, "ls-remote", "--tags", remote, `refs/tags/${t.name}`, `refs/tags/${t.name}^{}`);
		if (listed.code !== 0) return fail(`cannot read the tags of ${remote}`);
		let tagObject: string | undefined;
		let peeled: string | undefined;
		for (const line of listed.stdout.split(/\r?\n/)) {
			const [sha, ref2] = line.trim().split(/\s+/);
			if (ref2 === `refs/tags/${t.name}`) tagObject = sha;
			else if (ref2 === `refs/tags/${t.name}^{}`) peeled = sha;
		}
		const remoteSha = peeled ?? tagObject;
		let oldIsAncestor: boolean | undefined;
		if (remoteSha && t.move) {
			if ((await git(dir, "cat-file", "-e", `${remoteSha}^{commit}`)).code !== 0) {
				// A tag ref is always fetchable; a raw SHA only where the server allows it.
				const viaRef = await git(dir, "fetch", remote, `+refs/tags/${t.name}:refs/tmp-deliver/${t.name}`);
				if (viaRef.code !== 0) await git(dir, "fetch", remote, remoteSha);
				await git(dir, "update-ref", "-d", `refs/tmp-deliver/${t.name}`);
			}
			oldIsAncestor = (await git(dir, "merge-base", "--is-ancestor", remoteSha, target)).code === 0;
		}
		const d = tagDecision({ name: t.name, planned, move: t.move, remoteSha, target, onDefault, oldIsAncestor });
		if (d.action === "refuse") return { text: `tag ${t.name}: ${d.text}`, ok: d.ok === true };
		if (d.action === "wait") return { text: `tag ${t.name}: ${d.reason}`, ok: false, wait: d.reason };
		const lease = d.action === "move" ? (tagObject ?? d.lease) : undefined;
		const pushed = await pi.exec("git", ["-C", dir, ...pushArgs(remote, t.name, target, lease)], { timeout: 120_000 });
		if (pushed.code !== 0) {
			const why = `tag ${t.name} was not pushed: ${(pushed.stderr || pushed.stdout).split(/\r?\n/).find((l) => l.trim())?.trim() ?? "git push failed"}`;
			return { text: why, ok: false, wait: why };
		}
		const synced = await git(dir, "fetch", remote, `+refs/tags/${t.name}:refs/tags/${t.name}`);
		const note = synced.code === 0 ? "" : " (the local tag was not updated)";
		return { text: d.action === "move" ? `moved ${t.name} from ${(remoteSha as string).slice(0, 9)} to ${target.slice(0, 9)}${note}` : `tag ${t.name} created at ${target.slice(0, 9)}${note}`, ok: true };
	}

	pi.registerTool({
		name: "deliver",
		label: "Deliver",
		description:
			"Deliver inside the plan, then carry on in the same turn: commit, push, open a pull request or merge (`mode`), and/or create or move a tag on the remote default branch (`tag`). Within this stage's approved delivery only. The diff must pass the judge first (an unchanged passed diff is reused). Name the plan's `Deliver:` step as `step`; a call without one is added to the plan as an amendment. Tags are created or moved only for a named plan step or when you need them to continue; a move needs a plan step that names the tag and the word move.",
		promptSnippet: "deliver: commit/push/PR/merge and tags inside the plan (judge-gated), then continue",
		parameters: Type.Object({
			mode: Type.Optional(Type.String({ description: "commit, push, pr or merge. Omit to only handle a tag." })),
			tag: Type.Optional(
				Type.Object({
					name: Type.String({ description: "Tag name, e.g. unity-build/v1.0.8" }),
					commit: Type.Optional(Type.String({ description: "Commit to tag. Default: the tip of the remote default branch" })),
					move: Type.Optional(Type.Boolean({ description: "Move an existing tag forward (needs a plan step that names it)" })),
					repo: Type.Optional(Type.String({ description: "Repo root or folder name. Default: the working folder's repo" })),
				}),
			),
			step: Type.Optional(Type.String({ description: "The plan's Deliver step, e.g. S4" })),
			reason: Type.Optional(Type.String({ description: "Why, for an unplanned checkpoint (goes into the plan's amendment)" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const reply = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
			const plan = state.approvedPlan;
			if (state.phase !== "execute" || !plan) return reply("deliver works only while executing an approved plan. Nothing changed.");
			const staged = currentStages();
			const stage = staged?.stages[staged.current - 1];
			const cap = stageDelivery(state.delivery ?? defaultDelivery(), stage);
			if (cap === "off") return reply("Delivery is off for this stage. Nothing changed.");
			const mode = params.mode?.trim().toLowerCase() || undefined;
			const tag = params.tag && params.tag.name?.trim() ? { ...params.tag, name: params.tag.name.trim(), move: params.tag.move === true } : undefined;
			if (!mode && !tag) return reply("Give a mode (commit, push, pr, merge) or a tag. Nothing changed.");
			if (mode && !["commit", "push", "pr", "merge"].includes(mode)) return reply(`Unknown mode "${mode}": use commit, push, pr or merge. Nothing changed.`);
			if (mode && !modeAllowed(mode, cap)) return reply(`mode ${mode} is beyond this stage's delivery (${cap}). Nothing changed.`);
			if (tag && !modeAllowed("push", cap)) return reply(`A tag is pushed: this stage's delivery (${cap}) does not allow a push. Nothing changed.`);

			const step = params.step?.trim().toUpperCase() || undefined;
			const stepText = step ? parseDeliverStep(plan, step) : null;
			const planned = stepText !== null;
			if (!planned) {
				const reason = params.reason?.trim() || "needed to continue";
				const amend = { mode, tag: tag?.name, reason };
				if (!hasCheckpointAmendment(plan, amend)) {
					state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${checkpointAmendment(nextAmendmentNumber(), amend)}\n`;
					refreshChecklist();
					planMilestone(ctx);
					persist();
				}
			}

			const parts: string[] = [];
			let ok = true;
			let acted = false;
			let waitReason: string | undefined;
			if (mode) {
				const diff = await collectFlowDiff(ctx);
				if (!diff) throw new Error("no git work tree in this flow (working folder, /folders, or repos edited this flow); deliver commits git diffs");
				if (!diff.text || (diff.multi && !diff.repos.some((r) => r.changed))) parts.push("no changes to deliver");
				else {
					const reuse = state.passedDiff === diff.hash && state.lastJudge?.hash === diff.hash && state.lastJudge.verdict === "PASS";
					if (!reuse) {
						if (staged) state.stageJudged = true;
						const progress = toolProgress(onUpdate);
						const r = await judge(ctx, diff, params.reason?.trim() || undefined, signal, progress.track);
						if (r.verdict === "ERROR") throw new Error(r.text);
						if (r.verdict === "FAIL") state.judgeRounds++;
						let text = r.text;
						const reminder = openStepsReminder(state.checklist, staged?.current);
						if (reminder) text += `\n\n${reminder}`;
						state.pendingPlanFlaw = hasPlanFlaw(r.text) ? r.text : undefined;
						persist();
						if (r.verdict === "FAIL") return reply(`${text}\n\nNot delivered: fix the findings and call deliver again.`, { runs: progress.snapshot(), verdict: r.verdict });
						if (state.pendingPlanFlaw) return reply(`${text}\n\nThis review questions the plan. Do not change the plan's design yourself: end your turn now; the workflow resolves it. Nothing was delivered.`, { runs: progress.snapshot(), verdict: r.verdict });
					}
					if (!fs.existsSync(COMMIT_GUARD_EXTENSION)) return reply(`Not delivered: commit guard extension not found at ${COMMIT_GUARD_EXTENSION}.`);
					const knowledge = state.lastKnowledge?.hash === diff.hash ? state.lastKnowledge : undefined;
					if (knowledge?.status === "unavailable" && ctx.hasUI && autopilotOn()) {
						ctx.ui.notify(`workflow: autopilot commits without the knowledge check: ${knowledge.reason}`, "warning");
					} else if (knowledge?.status === "unavailable" && ctx.hasUI) {
						const choice = await askUser(ctx, `Judge passed, knowledge not checked: ${knowledge.reason}`, ["Commit anyway", "Stop"]);
						if (choice !== "Commit anyway") return reply("Not delivered: stopped at the knowledge check.");
					}
					const seed = branchName(cfg.delivery.branchPrefix, stage?.title || planTitle(plan), new Date());
					const { pending, instruction } = await prepareAllRepos(ctx, diff, mode as Exclude<Delivery, "off">, seed, knowledge ? deviationBlock(knowledge.deviations) : "");
					view.stage = "commit";
					view.changed();
					let report: string;
					let outcome: { text: string; ok: boolean };
					try {
						report = await runCommitSubagent(ctx, instruction, mode as Delivery, pending, signal);
						outcome = await readOutcome(ctx, pending);
					} finally {
						view.stage = "execute";
						view.changed();
					}
					committedDiffs.add(diff.hash);
					state.lastJudge = undefined;
					state.passedDiff = undefined;
					state.stageJudged = false;
					acted = true;
					ok = outcome.ok;
					parts.push(outcome.text);
					if (!outcome.ok && report) parts.push(`commit step: ${report.slice(0, 500)}`);
				}
			}
			if (tag) {
				if (mode && !ok) parts.push(`tag ${tag.name} not attempted: the delivery is incomplete`);
				else {
					acted = true;
					const t = await deliverTag(ctx, tag, isPlannedTag(stepText, tag.name, tag.move));
					parts.push(t.text);
					if (!t.ok) ok = false;
					waitReason = t.wait;
				}
			}
			if (waitReason) {
				state.waiting = { reason: waitReason, ...(planned && step ? { step } : {}), stage: state.stage, since: new Date().toISOString(), planned };
			}
			const text = parts.join("; ");
			if (acted) {
				state.checkpoints = [...(state.checkpoints ?? []), { ...(planned && step ? { step } : {}), stage: state.stage, text: checkpointText(planned ? step : undefined, text), ok }];
			}
			persist();
			updateStatus(ctx);
			planMilestone(ctx);
			if (waitReason) return reply(`${text}\n\nWaiting for: ${waitReason}. End your turn now; the workflow resumes you when the user replies.`);
			const branches: string[] = [];
			for (const ref of await flowRepos(ctx)) {
				const b = (await git(ref.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
				if (b) branches.push(`${path.basename(ref.root)}: ${b}`);
			}
			return reply(`${text}${branches.length ? `\n\nCurrent branch: ${branches.join(", ")}` : ""}\n\nContinue with the next steps in this turn.`);
		},
		renderCall(args, theme) {
			const what = [args.mode, args.tag?.name ? `tag ${args.tag.name}` : ""].filter(Boolean).join(" + ");
			return new Text(`${title(theme, "deliver", "execute")}${theme.fg("accent", ` ${what}`)}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 40),
	});

	// ----------------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		const folders = existingFolders();
		const touched = state.touchedRepos ?? [];
		if (folders.length || touched.length) {
			const opts = event.systemPromptOptions;
			opts.sections.workspace = prompts.workspaceSection(ctx.cwd, folders, touched);
			const have = new Set(opts.contextFiles.map((f) => repoKey(f.path)));
			for (const folder of folders) {
				try {
					for (const f of loadProjectContextFiles({ cwd: folder, agentDir: getAgentDir() })) {
						if (have.has(repoKey(f.path))) continue;
						have.add(repoKey(f.path));
						opts.contextFiles.push(f);
					}
				} catch {
					// an unreadable folder just adds no context files
				}
			}
		}
		const staged = state.phase === "execute" ? currentStages() : undefined;
		const phaseText = prompts.phaseSection(state.phase, {
			finalize: cfg.finalizePlan,
			staging: cfg.stagedPlans,
			recap: cfg.planRecap,
			stage: staged ? stageLine(staged.stages, staged.current) : undefined,
			testFix: state.phase === "execute" && !!state.testFlow,
		});
		if (phaseText) event.systemPromptOptions.sections.workflow = phaseText;
		else delete event.systemPromptOptions.sections.workflow;
	});

	// Plan phase is read-only: the planner settles the approach, the execute model changes things.
	// Nested calls (codemode's tools.bash) pass through here too.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "test_run" && state.phase !== "test") return { block: true, reason: "test_run works only in the test phase." };
		if (state.phase === "execute") {
			// Pushing is the workflow's job after the judge passes; the executor may not publish or skip hooks.
			const input = (event.input ?? {}) as Record<string, unknown>;
			const texts: { text: string; powershell: boolean }[] = [];
			const win = process.platform === "win32";
			if (/(^|__)bash$/.test(event.toolName)) texts.push({ text: String(input.command ?? ""), powershell: false });
			else if (/(^|__)ctx_execute(_file)?$/.test(event.toolName)) {
				const language = String(input.language ?? "").toLowerCase();
				const code = String(input.code ?? "");
				if (["shell", "bash", "sh", "zsh", "powershell", "pwsh", "ps1"].includes(language)) texts.push({ text: code, powershell: ["powershell", "pwsh", "ps1"].includes(language) || (language === "shell" && win) });
				else if (/\bgit\b/.test(code) && /\bpush\b|\bcommit\b|--no-verify|hooksPath|GIT_CONFIG/i.test(code)) {
					return { block: true, reason: "Refused: code that runs git push, skips hooks or changes hooks. The workflow commits and pushes after the judge passes." };
				} else if (/\bgh\b/.test(code) && /\b(pr|api)\b/.test(code)) {
					return { block: true, reason: "Refused: code that runs gh pr or gh api. The workflow opens and merges pull requests after the judge passes." };
				}
			}
			else if (/(^|__)ctx_batch_execute$/.test(event.toolName) && Array.isArray(input.commands)) {
				for (const c of input.commands) texts.push({ text: String((c as { command?: unknown })?.command ?? ""), powershell: win });
			}
			const gitTexts = texts.filter((t) => /\bgit\b|\bgh\b/i.test(t.text));
			if (gitTexts.length === 0) return;
			// Several repos: a command is checked against the repo it points at (git -C, cd), else the working folder's.
			const multi = (state.folders?.length ?? 0) > 0 || (state.touchedRepos?.length ?? 0) > 0;
			const roots = multi ? (await flowRepos(ctx)).map((r) => r.root) : [];
			const branches = new Map<string, string>();
			const branchOf = async (dir: string) => {
				if (!branches.has(dir)) branches.set(dir, (await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim());
				return branches.get(dir) as string;
			};
			const modeOf = (root: string | undefined) => (root ? state.commitPending?.repos?.find((r) => repoKey(r.root) === repoKey(root))?.mode : undefined) ?? state.commitPending?.mode;
			for (const { text, powershell } of gitTexts) {
				const problem = await shellProblem(text, powershell, { roots: multi ? roots : undefined, cwd: ctx.cwd, protectedBranches: cfg.protectedBranches, branchOf, modeOf });
				if (problem) return { block: true, reason: `Refused: ${problem}. Do not commit, push, open or merge pull requests, or skip hooks yourself: finish the code, get the judge's pass and end your turn; the workflow commits and delivers it as this flow's delivery says.` };
			}
			return;
		}
		if (state.phase === "test") {
			// The supervisor only reads and sends runners; the plan phase's read-only checks, plus the test allow list.
			const blocked = (why: string) => ({ block: true as const, reason: `Test phase: the supervisor only reads and sends runners (${why}). Do not work around this (no other tool, no script): put what must run into a test_run task, and what must change into a [bug] item.` });
			const refused = planToolRefused(event.toolName, testAllowedTools(), testBlockedTools());
			if (refused) return blocked(refused);
			if (!cfg.planReadOnlyBash) return;
			if (event.toolName === "powershell") return blocked("PowerShell commands are not checked, so they are off in the test phase");
			const problem = planToolProblem(event.toolName, (event.input ?? {}) as Record<string, unknown>, [...planAllow(), ...regexes(cfg.test.supervisorBashAllow)]);
			if (problem) return blocked(problem);
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

	/** The valid regexes among `patterns`. */
	function regexes(patterns: string[]): RegExp[] {
		return patterns.flatMap((p) => {
			try {
				return [new RegExp(p)];
			} catch {
				return [];
			}
		});
	}

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

	// A repo edited with edit/write joins the flow, so the judge and the delivery cover it.
	pi.on("tool_result", async (event, ctx) => {
		if (!/(^|__)(edit|write)$/.test(event.toolName) || event.isError) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const raw = String(input.path ?? input.file_path ?? "").replace(/^@/, "");
		if (!raw) return;
		let dir = path.dirname(path.resolve(ctx.cwd, raw));
		while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
		const root = await gitRoot(dir);
		if (!root) return;
		const known = new Set((await flowRepos(ctx)).map((r) => repoKey(r.root)));
		if (known.has(repoKey(root)) || (state.touchedRepos ?? []).some((t) => repoKey(t) === repoKey(root))) return;
		state.touchedRepos = [...(state.touchedRepos ?? []), root];
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`workflow: ${root} joins this flow (edited ${raw})`, "info");
	});

	// Skills and prompts of the added folders.
	pi.on("resources_discover", async () => {
		const skillPaths: string[] = [];
		const promptPaths: string[] = [];
		for (const f of existingFolders()) {
			for (const d of [path.join(f, ".pi", "skills"), path.join(f, ".agents", "skills")]) if (fs.existsSync(d)) skillPaths.push(d);
			const dir = path.join(f, ".pi", "prompts");
			if (fs.existsSync(dir)) promptPaths.push(dir);
		}
		return { skillPaths, promptPaths };
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
		if (pendingHandover) {
			const msg = pendingHandover;
			pendingHandover = undefined;
			const send = (content: string) => {
				commitHandoverInFlight = false;
				pi.sendMessage({ customType: msg.customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
			};
			const held = ctx.getContextUsage()?.tokens ?? null;
			const plan = state.approvedPlan;
			const action = handoverAction({ aborted: event.aborted, commit: msg.customType === "workflow-commit", idle: ctx.isIdle(), compacting, hasPlan: !!plan, tokens: held, threshold: cfg.handoverCompactTokens });
			if (action === "hold") {
				ctx.ui.notify("workflow: handover held: the run was aborted. Send a message or use /flow to continue.", "warning");
				return;
			}
			if (action !== "compact" || !plan) {
				send(msg.content);
				return;
			}
			compactPending = false;
			compacting = true;
			commitHandoverInFlight = msg.customType === "workflow-commit";
			const compactStart = Date.now();
			ctx.ui.notify(`workflow: handing over at ${Math.round((held ?? 0) / 1000)}k tokens, compacting first`, "info");
			ctx.compact({
				customInstructions: prompts.HANDOVER_COMPACT,
				onComplete: () => {
					recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "handover", tokensBefore: held ?? null, ms: Date.now() - compactStart, ok: true });
					compacting = false;
					guardTokens = null;
					if (msg.customType === "workflow-commit") send(`${msg.content}\n\n${commitExcerpt()}`);
					else void planCardReady().then((card) => send(`${msg.content}\n\n${card}`));
				},
				onError: (e) => {
					recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "handover", tokensBefore: held ?? null, ms: Date.now() - compactStart, ok: false, error: e.message });
					compacting = false;
					ctx.ui.notify(`workflow: compaction failed: ${e.message}`, "error");
					send(msg.content);
				},
			});
			return;
		}
		if (!compactPending || compacting || event.aborted || !ctx.isIdle()) return;
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		compactPending = false;
		if (tokens === null || tokens <= cfg.contextGuardTokens) return;
		compacting = true;
		ctx.ui.notify(`workflow: context at ${Math.round(tokens / 1000)}k, compacting`, "info");
		const compactStart = Date.now();
		ctx.compact({
			onComplete: () => {
				recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "guard", tokensBefore: tokens, ms: Date.now() - compactStart, ok: true });
				compacting = false;
				guardTokens = null;
				if (state.phase === "execute" && state.approvedPlan) void planCardReady().then((card) => state.phase === "execute" && state.approvedPlan && pi.sendMessage({ customType: "workflow-plan-card", content: card, display: true }, { triggerTurn: false }));
			},
			onError: (e) => {
				recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "guard", tokensBefore: tokens, ms: Date.now() - compactStart, ok: false, error: e.message });
				compacting = false;
				ctx.ui.notify(`workflow: compaction failed: ${e.message}`, "error");
			},
		});
	});

	// Rows from the previous run stay visible a little while, then make room.
	pi.on("agent_start", async () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
		notifiedSinceStart = false;
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
		// A typed message ends a wait (after the check, if it has one).
		const typed = event.text.trim();
		if (state.phase === "execute" && state.waiting && event.source !== "extension" && !event.streamingBehavior && typed && !typed.startsWith("/")) {
			const w = state.waiting;
			let how: "passed" | "forced" | "plain" = w.check ? "passed" : "plain";
			// The poll timer must not end this wait while the check or the question is open.
			stopWaitTimer();
			waitChecking = true;
			try {
				const verdict = w.check && !w.checkPassed ? await runWaitCheck(w.check) : undefined;
				if (w.check && verdict && verdict.status !== "pass") {
					if (state.waiting !== w) return { action: "continue" };
					if (!ctx.hasUI) {
						startWaitTimer();
						return { action: "handled" };
					}
					const choice = await ctx.ui.select(checkTitle(verdict, w.check), ["Continue anyway", "Keep waiting"]);
					if (state.waiting !== w) return { action: "continue" };
					if (choice !== "Continue anyway") {
						ctx.ui.notify(`workflow: still waiting for "${w.reason}"`, "info");
						startWaitTimer();
						return { action: "handled" };
					}
					how = "forced";
				}
			} finally {
				waitChecking = false;
			}
			if (state.waiting !== w) return { action: "continue" };
			clearWait(ctx);
			return { action: "transform", text: `${resumePrefix(w.reason, how)}\n\n${w.held ? `${w.held}\n\n` : ""}${typed}` };
		}
		// In the test phase without a flow, the first typed message is what to test.
		if (state.phase === "test" && !state.testFlow && event.source !== "extension" && !event.streamingBehavior && event.text.trim() && !event.text.trim().startsWith("/")) {
			await startTestFlow(ctx, event.text.trim());
			return { action: "continue" };
		}
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
			return { action: "transform", text: `${event.text.trim()}\n\n${prompts.finalize(cfg.delivery.splitCommits, DELIVERY_LABELS[state.delivery], cfg.stagedPlans)}` };
		}
		await setPhase(ctx, "execute");
		const extra = startExecution(ctx, lastPlanText);
		persist();
		ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(cfg.roles.execute)}, then ${DELIVERY_LABELS[state.delivery]}`, "info");
		return { action: "transform", text: `${event.text.trim()}\n\n${APPROVED}${extra}` };
	});

	pi.on("session_compact", async (event, ctx) => {
		if (event.reason === "overflow" && event.willRetry) overflowRetry = true;
		try {
			const entries = ctx.sessionManager.getEntries();
			const c = entries.findIndex((e) => e.id === event.compactionEntry.id);
			const k = entries.findIndex((e) => e.id === event.compactionEntry.firstKeptEntryId);
			let p = -1;
			let s = -1;
			for (let i = 0; i < c; i++) {
				const e = entries[i] as { type: string; customType?: string; data?: { title?: string; reposted?: boolean } };
				if (e.type === "compaction") p = i;
				if (e.type === "custom" && e.customType === SUMMARY_ENTRY && e.data && e.data.title === undefined && !e.data.reposted) s = i;
			}
			if (s > p && (k === -1 || s < k)) pi.appendEntry(SUMMARY_ENTRY, { ...(entries[s] as { data: object }).data, reposted: true });
		} catch {
			// the card is a convenience; never break compaction
		}
	});

	/** Sends a workflow message that starts the next executor turn. From agent_end it waits for the run to settle, so the session can be compacted first. */
	function handover(customType: string, content: string): void {
		if (inAgentEnd) {
			pendingHandover = { customType, content };
			return;
		}
		pi.sendMessage({ customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	// True while handling the end of a run the user aborted: stageAdvance "auto" must not move on then.
	let turnAborted = false;

	pi.on("agent_end", async (event, ctx) => {
		inAgentEnd++;
		const prevAborted = turnAborted;
		const lastMsg = [...event.messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		turnAborted = !!event.aborted || lastMsg?.stopReason === "aborted";
		try {
			await onAgentEnd(event, ctx);
		} finally {
			turnAborted = prevAborted;
			inAgentEnd--;
			if (inAgentEnd === 0) scheduleIdleNotice(ctx);
		}
	});

	async function onAgentEnd(event: { messages: AgentMessage[] }, ctx: ExtensionContext): Promise<void> {
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
				const extra = startExecution(ctx, finalText);
				persist();
				handover("workflow-execute", APPROVED_FINAL + extra);
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
			const recapChanges = cfg.finalizePlan && cfg.planRecap === "changes";
			if (stoppedNormally && hasPlanLine(text)) planProposed = true;
			planReady = recapChanges ? canApprove(text, stoppedNormally, planProposed) : isPlanReady(text, stoppedNormally);
			if (!stoppedNormally) return;
			lastPlanText = text;
			if (!cfg.planPrompt) {
				ctx.ui.notify(`workflow: say "go" to execute on ${describeRole(cfg.roles.execute)}, or keep discussing.`, "info");
				return;
			}
			const def = menuDefault();
			const options = cfg.delivery.ask && !autopilotOn() ? deliveryChoices(def) : [def];
			const labels = options.map((d) => `Approve → ${deliveryMenuLabel(d, def)}`);
			const arbiterLabel = "Approve, arbiter solves plan flaws →";
			const showLabel = "Show the full plan";
			const choice = await askUser(ctx, `Plan phase · execute on ${describeRole(cfg.roles.execute)}`, [...labels, ...(cfg.planFlaw === "ask" ? [arbiterLabel] : []), ...(recapChanges ? [showLabel] : []), "Keep discussing"]);
			if (recapChanges && choice === showLabel) {
				pi.sendMessage({ customType: "workflow-show-plan", content: prompts.SHOW_PLAN, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			if (choice === arbiterLabel && cfg.planFlaw === "ask") {
				await approve(ctx, undefined, true);
				return;
			}
			const i = choice ? labels.indexOf(choice) : -1;
			if (i >= 0) await approve(ctx, options[i]);
			return;
		}

		if (state.phase === "test") {
			await onTestEnd(ctx, last);
			return;
		}
		if (state.phase !== "execute") return;
		// Waiting for a person: no judge, no delivery, no stage advance until the wait is over.
		if (state.waiting) return;
		if (skipJudge(last)) {
			const choice = await askUser(ctx, "The executor's last reply ended in an error", ["Retry", "Back to planning", "Stop"]);
			if (choice === "Retry") {
				pi.sendMessage(
					{ customType: "workflow-retry", content: "Your last reply ended in an error. Continue with the open steps of the approved plan.", display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} else if (choice === "Back to planning") {
				await setPhase(ctx, "plan");
			} else {
				ctx.ui.notify("workflow: stopped: the executor's reply failed", "warning");
				summarizeFlow(stoppedSummary("stopped: the executor's reply failed"), false);
				await endFlow(ctx);
			}
			return;
		}
		let rejudge = false;
		if (state.pendingPlanFlaw) {
			// The executor's own judge call questioned the plan; it was told to stop, so the workflow decides.
			const report = state.pendingPlanFlaw;
			state.pendingPlanFlaw = undefined;
			persist();
			const flawed = await collectFlowDiff(ctx);
			if (flawed) {
				if (state.lastJudge?.hash === flawed.hash) {
					const route = planFlawOnPass(report, state.lastJudge.verdict === "PASS" ? "PASS" : "FAIL");
					const outcome = route === "stop" ? await resolvePlanFlaw(ctx, report, flawed) : await settlePlanFlawOnPass(ctx, report, flawed, route);
					if (outcome !== "continue") return;
					if (state.lastJudge.verdict === "PASS") markPassed(flawed.hash);
					else {
						await fixOrAsk(ctx, undefined);
						return;
					}
				} else {
					// The diff changed since that review: drop the stale report and let reviewDiff judge this diff again.
					seenDiffs.delete(flawed.hash);
					rejudge = true;
				}
			}
		}
		if (commitHandoverInFlight || commitSubagentRunning) return;
		if (state.commitPending) {
			const advanced = await summarizeCommit(ctx);
			if (advanced === "advanced" || state.phase !== "execute") return; // the next stage started, or the flow ended and went back to planning
		}
		await reviewDiff(ctx, rejudge);
	}

	/** A stage that declares `(after: …)` waits before it starts: keeps its start text until the wait is over. True when it now waits. */
	function holdForStageWait(ctx: ExtensionContext, stage: ReturnType<typeof parseStages>[number], held: string): boolean {
		if (!stage.after) return false;
		state.waiting = { reason: stage.after.reason, ...(stage.after.check ? { check: stage.after.check } : {}), stage: stage.n, since: new Date().toISOString(), planned: true, atStageStart: true, held };
		persist();
		updateStatus(ctx);
		planMilestone(ctx);
		ctx.ui.notify(`workflow: stage ${stage.n} waits for: ${stage.after.reason}`, "info");
		startWaitTimer();
		return true;
	}

	/** Staged plan: moves on to the next stage and sends its start message. */
	function startNextStage(ctx: ExtensionContext, stages: ReturnType<typeof parseStages>, outcome: string): void {
		const next = (state.stage ?? 0) + 1;
		state.stage = next;
		state.judgeRounds = 0;
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.stageJudged = undefined;
		if (state.passedDiff) markPassSummarized(state.passedDiff); // a leftover diff from the stage before is not this stage's
		state.lastJudge = undefined; // a new stage gets a full review, not a re-review of the last one
		view.stage = "execute";
		view.changed();
		planMilestone(ctx);
		persist();
		ctx.ui.notify(`workflow: stage ${next} of ${stages.length}: ${stages[next - 1].title}`, "info");
		const text = nextStage(stages, next, state.delivery ?? defaultDelivery(), outcome);
		if (holdForStageWait(ctx, stages[next - 1], text)) return;
		handover("workflow-stage", text);
	}

	/** A staged plan's turn ended with nothing new to review: it ends the stage only if the executor handed it over (judge called) or the user confirms. */
	async function noChangeTurn(ctx: ExtensionContext, staged: { stages: ReturnType<typeof parseStages>; current: number }): Promise<void> {
		const auto = (cfg.stageAdvance === "auto" || autopilotOn()) && !turnAborted;
		const open = (state.checklist ?? []).filter((i) => !i.done && (i.stage === undefined || i.stage === staged.current)).length;
		const what = noChangeStage(!!state.stageJudged, ctx.hasUI, auto, open);
		if (what === "wait") return;
		if (what === "advance" && auto && !state.stageJudged) ctx.ui.notify(`workflow: stage ${staged.current} ended with no changes; continuing (${cfg.stageAdvance === "auto" ? "stageAdvance: auto" : "autopilot"})`, "info");
		if (what === "ask") {
			const yes = "Mark done and continue";
			if ((await askUser(ctx, `Stage ${staged.current} ended with no changes`, [yes, "Wait"])) !== yes) return;
		}
		await stageWithoutChanges(ctx, staged);
	}

	/** An unstaged flow whose remaining changes were all delivered by checkpoints: ends it with their outcome. Open steps ask first (and do nothing without a UI). */
	async function flowWithoutChanges(ctx: ExtensionContext): Promise<void> {
		const outcome = checkpointOutcome(state.checkpoints ?? []);
		if (!outcome || state.phase !== "execute" || turnAborted) return;
		if ((state.checklist ?? []).some((i) => !i.done)) {
			if (!ctx.hasUI) return;
			const yes = "Mark done and finish";
			if ((await askUser(ctx, "All changes were delivered at checkpoints, but plan steps are still open", [yes, "Wait"])) !== yes) return;
		}
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.delivery = undefined;
		state.planFlaw = undefined;
		view.stage = "execute";
		if (!summarizeFlow(outcome.text, outcome.ok)) persist();
		await endFlow(ctx);
	}

	/** A staged plan's stage ended with nothing to review: records it and starts the next stage, or ends the flow after the last one. */
	async function stageWithoutChanges(ctx: ExtensionContext, staged: { stages: ReturnType<typeof parseStages>; current: number }): Promise<void> {
		const outcome = checkpointOutcome(stageCheckpoints()) ?? { text: "no changes", ok: true };
		state.stageOutcomes = [...(state.stageOutcomes ?? []), outcome];
		if (staged.current < staged.stages.length) {
			startNextStage(ctx, staged.stages, outcome.text);
			return;
		}
		const final = stagesOutcome(state.stageOutcomes, staged.stages.length);
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.delivery = undefined;
		state.planFlaw = undefined;
		state.stage = undefined;
		state.stageOutcomes = undefined;
		view.stage = "execute";
		if (!summarizeFlow(final.text, final.ok)) persist();
		await endFlow(ctx);
	}

	/** The summary text for a flow that stops early: the stages already delivered, then `text`. Clears the stage state. */
	function stoppedSummary(text: string): string {
		const staged = currentStages();
		const done = state.stageOutcomes ?? [];
		state.stage = undefined;
		state.stageOutcomes = undefined;
		if (!staged || done.length === 0) return text;
		return `${done.map((p, i) => `stage ${i + 1}: ${p.text}`).join("; ")}; ${text}`;
	}

	/** What the commit step achieved in every repo of `pending`, read from git and gh. */
	async function readOutcome(ctx: ExtensionContext, pending: NonNullable<FlowState["commitPending"]>): Promise<{ text: string; ok: boolean }> {
		const { mode, head, branch, prBefore, pushSkipped, repos } = pending;
		if (repos?.length) {
			const parts = await Promise.all(repos.map(async (r) => ({ name: path.basename(r.root), outcome: await repoOutcome(r.root, r.mode, r.head, r.branch, r.prBefore, r.pushSkipped) })));
			return combineOutcomes(parts);
		}
		return (await repoOutcome(ctx.cwd, mode, head, branch, prBefore, pushSkipped)) ?? { text: "commit step ended without a commit", ok: false };
	}

	/** The commit step ended. "advanced": a staged plan moved on to its next stage; "ended": the flow is over. */
	async function summarizeCommit(ctx: ExtensionContext): Promise<"advanced" | "ended"> {
		const pending = state.commitPending!;
		state.commitPending = undefined;
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		let outcome = await readOutcome(ctx, pending);
		const cps = stageCheckpoints();
		if (cps.length && !state.testFlow) outcome = { text: withCheckpoints(cps.map((c) => c.text), outcome.text), ok: outcome.ok && cps.every((c) => c.ok) };
		if (state.testFlow) {
			if (!outcome.ok) ctx.ui.notify(`workflow: the fix round's delivery is incomplete (${outcome.text}); testing again anyway`, "warning");
			await startTestRound(ctx, "retest");
			return "advanced";
		}
		const staged = currentStages();
		if (staged) {
			state.stageOutcomes = [...(state.stageOutcomes ?? []), outcome];
			if (staged.current < staged.stages.length) {
				let go = outcome.ok;
				if (!go && (cfg.stageAdvance === "auto" || autopilotOn()) && !turnAborted) {
					ctx.ui.notify(`workflow: stage ${staged.current} delivery incomplete (${outcome.text}); continuing with stage ${staged.current + 1} (${cfg.stageAdvance === "auto" ? "stageAdvance: auto" : "autopilot"})`, "warning");
					go = true;
				} else if (!go && ctx.hasUI) {
					const more = `Continue with stage ${staged.current + 1}`;
					go = (await askUser(ctx, `Stage ${staged.current} delivery incomplete: ${outcome.text}`, [more, "Stop"])) === more;
				}
				if (go) {
					startNextStage(ctx, staged.stages, outcome.text);
					return "advanced";
				}
			}
			outcome = stagesOutcome(state.stageOutcomes, staged.stages.length);
		}
		state.delivery = undefined; // the flow is over; the next one chooses again
		state.planFlaw = undefined;
		state.stage = undefined;
		state.stageOutcomes = undefined;
		const shown = summarizeFlow(outcome.text, outcome.ok);
		if (!shown) persist(); // commitPending was cleared
		await endFlow(ctx);
		return "ended";
	}

	/** What one repo's commit step achieved, or null when it made no commit (and merged nothing). */
	async function repoOutcome(dir: string, mode: Exclude<Delivery, "off">, head: string, branch: string | undefined, prBefore: number | undefined, pushSkipped: string | undefined): Promise<{ text: string; ok: boolean } | null> {
		// The commits' branch; HEAD when detached, unknown (state saved by an older version) or gone (deleted after the merge).
		const recordedNamed = !!branch && branch !== "HEAD" && (await git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;
		if (recordedNamed) {
			// The commit step may have switched to a new branch (D14): then the commits are there, not on the recorded one.
			const landed = await landedBranch((...a) => git(dir, ...a), branch as string, head);
			if (landed) branch = landed;
		}
		const named = !!branch && branch !== "HEAD" && (await git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;
		const rev = named ? (branch as string) : "HEAD";
		const now = (await git(dir, "rev-parse", rev)).stdout.trim();
		const wantsPr = mode === "pr" || mode === "merge";
		const ghOk = wantsPr ? await ghReady : true;
		const pr = wantsPr && branch && branch !== "HEAD" ? freshPr(await prState(dir, branch), prBefore) : null;
		if (pr?.state !== "MERGED" && (!now || now === head)) return null;
		// A merge that deleted the branch leaves HEAD on the base branch, whose count would include other commits.
		const counted = named || !branch || branch === "HEAD" ? await git(dir, "rev-list", "--count", `${head}..${rev}`) : undefined;
		const commits = counted?.code === 0 ? Number(counted.stdout.trim()) : undefined;
		const ahead = mode === "commit" ? undefined : await git(dir, "rev-list", "--count", `${named ? branch : ""}@{u}..${rev}`);
		const pushed = ahead?.code === 0 && ahead.stdout.trim() === "0";
		return deliveryOutcome(mode, commits, pushed, pr, !ghOk, pushSkipped);
	}

	let ghReady: Promise<boolean> = Promise.resolve(true);
	let ghNoticed = false;

	/** Makes `gh` runnable: when it is not on PATH, adds a standard GitHub CLI install folder to this process's PATH. */
	async function ensureGh(ctx: ExtensionContext): Promise<boolean> {
		const works = async () => {
			try {
				return (await pi.exec("gh", ["--version"], { timeout: 10_000 })).code === 0;
			} catch {
				return false;
			}
		};
		if (await works()) return true;
		const found = ghCandidates(process.env, process.platform).find((c) => fs.existsSync(c));
		if (!found) return false;
		const dir = path.dirname(found);
		const { key, value } = withPathDir(process.env, dir, path.delimiter);
		process.env[key] = value;
		if (!(await works())) return false;
		if (!ghNoticed) {
			ghNoticed = true;
			ctx.ui.notify(`workflow: gh was not on PATH; added ${dir}`, "info");
		}
		return true;
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
		const diff = await collectFlowDiff(ctx);
		// Committed, or changed since the judge passed: back to executing.
		if (view.stage === "commit" && diff?.hash !== state.passedDiff) {
			view.stage = "execute";
			view.changed();
		}
		if (!diff?.text) {
			if (manual) ctx.ui.notify("workflow: no changes to review", "info");
			else {
				if (await deliverSelfCommit(ctx)) return;
				if (state.testFlow) {
					if (!turnAborted) await startTestRound(ctx, "retest");
					return;
				}
				const staged = currentStages();
				if (staged) await noChangeTurn(ctx, staged);
				else await flowWithoutChanges(ctx);
			}
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
			if (!(await finishPassed(ctx, diff, prior ? `**Judge: PASS**\n\n${prior}` : undefined))) await summarizePass(ctx, diff.hash);
			return;
		}
		if (!manual && (cfg.autoJudge === "off" || seenDiffs.has(diff.hash))) return;
		if (!manual && cfg.autoJudge === "ask" && !autopilotOn()) {
			notifyUser(ctx, "diff ready for the judge");
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
			if (!ctx.hasUI || state.phase !== "execute") return;
			const choice = await askUser(ctx, "The judge failed to run", ["Retry the judge", "Back to planning", "Stop"]);
			if (choice === "Retry the judge") {
				await reviewDiff(ctx, true);
			} else if (choice === "Back to planning") {
				await setPhase(ctx, "plan");
			} else {
				ctx.ui.notify("workflow: stopped: the judge failed to run", "warning");
				summarizeFlow(stoppedSummary("stopped: the judge failed to run"), false);
				await endFlow(ctx);
			}
			return;
		}
		// The verdict travels with the next instruction, so they reach the transcript in order.
		const report = `**Judge: ${r.verdict}**\n\n${r.text}`;
		if (hasPlanFlaw(r.text)) {
			const route = planFlawOnPass(r.text, r.verdict);
			const outcome = route === "stop" ? await resolvePlanFlaw(ctx, report, diff) : await settlePlanFlawOnPass(ctx, report, diff, route);
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
		if (!(await finishPassed(ctx, diff, report))) {
			pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			await summarizePass(ctx, diff.hash);
		}
	}

	/** After a failed judge round: send the executor back to fix, or ask what to do once the round cap is hit. */
	async function fixOrAsk(ctx: ExtensionContext, report: string | undefined): Promise<void> {
		if (judgeCapReached(state.judgeRounds, cfg.maxJudgeRounds)) {
			if (report) pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			const choice = await askUser(ctx, `Judge failed ${state.judgeRounds} rounds in a row`, ["Keep fixing", "Escalate and keep fixing", "Stop"]);
			if (choice === "Keep fixing" || choice === "Escalate and keep fixing") {
				if (choice !== "Keep fixing") await escalate(ctx);
				state.judgeRounds = 0;
				persist();
				pi.sendMessage({ customType: "workflow-fix", content: FIX_MESSAGE, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			ctx.ui.notify(`workflow: stopped after ${state.judgeRounds} failed judge rounds`, "warning");
			summarizeFlow(stoppedSummary(`stopped: judge failed ${state.judgeRounds} rounds`), false);
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
		let arbiter = arbiterFirst(autopilotOn() ? "auto" : state.planFlaw, cfg.planFlaw);
		let canAsk = true;
		for (;;) {
			if (arbiter) {
				arbiter = false;
				const outcome = await runArbiter(ctx, report, diff);
				if (outcome !== "ask") return outcome;
				if (state.testFlow) {
					queueDisputes(report);
					notePlanFlaws(ctx, report, "Plan choices upheld until the user answers");
					return "continue";
				}
				canAsk = false; // the arbiter had its say; offer the rest
			}
			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
				summarizeFlow(stoppedSummary("stopped: judge questions the plan"), false);
				await endFlow(ctx);
				return "stop";
			}
			const options = ["Back to planning", ...(canAsk ? ["Let the arbiter decide"] : []), "Ignore and continue", "Stop"];
			const choice = await askUser(ctx, "Judge questions the plan", options);
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
				notePlanFlaws(ctx, report, "Plan choices upheld by the user");
				return "continue";
			}
			pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			summarizeFlow(stoppedSummary("stopped: judge questions the plan"), false);
			await endFlow(ctx);
			return "stop";
		}
	}

	/** Appends the report's plan-flaw lines to the approved plan under the heading; returns how many. */
	function notePlanFlaws(ctx: ExtensionContext, report: string, heading: string): number {
		const lines = planFlawLines(report).filter((l) => !(state.approvedPlan ?? "").includes(l));
		if (!lines.length) return 0;
		state.approvedPlan = `${state.approvedPlan ?? ""}\n\n## ${heading}\n${lines.join("\n")}`;
		refreshChecklist();
		planMilestone(ctx);
		persist();
		return lines.length;
	}

	/** A pass that questions the plan, without a blocker: minor flaws are noted, major ones go to the arbiter. Never asks the user. */
	async function settlePlanFlawOnPass(ctx: ExtensionContext, report: string, diff: Diff, route: "arbiter" | "note"): Promise<"continue" | "amended"> {
		const heading = "Plan choices upheld at a pass";
		if (route === "arbiter") {
			const outcome = await runArbiter(ctx, report, diff, false);
			if (outcome !== "ask") return outcome;
			queueDisputes(report);
			const n = notePlanFlaws(ctx, report, heading);
			if (!state.testFlow) state.unresolvedPlanFlaws = (state.unresolvedPlanFlaws ?? 0) + n; // a test flow asks about it at the end of the round
			persist();
			if (n > 0) ctx.ui.notify(`workflow: the arbiter did not settle ${n} plan flaw(s); noted in the plan, continuing`, "warning");
			return "continue";
		}
		const n = notePlanFlaws(ctx, report, heading);
		if (n > 0) ctx.ui.notify(`workflow: the judge passed but questions the plan (${n} plan flaw(s)); noted in the plan, continuing`, "info");
		return "continue";
	}

	/** Runs the arbiter on the judge's plan-flaw report. "ask" means it could not or may not decide. */
	async function runArbiter(ctx: ExtensionContext, report: string, diff: Diff, canAsk = true): Promise<"continue" | "amended" | "ask"> {
		ctx.ui.setWorkingMessage("arbiter checking the plan…");
		let text: string;
		try {
			const max = cfg.judge.maxDiffChars;
			const { result, run } = await runRole("arbiter", "plan-flaw", {
				systemPrompts: [...(diff.multi ? [prompts.repoNote(repoRoots(diff))] : []), prompts.ARBITER + (state.testFlow ? prompts.ARBITER_TEST : ""), `## Approved plan\n\n${planForJudge()}`, `## Judge report\n\n${report}`, `## Diff\n\n${diff.text.length > max ? diff.text.slice(0, max) : diff.text}`],
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
			refreshChecklist();
			planMilestone(ctx);
			persist();
			pi.sendMessage({ customType: "workflow-judge", content: `**Arbiter: the plan stands.**\n\n${d.reason}`, display: true }, { triggerTurn: false });
			return "continue";
		}
		if (d.decision === "REVISE") {
			const done = state.planRevisions ?? 0;
			if (done >= cfg.maxPlanRevisions) {
				ctx.ui.notify(`workflow: the plan was already amended ${done} time(s); ${canAsk ? "asking you" : "noting the flaws"} instead`, "warning");
				return "ask";
			}
			state.planRevisions = done + 1;
			state.approvedPlan = `${state.approvedPlan ?? ""}\n\n## Amendment ${nextAmendmentNumber()} (arbiter)\n${d.amendment}`;
			refreshChecklist();
			planMilestone(ctx);
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
		handover(
			"workflow-fix",
			`${shown}\n\nThe judge passed with ${findings} finding(s) to fix (knowledge deviations excluded; give a reason in \`disputes\` to keep one). Fix them by following their Fix directions, or put a wrong one in the \`disputes\` parameter of your next judge call instead of changing code. Then call judge again.`,
		);
		return true;
	}

	/** Remembers a passed diff's flow as ended, so later runs on the same diff don't end another one. */
	function markPassSummarized(hash: string): void {
		state.summarizedPasses = [...(state.summarizedPasses ?? []).filter((h) => h !== hash), hash].slice(-20);
	}

	/** The user chose Stop at the knowledge prompt of the pass being summarized. */
	let passStopped = false;

	/** The flow ends at a pass that won't be committed (delivery off, or Stop at the knowledge prompt), and may go back to planning. */
	async function summarizePass(ctx: ExtensionContext, hash: string): Promise<void> {
		const stopped = passStopped;
		passStopped = false;
		if (state.testFlow) {
			markPassSummarized(hash);
			if (turnAborted) return;
			// Nothing was committed: test again, unless the user chose Stop at the knowledge prompt.
			if (stopped) await finishTestFlow(ctx);
			else await startTestRound(ctx, "retest");
			return;
		}
		const staged = currentStages();
		if (state.summarizedPasses?.includes(hash)) {
			// A staged plan's stage added nothing to the diff that was already passed.
			if (staged) await noChangeTurn(ctx, staged);
			return;
		}
		const passed = { text: "judge passed, not committed", ok: true };
		if (staged) state.stageOutcomes = [...(state.stageOutcomes ?? []), passed];
		if (staged && staged.current < staged.stages.length && stageDelivery(state.delivery ?? defaultDelivery(), staged.stages[staged.current - 1]) === "off") {
			markPassSummarized(hash);
			startNextStage(ctx, staged.stages, passed.text);
			return;
		}
		const outcome = staged ? stagesOutcome(state.stageOutcomes ?? [passed], staged.stages.length) : passed;
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.delivery = undefined;
		state.planFlaw = undefined;
		state.stage = undefined;
		state.stageOutcomes = undefined;
		markPassSummarized(hash);
		view.stage = "execute";
		if (!summarizeFlow(outcome.text, outcome.ok)) persist();
		await endFlow(ctx);
	}

	/** Diffs already handed to the commit step, so a pass is committed once. */
	const committedDiffs = new Set<string>();

	/** Sends the commit step's instruction (commit, push, pull request, merge, as this flow's delivery says), prefixed with `report`. False if nothing was sent. */
	/** Where the commits of one repo go: the mode (a push on a protected branch falls back to commit), the branch, and what the instruction needs. `tag` names the repo in notices. */
	async function prepareDelivery(ctx: ExtensionContext, dir: string, chosen: Exclude<Delivery, "off">, seed: string, tag: string) {
		let mode = chosen;
		const current = (await git(dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
		const unsafe = !current || current === "HEAD" || cfg.protectedBranches.includes(current);
		let branch = current;
		let from: string | undefined;
		let pushSkipped: string | undefined;
		if (unsafe && mode === "push") {
			mode = "commit";
			pushSkipped = pushSkipReason(current);
			ctx.ui.notify(`workflow${tag}: on ${current || "a detached HEAD"}, committing without pushing`, "warning");
		} else if (unsafe && (mode === "pr" || mode === "merge")) {
			// A pull request never comes from a protected branch; the commits go on a new one.
			from = current || "HEAD";
			branch = await freeBranchName(dir, seed);
			ctx.ui.notify(`workflow${tag}: on ${current || "a detached HEAD"}, committing on new branch ${branch}`, "info");
		}
		const base = cfg.delivery.base || (from && from !== "HEAD" ? from : "");

		// An old closed or merged PR on this branch must not pass as this flow's (gh pr view falls back to it when none is open).
		let prBefore: number | undefined;
		if ((mode === "pr" || mode === "merge") && !from) {
			const old = await prState(dir, branch);
			if (old && old.state !== "OPEN") prBefore = old.number;
		}
		const head = (await git(dir, "rev-parse", "HEAD")).stdout.trim();
		const mergeInProgress = (await git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD")).code === 0;
		return { mode, branch, from, base, prBefore, head, pushSkipped, mergeInProgress };
	}

	/** Prepares every changed repo of `diff` for the commit step: the pending record (not stored in state) and the instruction. Only reads. */
	async function prepareAllRepos(ctx: ExtensionContext, diff: Diff, chosen: Exclude<Delivery, "off">, seed: string, deviations: string): Promise<{ pending: NonNullable<FlowState["commitPending"]>; instruction: string }> {
		const options = (p: Awaited<ReturnType<typeof prepareDelivery>>): DeliveryOptions => ({
			mode: p.mode,
			branch: p.branch,
			from: p.from,
			base: p.base,
			split: cfg.delivery.splitCommits,
			mergeMethod: cfg.delivery.mergeMethod,
			deleteBranch: cfg.delivery.deleteBranch,
			deviations,
			pushSkipped: p.pushSkipped,
			mergeInProgress: p.mergeInProgress,
		});
		if (!diff.multi) {
			const p = await prepareDelivery(ctx, ctx.cwd, chosen, seed, "");
			return { pending: { mode: p.mode, head: p.head, branch: p.branch, prBefore: p.prBefore, pushSkipped: p.pushSkipped }, instruction: deliveryInstruction(options(p)) };
		}
		const changed = diff.repos.filter((r) => r.changed);
		// Per-repo preparation only reads (git rev-parse, gh pr view), so the repos run at once; the order of `changed` is kept.
		const prepared = await Promise.all(changed.map(async (ref) => ({ root: ref.root, p: await prepareDelivery(ctx, ref.dir, chosen, seed, ` [${ref.root}]`) })));
		const first = prepared[0].p;
		return {
			pending: {
				mode: first.mode,
				head: first.head,
				branch: first.branch,
				prBefore: first.prBefore,
				pushSkipped: first.pushSkipped,
				repos: prepared.map(({ root, p }) => ({ root, mode: p.mode, head: p.head, branch: p.branch, prBefore: p.prBefore, pushSkipped: p.pushSkipped })),
			},
			instruction: repoDeliveryInstruction(prepared.map(({ root, p }) => ({ root, options: options(p) }))),
		};
	}

	/** Sends the commit step's instruction (commit, push, pull request, merge, as this flow's delivery says), prefixed with `report`. False if nothing was sent. */
	async function finishPassed(ctx: ExtensionContext, diff: Diff, report?: string): Promise<boolean> {
		passStopped = false;
		const hash = diff.hash;
		const staged = currentStages();
		const stage = staged?.stages[staged.current - 1];
		const chosen = stageDelivery(state.delivery ?? defaultDelivery(), stage);
		if (chosen === "off" || committedDiffs.has(hash)) return false;
		const changed = diff.multi ? diff.repos.filter((r) => r.changed) : [];
		if (diff.multi && changed.length === 0) return false;
		committedDiffs.add(hash);
		const knowledge = state.lastKnowledge?.hash === hash ? state.lastKnowledge : undefined;
		// D5: a pass without a knowledge check commits only when you say so.
		if (knowledge?.status === "unavailable" && ctx.hasUI && autopilotOn()) {
			ctx.ui.notify(`workflow: autopilot commits without the knowledge check: ${knowledge.reason}`, "warning");
		} else if (knowledge?.status === "unavailable" && ctx.hasUI) {
			const choice = await askUser(ctx, `Judge passed, knowledge not checked: ${knowledge.reason}`, ["Commit anyway", "Stop"]);
			if (choice !== "Commit anyway") {
				passStopped = true;
				return false;
			}
		}

		const seed = branchName(cfg.delivery.branchPrefix, stage?.title || planTitle(state.approvedPlan), new Date());
		const deviations = knowledge ? deviationBlock(knowledge.deviations) : "";
		const { pending, instruction } = await prepareAllRepos(ctx, diff, chosen, seed, deviations);
		state.commitPending = pending;

		await sendCommitStep(ctx, hash, report, instruction, chosen);
		return true;
	}

	/** Marks the commit stage and sends the commit step's instruction, in a subagent or the main session. */
	async function sendCommitStep(ctx: ExtensionContext, hash: string, report: string | undefined, instruction: string, chosen: Delivery): Promise<void> {
		view.stage = "commit";
		view.changed();
		markPassSummarized(hash); // the commit run's end summarizes this flow
		persist();
		if (cfg.delivery.runner === "subagent") {
			await commitInSubagent(ctx, report, instruction, chosen);
			return;
		}
		handover("workflow-commit", report ? `${report}

${instruction}` : instruction);
	}

	/** The executor committed the judged change itself: carry on with the flow's delivery from that commit. False when this is not that case. */
	async function deliverSelfCommit(ctx: ExtensionContext): Promise<boolean> {
		const judged = state.lastJudge;
		const hash = state.passedDiff;
		if (!hash || !judged || judged.hash !== hash || judged.verdict !== "PASS" || !judged.repos) return false;
		const refs = await flowRepos(ctx);
		const now: Record<string, { head: string; tree: string }> = {};
		const read = await Promise.all(refs.map((ref) => Promise.all([git(ref.dir, "rev-parse", "HEAD"), git(ref.dir, "rev-parse", "HEAD^{tree}")])));
		refs.forEach((ref, i) => {
			const [head, tree] = read[i];
			if (head.code === 0 && tree.code === 0) now[repoKey(ref.root)] = { head: head.stdout.trim(), tree: tree.stdout.trim() };
		});
		const handled = committedDiffs.has(hash) || !!state.summarizedPasses?.includes(hash) || !!state.commitPending;
		if (!selfCommitted(hash, judged, now, handled)) return false;

		const staged = currentStages();
		const chosen = stageDelivery(state.delivery ?? defaultDelivery(), staged?.stages[staged.current - 1]);
		if (chosen === "off") {
			await summarizePass(ctx, hash);
			return true;
		}
		committedDiffs.add(hash);
		ctx.ui.notify("workflow: the executor committed the change itself; continuing with delivery", "info");

		const multi = !(refs.length === 1 && refs[0].dir === ctx.cwd);
		const moved: { root: string; mode: Exclude<Delivery, "off">; head: string; branch: string; prBefore?: number; pushSkipped?: string }[] = [];
		for (const ref of refs) {
			const key = repoKey(ref.root);
			const before = judged.repos[key];
			if (!before || now[key]?.head === before.head) continue;
			const branch = (await git(ref.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
			const unsafe = !branch || branch === "HEAD" || cfg.protectedBranches.includes(branch);
			let mode = chosen;
			let prBefore: number | undefined;
			let pushSkipped: string | undefined;
			if (unsafe) {
				mode = "commit";
				if (chosen !== "commit") pushSkipped = pushSkipReason(branch);
				if (chosen !== "commit") ctx.ui.notify(`workflow${multi ? ` [${ref.root}]` : ""}: the executor committed on ${branch && branch !== "HEAD" ? branch : "a detached HEAD"} itself; push and open the pull request by hand`, "warning");
			} else if (mode === "pr" || mode === "merge") {
				const old = await prState(ref.dir, branch);
				if (old && old.state !== "OPEN") prBefore = old.number;
			}
			moved.push({ root: ref.root, mode, head: before.head, branch, prBefore, pushSkipped });
		}
		if (moved.length === 0) return false;
		const first = moved[0];
		state.commitPending = multi
			? { mode: first.mode, head: first.head, branch: first.branch, prBefore: first.prBefore, pushSkipped: first.pushSkipped, repos: moved.map((m) => ({ root: m.root, mode: m.mode, head: m.head, branch: m.branch, prBefore: m.prBefore, pushSkipped: m.pushSkipped })) }
			: { mode: first.mode, head: first.head, branch: first.branch, prBefore: first.prBefore, pushSkipped: first.pushSkipped };
		if (moved.every((m) => m.mode === "commit")) {
			markPassSummarized(hash);
			persist();
			await summarizeCommit(ctx);
			return true;
		}
		const options = (m: (typeof moved)[number]): DeliveryOptions => ({
			mode: m.mode,
			branch: m.branch,
			base: cfg.delivery.base,
			split: false,
			mergeMethod: cfg.delivery.mergeMethod,
			deleteBranch: cfg.delivery.deleteBranch,
			deviations: "",
			committed: true,
			pushSkipped: m.pushSkipped,
		});
		const instruction = multi ? repoDeliveryInstruction(moved.map((m) => ({ root: m.root, options: options(m) }))) : deliveryInstruction(options(first));
		await sendCommitStep(ctx, hash, `**Judge: PASS**

${judged.text}`, instruction, chosen);
		return true;
	}

	/** Runs the commit step in a fresh subagent with its own push guard; returns its report (or the failure) as text. */
	async function runCommitSubagent(ctx: ExtensionContext, instruction: string, chosen: Delivery, pending: FlowState["commitPending"], signal?: AbortSignal): Promise<string> {
		commitSubagentRunning = true;
		let result: RunResult;
		try {
			const multi = (state.folders?.length ?? 0) > 0 || (state.touchedRepos?.length ?? 0) > 0;
			const spec: CommitGuardSpec = {
				protectedBranches: cfg.protectedBranches,
				roots: multi ? (await flowRepos(ctx)).map((r) => r.root) : [],
				mode: pending?.mode,
				repos: (pending?.repos ?? []).map((r) => ({ root: r.root, mode: r.mode })),
			};
			ctx.ui.setWorkingMessage("commit step running…");
			const ran = await runRole("commit", DELIVERY_LABELS[chosen], {
				systemPrompts: [prompts.COMMIT, commitExcerpt()],
				tools: ["bash"],
				task: instruction,
				cwd: ctx.cwd,
				signal,
				env: { [COMMIT_GUARD_ENV]: JSON.stringify(spec) },
				extensions: [COMMIT_GUARD_EXTENSION],
			});
			result = ran.result;
			if (result.ok) view.finish(ran.run, true, "report ready");
		} finally {
			commitSubagentRunning = false;
			ctx.ui.setWorkingMessage();
		}
		return result.ok ? result.text : `failed: ${result.error}`;
	}

	/** Runs the commit step in a fresh subagent with its own push guard, then reads the outcome from git and gh. */
	async function commitInSubagent(ctx: ExtensionContext, report: string | undefined, instruction: string, chosen: Delivery): Promise<void> {
		if (report) pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
		if (!fs.existsSync(COMMIT_GUARD_EXTENSION)) {
			pi.sendMessage({ customType: "workflow-commit", content: `**Commit step** failed: commit guard extension not found at ${COMMIT_GUARD_EXTENSION}`, display: true }, { triggerTurn: false });
			if (state.commitPending) await summarizeCommit(ctx);
			resetCommitStage();
			return;
		}
		const text = await runCommitSubagent(ctx, instruction, chosen, state.commitPending);
		pi.sendMessage({ customType: "workflow-commit", content: `**Commit step** (${describeRole(cfg.roles.commit)})\n\n${text}`, display: true }, { triggerTurn: false });
		if (state.commitPending) await summarizeCommit(ctx);
		resetCommitStage();
	}

	function resetCommitStage(): void {
		if (view.stage !== "commit") return;
		view.stage = phaseStage();
		view.changed();
	}

	/** `name`, or `name-2`, `name-3`, ... when a local branch already has it. */
	async function freeBranchName(cwd: string, name: string): Promise<string> {
		for (let n = 1; n < 100; n++) {
			const candidate = n === 1 ? name : `${name}-${n}`;
			if ((await git(cwd, "rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`)).code !== 0) return candidate;
		}
		return `${name}-${Date.now()}`;
	}

	/** Folders from --add-dir join the session's list (existing folders only, no repeats, not the working folder). */
	function applyAddDir(ctx: ExtensionContext): void {
		const wanted = parseAddDir(pi.getFlag("add-dir"));
		if (wanted.length === 0) return;
		const folders = [...(state.folders ?? [])];
		let changed = false;
		for (const w of wanted) {
			const abs = path.resolve(ctx.cwd, w).replace(/\\/g, "/");
			const key = repoKey(abs);
			let ok = false;
			try {
				ok = fs.statSync(abs).isDirectory();
			} catch {
				// not there
			}
			if (!ok) ctx.ui.notify(`workflow: --add-dir ${w}: not a folder, skipped`, "warning");
			else if (key === repoKey(ctx.cwd)) ctx.ui.notify(`workflow: --add-dir ${w}: that is the working folder, skipped`, "warning");
			else if (!folders.some((f) => repoKey(f) === key)) {
				folders.push(abs);
				changed = true;
			}
		}
		if (!changed) return;
		state.folders = folders;
		persist();
		publishFolders(ctx);
	}

	/** K1b: after the session moved to another checkout of the same projects, added folders move to the matching checkouts next to the working folder. */
	async function followWorkingFolder(ctx: ExtensionContext): Promise<void> {
		const folders = state.folders ?? [];
		if (!folders.length) return;
		const newest = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === FOLDERS_ENTRY)
			.pop() as { data?: { cwd?: unknown } } | undefined;
		const prev = newest?.data?.cwd;
		if (typeof prev !== "string" || repoKey(prev) === repoKey(ctx.cwd)) return;
		const top = await gitRoot(ctx.cwd);
		if (!top) return;
		const infos = new Map<string, { top: string; worktrees: string[] }>();
		for (const f of folders) {
			const t = await gitRoot(f);
			if (!t) continue;
			const r = await git(t, "worktree", "list", "--porcelain");
			if (r.code === 0) infos.set(repoKey(f), { top: t, worktrees: parseWorktreeList(r.stdout) });
		}
		const res = followFolders(folders, ctx.cwd.replace(/\\/g, "/"), top, (f) => infos.get(repoKey(f)) ?? null, (p) => fs.existsSync(p));
		if (!res.changes.length && res.folders.length === folders.length) return;
		state.folders = res.folders;
		persist();
		for (const c of res.changes) ctx.ui.notify(`workflow: added folders follow the working folder: ${c.from} \u2192 ${c.to}`, "info");
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload") metrics.clear();
		const loaded = loadConfig();
		cfg = loaded.config;
		configError = loaded.error;
		if (configError) ctx.ui.notify(`workflow: bad config, using defaults: ${configError}`, "error");
		ghReady = ensureGh(ctx).catch(() => false);

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
			if (state.phase === "plan" || state.phase === "test") blockPlanTools(state.phase);
			if (event.reason !== "reload") {
				await followWorkingFolder(ctx);
				// --add-dir is a launch flag: only the first session of the process applies it, not a later switch or resume.
				if (event.reason === "startup") applyAddDir(ctx);
				publishFolders(ctx);
			}
			updateStatus(ctx);
			if (state.phase === "execute" && state.waiting) startWaitTimer();
			if (event.reason !== "reload") void planHousekeeping(ctx);
			// Rewrites the plan file, which also (re)starts this session's claim on an unfinished flow.
			if (state.planDoc && !state.planDoc.finished && state.approvedPlan) planMilestone(ctx, undefined, false);
			return;
		}
		if (event.reason === "reload") return;

		const flag = pi.getFlag("flow");
		const start = (typeof flag === "string" && ["plan", "execute", "test", "off"].includes(flag) ? flag : cfg.startPhase) as Phase;
		state = { phase: "off", escalated: false, judgeRounds: 0 };
		view.used = emptyStageTokens();
		view.flow = emptyFlowUsage();
		view.flowStarted = undefined;
		applyAddDir(ctx);
		publishFolders(ctx);
		if (start !== "off") await setPhase(ctx, start);
		else updateStatus(ctx);
		if (start === "test" && ctx.hasUI) ctx.ui.notify(`workflow: test phase on ${describeRole(cfg.roles.test)}; describe what to test`, "info");
		void planHousekeeping(ctx);
	});

	// K2: a session that is executing an approved plan is not switched away from.
	pi.on("session_before_switch", async (_event, ctx) => {
		if (!((state.phase === "execute" && state.approvedPlan) || (state.phase === "test" && state.testFlow))) return;
		ctx.ui.notify("workflow: a flow is executing; finish it or leave it with /flow off before switching sessions", "warning");
		return { cancel: true };
	});

	pi.on("session_shutdown", async () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
		stopWaitTimer();
		const dir = claimedFlow ? planDirs.get(claimedFlow) : undefined;
		if (dir && claimedFlow) dropClaim(dir, claimedFlow);
		stopClaimTimer();
		stopLiveTimer();
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
		{ value: "test", label: "test [scope] - test phase: a strong supervisor sends cheap runners and reports bugs" },
		{ value: "off", label: "off - leave the workflow; model stays as is" },
		{ value: "escalate", label: "escalate - switch to the escalate model (Fable)" },
		{ value: "back", label: "back - return to the phase's own model" },
		{ value: "judge", label: "judge - review the current diff now" },
		{ value: "tokens", label: "tokens - token breakdown of the current flow so far" },
		{ value: "model", label: "model [role] [provider/id[:thinking]] - set a role's model (lists when left out)" },
		{ value: "autopilot", label: "autopilot [on|off] - resolve waits and routine menus without asking (no argument toggles)" },
		{ value: "reload", label: "reload - re-read workflow.json" },
		{ value: "resume", label: "resume [flowId] - pick up an unfinished flow from its plan ref (e.g. on another device)" },
	];

	function statusText(): string {
		const lines = [
			`phase      ${state.phase}${state.escalated ? " (escalated)" : ""}`,
			`judge     ${state.judgeRounds} failed round(s); auto=${cfg.autoJudge}; then ${DELIVERY_LABELS[state.delivery ?? defaultDelivery()]}${state.delivery ? "" : " (default)"}`,
			...(state.testFlow ? [`test flow  round ${state.testFlow.round}, fix rounds ${normalize(state.testFlow).fixRounds}, fixed ${normalize(state.testFlow).fixed.length}, open ${openBugs(state.testFlow).length}, pending questions ${normalize(state.testFlow).pending.length}`] : []),
			...(currentStages() ? [`stage     ${currentStages()!.current} of ${currentStages()!.stages.length}: ${currentStages()!.stages[currentStages()!.current - 1].title}`] : []),
			state.planFlaw === "auto" ? "flaws     arbiter (this flow)" : `flaws     ${cfg.planFlaw === "auto" ? "arbiter" : "ask"} (config)`,
			`autopilot ${autopilotOn() ? "on" : "off"} (${autopilotOverride === undefined ? "config" : "session"})`,
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

	pi.registerCommand("folders", {
		description: "Folders that are part of this session: add PATH, remove PATH or N, list",
		getArgumentCompletions: (prefix) => {
			const addM = prefix.match(/^add\s+(.*)$/i);
			if (addM) {
				const readDirs = (dir: string): string[] | null => {
					try {
						return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
					} catch {
						return null;
					}
				};
				const items = pathCompletions(addM[1], lastCtx?.cwd ?? process.cwd(), os.homedir(), readDirs).map((p) => ({ value: `add ${p.includes(" ") ? `"${p}"` : p}`, label: p }));
				return items.length > 0 ? items : null;
			}
			const remM = prefix.match(/^remove\s+(.*)$/i);
			if (remM) {
				const typed = remM[1].trim().toLowerCase();
				const items = (state.folders ?? [])
					.map((f, i) => ({ value: `remove ${i + 1}`, label: `${i + 1}. ${f}`, f, n: String(i + 1) }))
					.filter((x) => x.n.startsWith(typed) || x.f.toLowerCase().startsWith(typed))
					.map(({ value, label }) => ({ value, label }));
				return items.length > 0 ? items : null;
			}
			const matches = ["add", "remove", "list"].filter((c) => c.startsWith(prefix.trim())).map((c) => ({ value: c, label: c }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const m = args.trim().match(/^(\S+)\s*([\s\S]*)$/);
			const sub = (m?.[1] ?? "list").toLowerCase();
			const arg = (m?.[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
			const folders = state.folders ?? [];
			if (sub === "list") {
				const lines = [`working folder  ${ctx.cwd}`];
				for (const [i, f] of folders.entries()) {
					const note = !fs.existsSync(f) ? " (missing)" : (await gitRoot(f)) ? "" : " (not a git repo)";
					lines.push(`${i + 1}. ${f}${note}`);
				}
				for (const t of state.touchedRepos ?? []) lines.push(`   ${t} (edited in this flow)`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub !== "add" && sub !== "remove") {
				ctx.ui.notify("Usage: /folders add PATH | remove PATH or N | list", "warning");
				return;
			}
			if (!arg) {
				ctx.ui.notify(`Usage: /folders ${sub} ${sub === "remove" ? "PATH or N" : "PATH"}`, "warning");
				return;
			}
			if (sub === "add") {
				const abs = path.resolve(ctx.cwd, arg).replace(/\\/g, "/");
				let isDir = false;
				try {
					isDir = fs.statSync(abs).isDirectory();
				} catch {
					// not there
				}
				if (!isDir) {
					ctx.ui.notify(`workflow: ${abs} is not a folder`, "warning");
					return;
				}
				if (repoKey(abs) === repoKey(ctx.cwd)) {
					ctx.ui.notify("workflow: that is already the working folder", "warning");
					return;
				}
				if (folders.some((f) => repoKey(f) === repoKey(abs))) {
					ctx.ui.notify(`workflow: ${abs} is already added`, "warning");
					return;
				}
				const answer = await askFolderAdd((d) => pi.events.emit("workflow:folder-add", d), ctx.cwd.replace(/\\/g, "/"), abs);
				if ("error" in answer) {
					ctx.ui.notify(`workflow: ${abs} not added: ${answer.error}`, "error");
					return;
				}
				let final = abs;
				if (repoKey(answer.folder) !== repoKey(abs)) {
					final = path.resolve(ctx.cwd, answer.folder).replace(/\\/g, "/");
					let finalIsDir = false;
					try {
						finalIsDir = fs.statSync(final).isDirectory();
					} catch {
						// not there
					}
					if (!finalIsDir) {
						ctx.ui.notify(`workflow: ${final} is not a folder`, "warning");
						return;
					}
					if (repoKey(final) === repoKey(ctx.cwd)) {
						ctx.ui.notify("workflow: that is already the working folder", "warning");
						return;
					}
				}
				const current = state.folders ?? [];
				if (current.some((f) => repoKey(f) === repoKey(final))) {
					ctx.ui.notify(`workflow: ${final} is already added`, "warning");
					return;
				}
				state.folders = [...current, final];
				persist();
				publishFolders(ctx);
				updateStatus(ctx);
				ctx.ui.notify(final === abs ? `workflow: added ${abs}; reloading` : `workflow: added ${final} (for ${abs}); reloading`, "info");
			} else {
				const n = /^\d+$/.test(arg) ? Number(arg) - 1 : -1;
				const i = n >= 0 ? n : folders.findIndex((f) => repoKey(f) === repoKey(path.resolve(ctx.cwd, arg)));
				if (i < 0 || i >= folders.length) {
					const touched = (state.touchedRepos ?? []).some((t) => repoKey(t) === repoKey(path.resolve(ctx.cwd, arg)));
					ctx.ui.notify(touched ? "workflow: that repo was edited in this flow; it leaves when the flow ends" : `workflow: ${arg} is not in the folder list`, "warning");
					return;
				}
				const [gone] = folders.splice(i, 1);
				state.folders = folders;
				persist();
				publishFolders(ctx);
				updateStatus(ctx);
				ctx.ui.notify(`workflow: removed ${gone}; reloading`, "info");
			}
			await ctx.waitForIdle();
			await ctx.reload();
		},
	});

	pi.registerCommand("flow", {
		description: "Plan -> execute -> judge workflow with a model per role",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.trimStart().split(/\s+/);
			if (parts[0] === "model" && parts.length === 2) {
				return ROLES.filter((r) => r.startsWith(parts[1])).map((r) => ({ value: `model ${r} `, label: `${r} (${describeRole(cfg.roles[r])})` }));
			}
			if (parts[0] === "model" && parts.length === 3 && ROLES.includes(parts[1] as Role)) {
				try {
					const items = modelChoices(lastCtx?.modelRegistry.getAvailable() ?? [], cfg.roles[parts[1] as Role]?.model)
						.filter((c) => c.value.toLowerCase().startsWith(parts[2].toLowerCase()))
						.slice(0, 50)
						.map((c) => ({ value: `model ${parts[1]} ${c.value}`, label: c.label }));
					return items.length > 0 ? items : null;
				} catch {
					return null;
				}
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
				case "test": {
					const scope = rest.join(" ").trim();
					if (state.testFlow || (state.phase === "execute" && state.approvedPlan && !state.flowSummarized)) {
						ctx.ui.notify("workflow: a flow is running; finish it or leave it with /flow off first", "warning");
						return;
					}
					await setPhase(ctx, "test");
					if (!scope) {
						ctx.ui.notify(`workflow: test phase on ${describeRole(cfg.roles.test)}; describe what to test`, "info");
						return;
					}
					await startTestFlow(ctx, scope);
					ctx.ui.notify(`workflow: testing on ${describeRole(cfg.roles.test)}, runners on ${describeRole(cfg.roles.runner)}`, "info");
					pi.sendMessage(
						{ customType: "workflow-test", content: `Test this: ${scope}\n\nPlan the tests, send runners with test_run, and end with the test report. Next free ID: S1.`, display: true },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
					return;
				}
				case "approve":
					if (state.phase === "test") {
						ctx.ui.notify("workflow: approve is not used in the test phase", "info");
						return;
					}
					await approve(ctx);
					return;
				case "resume":
					await resumeFlow(ctx, rest[0]);
					return;
				case "autopilot": {
					const arg = rest[0]?.toLowerCase();
					if (arg !== undefined && arg !== "on" && arg !== "off") {
						ctx.ui.notify("usage: /flow autopilot [on|off]", "warning");
						return;
					}
					autopilotOverride = arg === undefined ? !autopilotOn() : arg === "on";
					updateStatus(ctx);
					ctx.ui.notify(`workflow: autopilot ${autopilotOn() ? "on" : "off"} (session)`, "info");
					return;
				}
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
					if (state.phase === "test") {
						ctx.ui.notify("workflow: judge is not used in the test phase", "info");
						return;
					}
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
					let [role, spec] = rest;
					const usage = () => ctx.ui.notify(`Usage: /flow model <${ROLES.join("|")}> <provider/id[:thinking]>`, "warning");
					if (!role && ctx.hasUI) {
						const pick = await ctx.ui.select("Role", ROLES.map((r) => `${r} (${describeRole(cfg.roles[r])})`));
						if (!pick) return;
						role = pick.split(" ")[0];
					}
					if (!role || !ROLES.includes(role as Role)) {
						usage();
						return;
					}
					if (!spec && !ctx.hasUI) {
						usage();
						return;
					}
					let parsed: ReturnType<typeof parseRoleSpec> | undefined;
					if (spec) {
						parsed = parseRoleSpec(spec);
					} else {
						const current = cfg.roles[role as Role];
						let choices: ReturnType<typeof modelChoices> = [];
						try {
							choices = modelChoices(ctx.modelRegistry.getAvailable(), current?.model);
						} catch {}
						const typeOwn = "Type a model ID…";
						const pick = choices.length > 0 ? await ctx.ui.select(`Model for ${role}`, [...choices.map((c) => c.label), typeOwn]) : typeOwn;
						if (!pick) return;
						if (pick === typeOwn) {
							const input = await ctx.ui.input(`Model for ${role}`, describeRole(current));
							if (!input) return;
							parsed = parseRoleSpec(input);
						} else {
							const model = choices.find((c) => c.label === pick)!.value;
							const keep = `keep (${current?.thinking ?? "default"})`;
							const level = await ctx.ui.select(`Thinking for ${model}`, [keep, ...THINKING_LEVELS]);
							if (!level) return;
							parsed = level === keep ? (current?.thinking ? { model, thinking: current.thinking } : { model }) : { model, thinking: level as Thinking };
						}
					}
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
