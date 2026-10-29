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
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
import { handoverAction, afterPass, noChangeStage, arbiterFirst, fixableFindings, canApprove, hasPlanFlaw, planFlawLines, planFlawOnPass, hasPlanLine, isPlanReady, judgeCapReached, minorFixOpen, passPending, stageEndAction, parseArbiter, phaseAfterFlow, shouldResume, skipJudge } from "./agent-end.ts";
import { countTokens, type Tok } from "./tokens.ts";
import { idleReason, notifyCommand, notifyDue } from "./notify.ts";
import * as prompts from "./prompts.ts";
import { planTitle } from "./delivery.ts";
import { modelChoices, pathCompletions } from "./pickers.ts";
import { ghCandidates, withPathDir } from "./gh-path.ts";
import { citeNames, collectRepoDiff as collectRepoDiffImpl, needsFinalFullReview, shouldSkipRepeatFullReview, type RepoDiff } from "./repo-diff.ts";
import { GIT_GUARD_ENV, type GitGuardSpec } from "./git-guard.ts";
import { forkBase, mergedInStage, baseFromTree, defaultRunner, recordJudged, gateCheck, mergedBase, noMerge } from "./merge-gate.ts";
import { combineRepoTexts, followFolders, parseAddDir, parseWorktreeList, repoKey, uniqueRoots } from "./repos.ts";
import { askFolderAdd } from "./folder-add.ts";
import { codePublishProblem, registryPublishCodeProblem, registryPublishProblem, shellProblem } from "./push-guard.ts";
import { blockedWaitCheck, classifyPublish, lockDecision, lockWaitCheck, NO_JUDGED_MERGE, waitSince, mirrorArgs, parseMirrorStep, parsePublishStep, publishArgs } from "./registry-publish.ts";
import { RUNNER_GUARD_ENV, type RunnerGuardSpec } from "./runner-guard.ts";
import { parseTestReport } from "./test-report.ts";
import { amendmentTail, answerItem, askOptions, bodyField, manualChecks, newTestFlow, nextAction, normalize, openBugs, pendingFromFlaws, recordReport, skipItem, testOutcome, testPlan, type TestFlow } from "./test-flow.ts";
import { callDir, formatTaskResult, parseRunnerReply, runnerGate, sanitizeIds, scheduleTasks, taskCard, taskRecord, type TestTask, verifyRun } from "./test-run.ts";
import { type Finished, mergeChecklist, newFlowId, isHuman, openStepsReminder, parseChecklist, type PlanStatus, planCard, pruneIds, renderPlanFile, splitPlanFile, type ChecklistItem } from "./plan-doc.ts";
import { addToRegistry, type BoardEntry, boardLines, boardRows, detailLines, liveEvents, type LiveInfo, readLive, readRegistry } from "./board.ts";
import { adoptHigher, claimLive, commitRef, dropClaim, pidAlive, readClaim, writeClaim, deleteLocal, deleteRef, deleteReviewRef, fetchMirror, type Git, listRefs, plansDir, pushRef, readLocalStatuses, readPlanMd, refRev, remoteOf, repoInfo, type RefEntry, sweepReviewRefs, writeLocal, writeReviewRef } from "./plan-store.ts";
import { type FlowFinding, recordFindings, reportFindings, type ReportStep } from "./flow-report.ts";
import { readOnlyProblem } from "./readonly-bash.ts";
import { checkpointAmendment, checkpointNote, checkpointOutcome, deliverHint, deliverHintsBlock, deliverStepSpec, hasCheckpointAmendment, checkpointText, isPlannedTag, parseDeliverStep, publishRefusal, withCheckpoints } from "./checkpoints.ts";
import { pushArgs, tagDecision } from "./tags.ts";
import { type CheckVerdict, autopilotAmendment, autopilotReply, checkTitle, checkVerdict, cleanCheck, waitCheckProblem, type HumanCheck, humanChecks, parseVerifyStep, parseWaitStep, pollDecision, resumePrefix, verifyAmendment, waitAmendment } from "./waits.ts";
import { nextStage, parseStages, planWaitProblems, stageLine, stageNote, stageStart, stagesOutcome } from "./stages.ts";
import { planToolProblem, planToolRefused } from "./readonly-tools.ts";
import { refilterPlanTools } from "./plan-tools.ts";
import { MetricsQueue, type MetricEvent, subagentMetric } from "./metrics.ts";
import { addUsage, emptyUsage, mapLimit, noContextFilesFor, type RunResult, runSubagent } from "./subagent.ts";
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

type Phase = "off" | "discuss" | "plan" | "execute" | "test";

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
	/** The last full review that passed in this stage. */
	lastFullPass?: { repos: Snaps; base: string };
	/** Active tools before plan mode switched some off. */
	toolsBeforePlan?: string[];
	/** Tokens spent per pipeline stage this session. */
	tokens?: Record<Stage, Tok>;
	/** "both": each count holds the raw total and the cost-weighted one. Counts saved before that are dropped. */
	tokenUnit?: "both";
	/** The current flow's breakdown, until its summary is shown. */
	flow?: FlowUsage;
	flowStarted?: number;
	/** Plan flaws go straight to the arbiter in this flow, chosen at approval; unset means `cfg.planFlaw`. */
	planFlaw?: "auto";
	/** Passed diffs whose flow already ended (or will, at the stage's end). */
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
	/** Per repo key: the commit the judge diffs from. It starts at HEAD when the flow starts executing and moves up when a stage passes (and when the base branch is merged in), so commits made meanwhile do not change what the judge sees. */
	reviewBase?: Record<string, string>;
	/** Per repo key: the worktree trees of every judge pass in this flow. A merge, a push to a protected branch and a publish need the tree they act on to be among them. */
	passedTrees?: Record<string, string[]>;
	/** Per repo key: the judged merge (a pull request or a pushed commit) that a Publish step reads package versions from. */
	judgedMerges?: Record<string, { pr?: string; commit?: string; tree: string; stage?: number }>;
	/** The pass hash for which the executor was reminded of open steps. */
	stageNudgedFor?: string;
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
/** The judge reads at most this much of the plan; the end (the arbiter's amendments) is kept. */
const MAX_PLAN_CHARS = 60_000;
const OWN_TOOLS = new Set(["explore", "advisor", "judge"]);
const EXPLORE_REASONS = ["question", "broad_search", "timeout", "too_much_output", "location_unknown", "parallel_lookups"] as const;
const execFileAsync = promisify(execFile);
/** Subagent-only extension that registers forwarded MCP servers (see mcp-forward.ts). */
const FORWARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "workflow", "mcp-forward.ts");
/** Subagent-only extension that guards the git_task subagent's git and gh commands (see git-guard.ts). */
const GIT_GUARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "workflow", "git-guard.ts");
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
	/** The final plan's broken wait checks were already sent back to the planner once for this approval. */
	let finalizeWaitRetried = false;
	/** A planner reply in the current plan discussion had a plan line; with planRecap "changes" a typed "go" then approves later replies without one. Reset when the phase changes. */
	let planProposed = false;
	/** The planner's last finished reply, kept as the approved plan when finalizePlan is off. */
	let lastPlanText = "";
	let guardTokens: number | null = null;
	let compacting = false;
	/** The guard threshold was crossed during a run; compact when the run settles. */
	let compactPending = false;
	/** A handover message (execute, fix round, next stage) sent from agent_end; it goes out when the run settles, after an optional compaction. */
	let pendingHandover: { customType: string; content: string } | undefined;
	let inAgentEnd = 0; // nesting depth: a run can end while a handler still waits on a subagent
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
				if (compacting || compactPending || pendingHandover) return scheduleIdleNotice(ctx);
				notifyUser(ctx, idleReason({ phase: state.phase, waiting: state.waiting?.reason }));
			} catch {}
		}, cfg.notify.idleMs);
		idleTimer.unref?.();
	}
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
		description: "Workflow phase to start in: discuss, plan, execute, test or off (default from workflow.json)",
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
	function summarizeFlow(outcome: string, ok: boolean, extra?: HumanCheck[]): boolean {
		const fromPlan = humanChecks(state.approvedPlan, state.checklist);
		const human = [...fromPlan, ...(extra ?? [])];
		if (fromPlan.length) outcome += ` · ${fromPlan.length} human check(s) for you (see the card)`;
		if ((state.unresolvedPlanFlaws ?? 0) > 0) outcome += ` · ${state.unresolvedPlanFlaws} plan flaw(s) not settled (see the plan)`;
		state.unresolvedPlanFlaws = undefined;
		const steps: ReportStep[] | undefined = state.checklist?.some((c) => !isHuman(c)) ? state.checklist.filter((c) => !isHuman(c)).map((c) => ({ id: c.id, text: c.text, done: c.done })) : undefined;
		const found = reportFindings(state.flowFindings, state.approvedPlan);
		const findings = found.length ? found : undefined;
		const flowId = state.planDoc?.flowId;
		state.flowSummarized = true;
		state.flowFindings = undefined;
		if (state.planDoc && !state.planDoc.finished) planMilestone(undefined, { at: new Date().toISOString(), ok, text: outcome });
		state.touchedRepos = undefined;
		view.settleMain();
		if (!view.hasFlowUsage() && !steps && !findings && !human.length) {
			if (flowId) {
				const empty = view.peekFlow(outcome, ok);
				recordMetric({ kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: empty.started, ended: empty.ended, stages: empty.stages });
			}
			persist();
			return false;
		}
		const summary = view.endFlow(outcome, ok);
		pi.appendEntry(SUMMARY_ENTRY, { ...summary, steps, findings, ...(human.length ? { humanChecks: human } : {}) });
		if (flowId) recordMetric({ kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: summary.started, ended: summary.ended, stages: summary.stages });
		persist();
		return true;
	}

	/** A flow has ended: on to the phase `returnTo` names. */
	async function endFlow(ctx: ExtensionContext): Promise<void> {
		notifyUser(ctx, "flow finished");
		await dropReviewRefs(ctx);
		state.reviewBase = undefined;
		state.passedTrees = undefined;
		state.judgedMerges = undefined;
		state.waiting = undefined;
		stopWaitTimer();
		if (state.testFlow) {
			state.testFlow = undefined;
			state.planFlaw = undefined;
			persist();
		}
		updateStatus(ctx);
		const next = phaseAfterFlow(cfg.returnTo, state.phase);
		if (!next) return;
		await setPhase(ctx, next);
		ctx.ui.notify(`workflow: flow done, back to ${next === "discuss" ? "discussion" : "planning"} on ${describeRole(cfg.roles[next])}`, "info");
	}

	function updateStatus(ctx: ExtensionContext): void {
		lastCtx = ctx;
		view.roles = cfg.roles;
		view.weights = cfg.tokenWeights;
		view.phase = state.phase;
		view.escalated = state.escalated;
		if (state.phase === "discuss") view.stage = "discuss";
		else if (state.phase === "plan") view.stage = "plan";
		else if (state.phase === "test") view.stage = "test";
		else if (view.stage === "discuss" || view.stage === "plan" || view.stage === "test") view.stage = "execute";
		if (ctx.hasUI) view.mount(ctx.ui);
		const n = existingFolders().length + (state.touchedRepos?.length ?? 0);
		const cl = state.checklist;
		if (ctx.hasUI) ctx.ui.setStatus("workflow-plan", cl?.length && state.phase === "execute" ? `plan ${cl.filter((i) => !isHuman(i) && i.done).length}/${cl.filter((i) => !isHuman(i)).length}` : undefined);
		if (ctx.hasUI) ctx.ui.setStatus("workflow-wait", state.waiting && state.phase === "execute" ? `waiting: ${state.waiting.reason.slice(0, 40)}` : undefined);
		if (ctx.hasUI) ctx.ui.setStatus("workflow-autopilot", autopilotOn() ? "autopilot" : undefined);
		if (ctx.hasUI) ctx.ui.setStatus("workflow-folders", n ? `+${n} folder${n === 1 ? "" : "s"}` : undefined);
		if (state.approvedPlan && cl?.length && (state.phase === "execute" || state.phase === "test")) {
			const st = currentStages();
			const open = cl.find((i) => !i.done && !isHuman(i));
			view.progress = {
				...(st ? { stage: st.current, stages: st.stages.length } : {}),
				done: cl.filter((i) => !isHuman(i) && i.done).length,
				total: cl.filter((i) => !isHuman(i)).length,
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
		pi.setActiveTools(state.toolsBeforePlan.filter((t) => !planToolRefusedIn(phase, t)));
	}

	function planToolRefusedIn(phase: "plan" | "test", name: string): boolean {
		const allowed = phase === "test" ? testAllowedTools() : planAllowedTools();
		const blocked = phase === "test" ? testBlockedTools() : cfg.planBlockedTools;
		return planToolRefused(name, allowed, blocked) !== null;
	}

	/** Tools that registered after the phase began (an MCP server that connected late) get the same filter. */
	function refilterTools(): void {
		if ((state.phase !== "discuss" && state.phase !== "plan" && state.phase !== "test") || !state.toolsBeforePlan) return;
		const phase = state.phase === "test" ? "test" : "plan";
		try {
			refilterPlanTools(pi, state.toolsBeforePlan, (t) => planToolRefusedIn(phase, t));
		} catch {
			// the turn goes on with the tools it has
		}
	}

	function testAllowedTools(): RegExp[] {
		return [...planAllowedTools(), /^test_run$/];
	}

	function testBlockedTools(): string[] {
		return [...cfg.planBlockedTools, "judge", "plan_check", "wait_for_user", "deliver"];
	}

	/** The widget stage the main session is in. */
	function phaseStage(): Stage {
		return state.phase === "discuss" ? "discuss" : state.phase === "plan" ? "plan" : state.phase === "test" ? "test" : "execute";
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
			summarizeFlow(stoppedSummary(phase === "plan" ? "back to planning" : phase === "discuss" ? "back to discussion" : "abandoned"), false);
		}
		planReady = false;
		planProposed = false;
		const readOnly = (p: Phase) => p === "discuss" || p === "plan" || p === "test";
		// Discuss and plan share one tool set, so moving between them keeps the snapshot.
		const toolSet = (p: Phase) => (p === "test" ? "test" : "plan");
		if (phase !== state.phase && !(readOnly(state.phase) && readOnly(phase) && toolSet(state.phase) === toolSet(phase))) {
			if (readOnly(state.phase)) restorePlanTools();
			if (readOnly(phase)) blockPlanTools(toolSet(phase));
		}
		if (leavingFlow && state.planDoc && !state.planDoc.finished) planMilestone(ctx, { at: new Date().toISOString(), ok: false, text: "abandoned" });
		const leftTest = state.phase === "test";
		const samePhase = phase === state.phase; // a repeated setPhase keeps what the judge already passed
		if (leavingFlow) await dropReviewRefs(ctx);
		state.testFlow = undefined;
		state.phase = phase;
		state.escalated = false;
		state.judgeRounds = 0;
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.waiting = undefined;
		state.checkpoints = undefined;
		if (!samePhase) {
			state.reviewBase = undefined;
			state.passedTrees = undefined;
			state.judgedMerges = undefined;
			state.stageNudgedFor = undefined;
		}
		publishWaitSince.clear();
		stopWaitTimer();
		state.finalizing = undefined;
		state.planRevisions = undefined;
		state.pendingPlanFlaw = undefined;
		state.unresolvedPlanFlaws = undefined;
		state.touchedRepos = undefined;
		state.stage = undefined;
		state.stageJudged = undefined;
		state.stageOutcomes = undefined;
		if (phase === "discuss" || phase === "plan" || leftTest) {
			state.approvedPlan = undefined;
			state.checklist = undefined;
			state.planDoc = undefined;
			state.planFlaw = undefined;
		}
		consecutiveErrors = 0;
		if (phase === "execute" && !(samePhase && state.reviewBase)) await initReviewBase(ctx);
		if (phase !== "off") await applyRole(ctx, phase);
		persist();
		updateStatus(ctx);
	}

	function sendPlanKickoff(): void {
		pi.sendMessage({ customType: "workflow-plan-kickoff", content: prompts.PLAN_KICKOFF, display: true }, { triggerTurn: true, deliverAs: "followUp" });
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
		if (!stages.length) return deliverHintsText(undefined);
		ctx.ui.notify(`workflow: staged plan, ${stages.length} stages; stage 1: ${stages[0].title}`, "info");
		const first = stageStart(stages, 1);
		if (holdForStageWait(ctx, stages[0], first)) return `\n\nStage 1 waits for: ${stages[0].after?.reason}. Don't start it; end your turn now. The workflow sends you the stage when the wait is over.`;
		return `\n\n${first}${deliverHintsText(1)}`;
	}

	/** The stages of the approved plan and the current one, or null when the plan is not staged. */
	function currentStages() {
		const stages = state.stage ? parseStages(state.approvedPlan) : [];
		return stages.length && state.stage ? { stages, current: state.stage } : null;
	}

	/** The open Deliver steps of `stage` with the call each one makes, as text to append to a message ("" when there are none). */
	function deliverHintsText(stage: number | undefined): string {
		const block = deliverHintsBlock(state.approvedPlan ?? "", state.checklist, stage);
		return block ? `\n\n${block}` : "";
	}

	/** A refusal of a command the executor may not run. */
	function publishRefuse(problem: string): string {
		return publishRefusal(problem);
	}

	/** ` → call deliver …` for a Deliver step that names a tag, or "". */
	function deliverLine(id: string, stage: number | undefined): string {
		const spec = deliverStepSpec(state.approvedPlan ?? "", id);
		const hint = spec ? deliverHint(id, spec) : "";
		return hint ? ` ${hint}` : "";
	}

	async function approve(ctx: ExtensionContext, arbiterOnFlaw = false): Promise<void> {
		state.planFlaw = arbiterOnFlaw ? "auto" : undefined;
		if (cfg.finalizePlan) {
			// One more planner reply, the final execution plan, before the execute model starts.
			planReady = false;
			state.finalizing = true;
			finalizeWaitRetried = false;
			persist();
			pi.sendMessage({ customType: "workflow-finalize", content: prompts.finalize(cfg.delivery.splitCommits, cfg.stagedPlans), display: true }, { triggerTurn: true, deliverAs: "followUp" });
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
		const run = view.start(role, label, cfg.roles[role].model);
		onChange?.(run);
		const { thinking, extensions, timeoutMs, ...rest } = opts;
		const k = knowledgeFor(role);
		const started = Date.now();
		const result = await runSubagent({
			...rest,
			noContextFiles: noContextFilesFor(role, cfg.explore.contextFiles),
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

	/** One repo's diff, or null outside a git work tree. `baseKey` identifies the base(s) the diff was taken against. */
	async function collectDiff(cwd: string, base = "HEAD", baseKey = base): Promise<Diff | null> {
		const r = await collectRepoDiff(cwd, base);
		if (!r) return null;
		const root = (await gitRoot(cwd)) ?? cwd;
		return makeDiff(r.full, r.files, r.names, r.checkNames, baseKey, [{ root, dir: cwd, changed: r.full.length > 0 }], false);
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

	/** Every flow this machine's sessions have recently touched: registry dirs plus this session's repos. */
	async function collectBoard(ctx: ExtensionContext) {
		const dirs = new Set<string>(readRegistry(path.join(getAgentDir(), "workflow", "board.json")));
		try {
			dirs.add(await planDirFor(null));
			for (const r of await flowRepos(ctx)) dirs.add(await planDirFor(r.root));
		} catch {}
		const entries: BoardEntry[] = [];
		for (const dir of dirs) {
			if (!fs.existsSync(dir)) continue;
			for (const it of readLocalStatuses(dir)) entries.push({ flowId: it.flowId, dir, status: it.status, live: readLive(dir, it.flowId), mtime: it.mtime });
		}
		return boardRows(entries, Date.now(), os.hostname(), pidAlive);
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

	const goneBases = new Set<string>();

	/** The ref each repo's diff is taken against: `base` when given, else the repo's review base while executing, else HEAD. */
	async function diffBase(ctx: ExtensionContext, ref: RepoRef, base: string | undefined): Promise<string> {
		if (base) {
			// A base that exists only in the working folder's repo means HEAD in the others.
			if (ref.dir !== ctx.cwd && base !== "HEAD" && (await git(ref.dir, "rev-parse", "--verify", "--quiet", `${base}^{commit}`)).code !== 0) return "HEAD";
			return base;
		}
		if (state.phase === "execute" && !state.reviewBase?.[repoKey(ref.root)]) await joinReviewBase(ref.root, true);
		const review = state.phase === "execute" ? state.reviewBase?.[repoKey(ref.root)] : undefined;
		if (!review) return "HEAD";
		if ((await git(ref.dir, "rev-parse", "--verify", "--quiet", `${review}^{commit}`)).code === 0) return review;
		if (!goneBases.has(review)) {
			goneBases.add(review);
			ctx.ui.notify(`workflow: the review base of ${ref.root} is gone; reviewing from HEAD`, "warning");
		}
		return "HEAD";
	}

	/** The diff of every repo in this flow, each against its review base (or `base`). With only the working folder's repo it is exactly collectDiff(ctx.cwd). */
	async function collectFlowDiff(ctx: ExtensionContext, base?: string): Promise<Diff | null> {
		const refs = await flowRepos(ctx);
		if (refs.length === 0) return null;
		const bases = await Promise.all(refs.map((ref) => diffBase(ctx, ref, base)));
		const baseKey = refs.map((ref, i) => `${repoKey(ref.root)}=${bases[i]}`).join(";");
		if (refs.length === 1 && refs[0].dir === ctx.cwd) return collectDiff(ctx.cwd, bases[0], baseKey);
		const per = await mapLimit(refs, 4, async (ref) => collectRepoDiff(ref.dir, bases[refs.indexOf(ref)]));
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
		return makeDiff(combineRepoTexts(parts), files, names, checkNames, baseKey, repos, true);
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
		// Another base or another set of repos: the last round no longer lines up. Commits since do not matter: the delta is between trees.
		if (full || !cfg.judge.recheck || !prev?.repos || !snaps || prev.base !== diff.base) return fullPlan;
		const before = prev.repos;
		const keys = Object.keys(snaps);
		if (keys.length !== Object.keys(before).length || keys.some((k) => !before[k])) return fullPlan;
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
			const share = await repeatShare(diff, plan.snaps);
			if (share !== undefined) {
				r = { ...r, text: `${r.text}\n\nFinal full review skipped: a full review passed this stage and the changes since are ${Math.round(share * 100)}% of the diff.` };
			} else {
				const final = await judgeOnce(ctx, diff, focus, { kind: "full", snaps: plan.snaps }, signal, onChange, disputes);
				r = { ...final, usage: addUsage(addUsage(emptyUsage(), r.usage), final.usage) };
			}
		}
		// A pass that questions the plan is not a pass yet: resolvePlanFlaw decides.
		if (r.verdict === "PASS" && !hasPlanFlaw(r.text)) markPassed(diff.hash);
		return r;
	}

	/** The share of the diff changed since the last passing full review of this stage, when that is small enough to skip the final full review; else undefined. */
	async function repeatShare(diff: Diff, snaps: Snaps | undefined): Promise<number | undefined> {
		const pass = state.lastFullPass;
		if (!pass || !snaps || pass.base !== diff.base || diff.chars <= 0) return undefined;
		const keys = Object.keys(snaps);
		if (keys.length !== Object.keys(pass.repos).length || keys.some((k) => !pass.repos[k])) return undefined;
		const parts = await Promise.all(diff.repos.map((r) => git(r.dir, "diff", "--no-color", pass.repos[repoKey(r.root)]?.tree ?? "", snaps[repoKey(r.root)]?.tree ?? "")));
		if (parts.some((p) => p.code !== 0)) return undefined;
		const since = parts.reduce((n, p) => n + p.stdout.length, 0);
		return shouldSkipRepeatFullReview(since, diff.chars, cfg.judge.finalFullReviewRepeatMaxShare) ? since / diff.chars : undefined;
	}

	function markPassed(hash: string): void {
		state.passedDiff = hash;
		state.judgeRounds = 0;
		recordPassedTrees(hash);
		persist();
	}

	// ----------------------------------------------------------------------
	// Review base, passed trees and the judge gate
	// ----------------------------------------------------------------------

	/** Review-base refs written this session by repo key, so the end of the flow can delete them. */
	const reviewRefs = new Map<string, { dir: string; flowId: string }>();

	/** Remembers the trees of a judge pass: a merge, a push to a protected branch and a publish need the tree they act on to be one of them. */
	function recordPassedTrees(hash: string): void {
		const repos = state.lastJudge?.hash === hash ? state.lastJudge.repos : undefined;
		if (!repos) return;
		const all = { ...(state.passedTrees ?? {}) };
		for (const [k, v] of Object.entries(repos)) all[k] = [...(all[k] ?? []).filter((t) => t !== v.tree), v.tree].slice(-20);
		state.passedTrees = all;
	}

	/** Every repo of the flow starts its review at its HEAD. */
	async function initReviewBase(ctx: ExtensionContext): Promise<void> {
		const base: Record<string, string> = {};
		for (const r of await flowRepos(ctx)) {
			const head = await git(r.dir, "rev-parse", "HEAD");
			if (head.code === 0 && head.stdout.trim()) base[repoKey(r.root)] = head.stdout.trim();
		}
		state.reviewBase = Object.keys(base).length ? base : undefined;
	}

	/**
	 * A repo that joins the flow later reviews from its HEAD at that time. `lazy`: the join is only noticed now (a resumed flow, or a diff of a repo
	 * nobody announced), so commits may already exist: the base is then where the branch left the base branch, so they are reviewed too.
	 */
	async function joinReviewBase(root: string, lazy = false): Promise<void> {
		if (state.phase !== "execute") return;
		const key = repoKey(root);
		if (state.reviewBase?.[key]) return;
		let base = "";
		if (lazy) {
			const upstream = await upstreamBase(root);
			base = (upstream ? await forkBase(defaultRunner, root, upstream) : null) ?? "";
		}
		if (!base) {
			const head = await git(root, "rev-parse", "HEAD");
			if (head.code === 0) base = head.stdout.trim();
		}
		if (base) {
			state.reviewBase = { ...(state.reviewBase ?? {}), [key]: base };
			persist();
		}
	}

	/** Moves a repo's review base to `commit` and keeps that commit alive under the flow's ref. A failed ref write only warns: the base works until git collects it. */
	async function setReviewBase(ctx: ExtensionContext, ref: RepoRef, commit: string): Promise<void> {
		const key = repoKey(ref.root);
		state.reviewBase = { ...(state.reviewBase ?? {}), [key]: commit };
		const flowId = state.planDoc?.flowId;
		if (!flowId) return;
		if (await writeReviewRef(gitEnv, ref.dir, flowId, commit)) reviewRefs.set(key, { dir: ref.dir, flowId });
		else ctx.ui.notify(`workflow: review base kept in memory only (could not write refs/pi/review-base/${flowId} in ${ref.root})`, "warning");
	}

	/** The base branch of a repo as `origin/<name>`: delivery.base, else origin's HEAD, else origin/main; undefined when none exists. */
	async function upstreamBase(dir: string): Promise<string | undefined> {
		const names: string[] = [];
		if (cfg.delivery.base) names.push(`origin/${cfg.delivery.base}`);
		const head = await git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
		if (head.code === 0 && head.stdout.trim()) names.push(head.stdout.trim());
		names.push("origin/main");
		for (const n of names) if ((await git(dir, "rev-parse", "--verify", "--quiet", `${n}^{commit}`)).code === 0) return n;
		return undefined;
	}

	/**
	 * Before a judge run: when the base branch was merged into a repo's branch, its review base takes in what that brought, so the merged work
	 * is not reviewed as this flow's. Returns a note for the judge's focus when that was not possible (a conflict, or git before 2.38).
	 */
	async function refreshReviewBase(ctx: ExtensionContext): Promise<string | undefined> {
		if (state.phase !== "execute") return undefined;
		const notes = new Set<string>();
		for (const ref of await flowRepos(ctx)) {
			const base = state.reviewBase?.[repoKey(ref.root)];
			if (!base) continue;
			const upstream = await upstreamBase(ref.dir);
			if (!upstream) continue;
			if ((await git(ref.dir, "merge-base", "--is-ancestor", upstream, "HEAD")).code !== 0) continue;
			if ((await git(ref.dir, "merge-base", "--is-ancestor", upstream, base)).code === 0) continue;
			const moved = await mergedBase(defaultRunner, ref.dir, base, upstream);
			if (moved) await setReviewBase(ctx, ref, moved);
			else notes.add(`This diff includes changes merged from ${upstream}; review only this flow's changes.`);
		}
		return notes.size ? [...notes].join(" ") : undefined;
	}

	/** After a stage passes: each repo's review base becomes the worktree as it is, so the next stage is reviewed on its own. */
	async function advanceReviewBase(ctx: ExtensionContext): Promise<void> {
		const repos = state.lastJudge?.repos;
		if (!repos) return;
		for (const ref of await flowRepos(ctx)) {
			const snap = repos[repoKey(ref.root)];
			if (!snap) continue;
			// The worktree as it is now, not the tree that was judged: the flow's pull request may be merged and the base branch moved on since.
			const tree = (await snapshotTree(ref.dir)) ?? snap.tree;
			const sha = await baseFromTree(defaultRunner, ref.dir, tree);
			if (!sha) {
				ctx.ui.notify("workflow: review base not moved (git commit-tree failed)", "warning");
				continue;
			}
			await setReviewBase(ctx, ref, sha);
		}
	}

	/** Deletes the flow's review-base refs: those this session wrote, and the flow's ref in every repo it covers (a reloaded session lost the list). */
	async function dropReviewRefs(ctx: ExtensionContext): Promise<void> {
		const written = [...reviewRefs.values()];
		reviewRefs.clear();
		for (const v of written) await deleteReviewRef(gitEnv, v.dir, v.flowId);
		const flowId = state.planDoc?.flowId;
		if (!flowId) return;
		for (const ref of await flowRepos(ctx)) await deleteReviewRef(gitEnv, ref.dir, flowId);
	}

	/** A resumed flow takes back its review state. A review base git no longer has falls back to HEAD with a warning. */
	async function restoreReview(ctx: ExtensionContext, status: PlanStatus): Promise<void> {
		state.passedTrees = status.passedTrees ? Object.fromEntries(Object.entries(status.passedTrees).map(([k, v]) => [k, [...v]])) : undefined;
		state.judgedMerges = status.judgedMerges ? Object.fromEntries(Object.entries(status.judgedMerges).map(([k, v]) => [k, { ...v }])) : undefined;
		for (const ref of await flowRepos(ctx)) {
			const key = repoKey(ref.root);
			const sha = status.reviewBase?.[key];
			if (!sha) {
				await joinReviewBase(ref.root, true);
				continue;
			}
			if ((await git(ref.dir, "cat-file", "-e", `${sha}^{commit}`)).code === 0) {
				state.reviewBase = { ...(state.reviewBase ?? {}), [key]: sha };
				reviewRefs.set(key, { dir: ref.dir, flowId: status.flowId });
			} else ctx.ui.notify(`workflow: the review base of ${ref.root} is gone; reviewing from HEAD`, "warning");
		}
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
		kind?: "test";
		touched: string[];
		finished?: Finished;
		waiting?: NonNullable<PlanStatus["waiting"]>;
		checkpoints?: { step?: string; stage?: number; text: string; ok: boolean }[];
		reviewBase?: Record<string, string>;
		passedTrees?: Record<string, string[]>;
		judgedMerges?: Record<string, { pr?: string; commit?: string; tree: string; stage?: number }>;
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
			...(snap.kind ? { kind: snap.kind } : {}),
			done: (snap.checklist ?? []).filter((i) => i.done).map((i) => i.id),
			...(snap.finished ? { finished: snap.finished } : {}),
			...(snap.waiting ? { waiting: snap.waiting } : {}),
			...(snap.checkpoints?.length ? { checkpoints: snap.checkpoints } : {}),
			...(snap.reviewBase && Object.keys(snap.reviewBase).length ? { reviewBase: snap.reviewBase } : {}),
			...(snap.passedTrees && Object.keys(snap.passedTrees).length ? { passedTrees: snap.passedTrees } : {}),
			...(snap.judgedMerges && Object.keys(snap.judgedMerges).length ? { judgedMerges: snap.judgedMerges } : {}),
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
	function waitSnapshot(): Pick<PlanSnap, "waiting" | "checkpoints" | "reviewBase" | "passedTrees" | "judgedMerges"> {
		const w = state.waiting;
		return {
			...(w ? { waiting: { reason: w.reason, ...(w.check ? { check: w.check } : {}), since: w.since, planned: w.planned, ...(w.atStageStart ? { atStageStart: true } : {}), ...(w.held ? { held: w.held } : {}) } } : {}),
			...(state.checkpoints?.length ? { checkpoints: state.checkpoints.map((c) => ({ ...(c.step ? { step: c.step } : {}), ...(c.stage ? { stage: c.stage } : {}), text: c.text, ok: c.ok })) } : {}),
			...(state.reviewBase && Object.keys(state.reviewBase).length ? { reviewBase: { ...state.reviewBase } } : {}),
			...(state.passedTrees && Object.keys(state.passedTrees).length ? { passedTrees: { ...state.passedTrees } } : {}),
			...(state.judgedMerges && Object.keys(state.judgedMerges).length ? { judgedMerges: { ...state.judgedMerges } } : {}),
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
			delete status.reviewBase;
			delete status.passedTrees;
			delete status.judgedMerges;
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
			const pruned = pruneIds(entries, { keepDays: cfg.plans.keepDays, keepCount: cfg.plans.keepCount, now: Date.now(), activeId });
			for (const id of pruned) {
				await deleteRef(gitEnv, root, id, sync ? remote?.name : undefined);
			}
			// Review bases are local only: the pruned flows' go, and so do leftovers of crashed flows older than a day.
			const keep = new Set(entries.map((e) => e.flowId).filter((id) => !pruned.includes(id)));
			if (activeId) keep.add(activeId);
			const finished = entries.filter((e) => e.finished && e.flowId !== activeId).map((e) => e.flowId);
			await sweepReviewRefs(gitEnv, root, { drop: [...pruned, ...finished], keep, now: Date.now(), minAgeMs: 86_400_000 });
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
		state.stage = status.stage;
		state.stageOutcomes = undefined;
		state.stageJudged = undefined;
		state.checklist = parseChecklist(plan).map((i) => ({ ...i, done: status.done.includes(i.id) }));
		if (!state.checklist.length) state.checklist = undefined;
		state.checkpoints = status.checkpoints?.map((c) => ({ ...c }));
		await restoreReview(ctx, status);
		state.waiting = undefined;
		publishWaitSince.clear();
		if (status.waiting) {
			// Older status files lack the held text and the flags: rebuild the plain stage start for a stage that declares this wait.
			const resumedStages = state.stage ? parseStages(plan) : [];
			const after = state.stage ? resumedStages[state.stage - 1]?.after : undefined;
			const atStart = status.waiting.atStageStart ?? (!!after && after.reason === status.waiting.reason);
			const held = status.waiting.held ?? (atStart && state.stage ? stageStart(resumedStages, state.stage) : undefined);
			const publishStep = /^Call publish_packages again with step (\S+)\.$/.exec(status.waiting.held ?? "")?.[1];
			if (publishStep) publishWaitSince.set(publishStep, status.waiting.since);
			state.waiting = {
				...(publishStep ? { step: publishStep } : {}),
				reason: status.waiting.reason,
				...(cleanCheck(status.waiting.check) ? { check: cleanCheck(status.waiting.check) } : {}),
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
		startWaitTimer(state.waiting?.step && publishWaitSince.has(state.waiting.step) ? Date.parse(state.waiting.since) : undefined);
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
		// Back to the phase's stage either way.
		view.stage = phaseStage();
		state.lastJudge = plan.snaps ? { hash: diff.hash, repos: plan.snaps, base: diff.base, verdict, text } : undefined;
		if (plan.kind === "full") state.lastFullPass = plan.snaps && verdict === "PASS" && !hasPlanFlaw(text) ? { repos: plan.snaps, base: diff.base } : undefined;
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
		summarizeFlow(outcome.text, outcome.ok, manualChecks(flow));
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
		state.finalizing = undefined;
		state.pendingPlanFlaw = undefined;
		state.stageJudged = undefined;
		state.stageNudgedFor = undefined;
		if (state.passedDiff) markPassSummarized(state.passedDiff); // a leftover diff from the round before is not this round's
		state.lastJudge = undefined; // a new round gets a full review, not a re-review of the last one
		state.lastFullPass = undefined;
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
				continue; // listed on the end card instead of asked
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
	let waitFirstTimer: ReturnType<typeof setTimeout> | undefined;
	/** First wait of each Publish/Mirror step, so the wait's time limit counts across blocked retries. */
	const publishWaitSince = new Map<string, string>();
	let waitChecking = false;

	function stopWaitTimer(): void {
		if (waitTimer) clearInterval(waitTimer);
		waitTimer = undefined;
		if (waitFirstTimer) clearTimeout(waitFirstTimer);
		waitFirstTimer = undefined;
	}

	/** Polls the wait's check every `wait.pollMs` while the session is idle. A wait without a check, or whose check already passed, is not polled. */
	function startWaitTimer(sinceMs?: number): void {
		stopWaitTimer();
		const w = state.waiting;
		if (!w?.check || w.checkPassed) return;
		waitTimerStart = sinceMs ?? Date.now();
		waitTimer = setInterval(() => void waitTick(), cfg.wait.pollMs);
		(waitTimer as { unref?: () => void }).unref?.();
		waitFirstTimer = setTimeout(() => void waitTick(), 5_000);
		(waitFirstTimer as { unref?: () => void }).unref?.();
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
			"Pause the flow until a person has done something a later step needs (open the Unity Editor so the unity CLI can run). For a check only a person can do (play it in the Editor, look at visuals) use kind \"verify\": nothing pauses, the check is listed for the user after the flow. Optional `check` is a read-only command that exits 0 once it is done; the workflow runs it once at once, then every few minutes, and resumes you by itself. Then end your turn. With autopilot on, the tool tells you what to do instead of pausing, unless `manual: true`. Name the plan step as `step` when the plan has a `Wait:` step; otherwise the wait is added to the plan as an amendment.",
		promptSnippet: "wait_for_user: pause the flow until a person did something; resumes by check or by their reply",
		parameters: Type.Object({
			reason: Type.String({ description: "What the person must do, in one line" }),
			check: Type.Optional(Type.String({ description: "A read-only command that exits 0 once it is done, e.g. git ls-remote --exit-code --tags origin <tag>. It runs once at once, then every few minutes" })),
			step: Type.Optional(Type.String({ description: "The plan's Wait step, e.g. S7" })),
			kind: Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("act"), Type.Literal("verify")], { description: "approve: a person only reviews and agrees; act (default): a person must do something; verify: a person must test or look at the result; nothing waits, it is listed for them after the flow" })),
			manual: Type.Optional(Type.Boolean({ description: "Pause even when autopilot is on" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			const plan = state.approvedPlan;
			if (state.phase !== "execute" || !plan) return reply("wait_for_user works only while executing an approved plan. Nothing changed.");
			const reason = params.reason.trim();
			if (!reason) return reply("Give a reason: what the person must do. Nothing changed.");
			if (params.kind === "verify") {
				const vstep = params.step?.trim().toUpperCase() || undefined;
				if (!(vstep && parseVerifyStep(plan, vstep))) {
					state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${verifyAmendment(nextAmendmentNumber(), { steps: reason, step: vstep })}\n`;
					const item = vstep ? state.checklist?.find((i) => i.id === vstep) : undefined;
					if (item && !isHuman(item)) item.done = true;
					refreshChecklist();
				}
				persist();
				updateStatus(ctx);
				planMilestone(ctx);
				return reply(`Recorded as a human check for after the flow: ${reason}. Don't wait; continue in this turn.`);
			}
			const check = cleanCheck(params.check);
			if (check) {
				const shape = waitCheckProblem(check);
				if (shape) return reply(`The check ${shape}. Nothing changed.`);
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

	/** Runs `node scripts/<script> <args>` in a repo with stdin closed; resolves with the exit code and the output. */
	function runNodeScript(root: string, script: string, args: string[], timeoutMs = 30 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
		return new Promise((resolve) => {
			const child = spawn("node", [path.join(root, "scripts", script), ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => child.kill(), timeoutMs);
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("error", (e) => {
				clearTimeout(timer);
				resolve({ code: 1, stdout, stderr: `${stderr}${e.message}` });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code: code ?? 1, stdout, stderr });
			});
		});
	}

	const lastLines = (text: string, n = 40) => text.trim().split(/\r?\n/).slice(-n).join("\n");

	/** The clone's publish lock file (shared by every session and worktree of the clone). */
	async function publishLockFile(root: string): Promise<string> {
		const common = (await git(root, "rev-parse", "--git-common-dir")).stdout.trim() || ".git";
		return path.resolve(root, common, "iec-publish.lock");
	}

	/** Takes the clone's publish lock: a release function, or "held" while another session publishes. */
	async function takePublishLock(file: string): Promise<{ release: () => void } | "held"> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				fs.writeFileSync(file, JSON.stringify({ session: state.planDoc?.flowId ?? "session", pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
				return { release: () => fs.rmSync(file, { force: true }) };
			} catch {
				let lock: { pid: number; startedAt: string } | null = null;
				try {
					lock = JSON.parse(fs.readFileSync(file, "utf8"));
				} catch {
					// A half-written file is a lock being taken: judge it by its age.
					try {
						lock = { pid: 0, startedAt: fs.statSync(file).mtime.toISOString() };
					} catch {
						lock = null;
					}
				}
				if (lockDecision(lock, Date.now(), pidAlive) === "held") return "held";
				fs.rmSync(file, { force: true });
			}
		}
		return "held";
	}

	type ToolReply = { content: { type: "text"; text: string }[]; details: object };

	pi.registerTool({
		name: "publish_packages",
		label: "Publish packages",
		description:
			"Run a plan's `Publish:` or `Mirror:` step: publishes the unity-packages versions this flow merged (with the person's registry token, on this computer) or mirrors vendor packages. Pass the plan step ID. If an earlier version or a pinned package is not published yet, the flow waits and resumes by itself; then call this again with the same step. Never run updates.bat, update-packages.mjs publish, maintenance.mjs mirror --confirm, publish-package.mjs or npm publish yourself.",
		promptSnippet: "publish_packages: run the plan's Publish:/Mirror: step S<n>",
		parameters: Type.Object({ step: Type.String({ description: "The plan's Publish: or Mirror: step, e.g. S9" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string): ToolReply => ({ content: [{ type: "text" as const, text }], details: {} });
			const plan = state.approvedPlan;
			if (state.phase !== "execute" || !plan) return reply("publish_packages works only while executing an approved plan. Nothing published.");
			const step = params.step.trim().toUpperCase();
			const pub = parsePublishStep(plan, step);
			const mir = pub ? null : parseMirrorStep(plan, step);
			if (!pub && !mir) return reply(`Step ${step} is not a \`Publish: <package>\` or \`Mirror: <folder>|all\` step of the approved plan (packages only, no versions). Nothing published.`);
			if (state.checklist?.find((i) => i.id === step)?.done) return reply(`Step ${step} is already ticked. Nothing published.`);
			const repo = (await flowRepos(ctx)).find((r) => fs.existsSync(path.join(r.root, "scripts", "update-packages.mjs")));
			if (!repo) return reply("No repo of this flow has scripts/update-packages.mjs (add the unity-packages folder to the flow). Nothing published.");
			const root = repo.root;
			const wait = (why: string, check: string): ToolReply => {
				const since = waitSince(publishWaitSince.get(step), new Date().toISOString());
				publishWaitSince.set(step, since);
				state.waiting = { reason: why, check, step, stage: state.stage, since, planned: true, held: `Call publish_packages again with step ${step}.` };
				persist();
				updateStatus(ctx);
				planMilestone(ctx);
				startWaitTimer(Date.parse(since));
				return reply(`Waiting: ${why}. End your turn now; the workflow resumes you when the check passes. Then call publish_packages again with step ${step}.`);
			};
			const lockFile = await publishLockFile(root);
			const lock = await takePublishLock(lockFile);
			if (lock === "held") return wait("another session is publishing", lockWaitCheck(lockFile));
			try {
				if (mir) {
					const r = await runNodeScript(root, "maintenance.mjs", mirrorArgs(mir));
					if (r.code === 0) publishWaitSince.delete(step);
					return reply(`mirror ${mir.target} exit ${r.code}:\n${lastLines(`${r.stdout}\n${r.stderr}`)}\n${r.code === 0 ? `Tick ${step} with plan_check.` : "Nothing more was done; report the failure."}`);
				}
				return await runPublish(root, step, pub!.packages, reply, wait);
			} finally {
				lock.release();
			}
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "publish_packages", "execute")}${theme.fg("accent", ` ${String(args.step ?? "")}`)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "git_task",
		label: "Git task",
		description:
			"Delegate routine git work (commit, push, open a pull request, merge) to a cheaper model and get its report back in the same turn. It runs under the same guard as you: a merge or a push to a protected branch is refused until the exact tree has passed judge. Give the exact task (repo, branch, commit messages, base). If it fails, do the work yourself.",
		promptSnippet: "git_task: delegate commit/push/PR/merge work to a cheap model; returns its report",
		parameters: Type.Object({
			task: Type.String({ description: "What to do, e.g. 'commit the staged changes as \"feat: x\", push the branch, open a PR against main'" }),
			repo: Type.Optional(Type.String({ description: "Folder of the repo to work in; default the working folder" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const reply = (text: string, details: object = {}) => ({ content: [{ type: "text" as const, text }], details });
			if (state.phase !== "execute" || !state.approvedPlan) return reply("git_task works only while executing an approved plan. Nothing changed.");
			if (!fs.existsSync(GIT_GUARD_EXTENSION)) return reply(`git_task failed: git guard extension not found at ${GIT_GUARD_EXTENSION}`);
			const repos = await flowRepos(ctx);
			const cwd = params.repo ? path.resolve(ctx.cwd, params.repo) : ctx.cwd;
			if (!fs.existsSync(cwd)) return reply(`git_task failed: ${cwd} does not exist.`);
			const multi = (state.folders?.length ?? 0) > 0 || (state.touchedRepos?.length ?? 0) > 0;
			const spec: GitGuardSpec = {
				roots: multi ? repos.map((r) => r.root) : [],
				protectedBranches: cfg.protectedBranches,
				passedTrees: state.passedTrees ?? {},
				noMerge: noMerge(state.approvedPlan),
			};
			const task = [
				params.task.trim(),
				"",
				"Rules:",
				`- Work only in ${multi ? repos.map((r) => r.root).join(", ") : cwd}.`,
				"- Never force-push, use --no-verify, --admin or --auto.",
				"- Chain dependent steps with &&.",
				"- Stop at the first failure and report the command and its error.",
				"- Report each commit subject, branch and pull request URL.",
			].join("\n");
			const repoList = repos.length ? repos : [{ root: cwd, dir: cwd, changed: false }];
			// A merge with --delete-branch leaves the checkout on the default branch, so the branch is read first.
			const branchBefore = new Map<string, string>();
			const headBefore = new Map<string, string>();
			const remoteBefore = new Map<string, boolean>();
			for (const r of repoList) {
				branchBefore.set(r.root, (await git(r.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim());
				headBefore.set(r.root, (await git(r.dir, "rev-parse", "HEAD")).stdout.trim());
				remoteBefore.set(r.root, !!(await git(r.dir, "branch", "-r", "--contains", "HEAD")).stdout.trim());
			}
			const progress = toolProgress(onUpdate);
			const prevStage = view.stage;
			view.stage = "commit";
			let text: string;
			try {
				ctx.ui.setWorkingMessage("git_task running…");
				const ran = await runRole(
					"commit",
					"git task",
					{ systemPrompts: [prompts.COMMIT], tools: ["bash", "read"], task, cwd, signal, env: { [GIT_GUARD_ENV]: JSON.stringify(spec) }, extensions: [GIT_GUARD_EXTENSION] },
					progress.track,
				);
				if (ran.result.ok) view.finish(ran.run, true, "report ready");
				text = ran.result.ok ? ran.result.text : `git_task failed: ${ran.result.error}`;
			} catch (e) {
				text = `git_task failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				view.stage = prevStage;
				ctx.ui.setWorkingMessage();
			}
			const lines: string[] = [];
			for (const r of repoList) {
				const key = repoKey(r.root);
				const branch = (await git(r.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
				const base = state.reviewBase?.[key];
				const n = base ? (await git(r.dir, "rev-list", "--count", `${base}..HEAD`)).stdout.trim() : "?";
				const rec = await recordJudged(defaultRunner, r.dir, { startBranch: branchBefore.get(r.root) ?? "", headBefore: headBefore.get(r.root), remoteBefore: remoteBefore.get(r.root), report: text, passed: state.passedTrees?.[key] ?? [], protectedBranches: cfg.protectedBranches });
				const pr = rec.pr;
				const existing = state.judgedMerges?.[key];
				if (rec.entry && !(rec.entry.commit && existing?.pr && existing.stage === state.stage)) {
					state.judgedMerges = { ...(state.judgedMerges ?? {}), [key]: { ...rec.entry, ...(state.stage ? { stage: state.stage } : {}) } };
					persist();
				}
				lines.push(`${path.basename(r.root)}: branch ${branch}, ${n} commits since review base, ${pr}`);
			}
			return reply(`${text}\n\n${lines.join("\n")}`, { runs: progress.snapshot() });
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "git_task", "commit")}${theme.fg("accent", ` ${String(args.task ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	/** The commit a judged merge landed in this repo (a merged pull request's merge commit, or a pushed commit that origin has), or the reason there is none. */
	async function judgedMergeHead(root: string): Promise<{ head: string } | { error: string }> {
		const jm = state.judgedMerges?.[repoKey(root)];
		if (!jm) return { error: NO_JUDGED_MERGE };
		await git(root, "fetch", "--quiet", "origin");
		if (jm.pr) {
			const view = await defaultRunner("gh", ["pr", "view", jm.pr, "--json", "state,mergeCommit"], root);
			if (view.code !== 0) return { error: `Cannot read pull request ${jm.pr} (${view.stderr.trim().split(/\r?\n/)[0] || "gh failed"}). Nothing published.` };
			try {
				const j = JSON.parse(view.stdout) as { state?: unknown; mergeCommit?: { oid?: unknown } | null };
				if (j.state !== "MERGED") return { error: `Pull request ${jm.pr} is ${String(j.state)}, not MERGED: merge the judged pull request first. Nothing published.` };
				const oid = typeof j.mergeCommit?.oid === "string" ? j.mergeCommit.oid : "";
				if (!oid) return { error: `Pull request ${jm.pr} has no merge commit to read. Nothing published.` };
				return { head: oid };
			} catch {
				return { error: `Cannot read pull request ${jm.pr} (gh printed no JSON). Nothing published.` };
			}
		}
		if (jm.commit) {
			const onRemote = await git(root, "branch", "-r", "--contains", jm.commit);
			if (onRemote.code !== 0 || !onRemote.stdout.trim()) return { error: `The judged commit ${jm.commit.slice(0, 9)} is not on origin yet: push it first. Nothing published.` };
			return { head: jm.commit };
		}
		return { error: NO_JUDGED_MERGE };
	}

	/** The versions the merged head holds for these packages, or the reason it can't be read. */
	async function readMergedItems(root: string, head: string, packages: string[]): Promise<{ items: { name: string; version: string }[] } | { error: string }> {
		const items: { name: string; version: string }[] = [];
		for (const name of packages) {
			const show = await git(root, "show", `${head}:${name}/package.json`);
			let version = "";
			try {
				version = String(JSON.parse(show.stdout).version ?? "");
			} catch {
				version = "";
			}
			if (show.code !== 0 || !version) return { error: `${name} has no package.json at the merged head ${head.slice(0, 8)}. Nothing published.` };
			items.push({ name, version });
		}
		return { items };
	}

	/** The script's dry run for these versions: its JSON, or the reason it failed. */
	async function dryRunPublish(root: string, items: { name: string; version: string }[]) {
		const dry = await runNodeScript(root, "update-packages.mjs", publishArgs(items, true));
		let result: { items?: { name: string; version: string }[]; blockedBy?: { tag: string }[]; notCandidates?: string[]; error?: string } | undefined;
		try {
			result = JSON.parse(dry.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "");
		} catch {
			result = undefined;
		}
		if (dry.code !== 0 || !result || result.error) return { error: `exit ${dry.code}${result?.error ? ` (${result.error})` : ""}:\n${lastLines(`${dry.stderr}\n${dry.stdout}`, 20)}` };
		return { result };
	}

	/** The tags (name/vversion) of these versions that origin has. */
	async function taggedOnOrigin(root: string, items: { name: string; version: string }[]): Promise<Set<string>> {
		const tagged = new Set<string>();
		for (const i of items) {
			const remote = await git(root, "ls-remote", "--tags", "origin", `${i.name}/v${i.version}`);
			if (remote.code === 0 && remote.stdout.trim()) tagged.add(`${i.name}/v${i.version}`);
		}
		return tagged;
	}

	/** The Publish step: versions come from the head this flow merged; the script's dry run decides what is published, already on the registry or not publishable; blockers start a wait. */
	async function runPublish(root: string, step: string, packages: string[], reply: (t: string) => ToolReply, wait: (why: string, check: string) => ToolReply): Promise<ToolReply> {
		if (noMerge(state.approvedPlan ?? "")) return reply("this plan says Delivery: no merge; publishing is not allowed. Nothing published.");
		const merged = await judgedMergeHead(root);
		if ("error" in merged) return reply(merged.error);
		const read = await readMergedItems(root, merged.head, packages);
		if ("error" in read) return reply(read.error);
		const names = (list: { name: string; version: string }[]) => list.map((i) => `${i.name}@${i.version}`).join(", ");
		const dry = await dryRunPublish(root, read.items);
		if ("error" in dry) return reply(`Checking ${names(read.items)} failed (${dry.error})\nNothing published.`);
		const split = classifyPublish(read.items, dry.result, await taggedOnOrigin(root, read.items));
		if (split.notPublishable.length) return reply(`${split.notPublishable.join(", ")}: superseded or not on origin/main; nothing published. Stop and explain to the user.`);
		if (!split.publish.length) {
			publishWaitSince.delete(step);
			return reply(`${names(read.items)} already on the registry. Tick ${step} with plan_check.`);
		}
		if (dry.result.blockedBy?.length) return wait(`waiting for ${dry.result.blockedBy.map((b) => b.tag).join(", ")} to be published`, blockedWaitCheck(root, split.publish));
		const run = await runNodeScript(root, "update-packages.mjs", publishArgs(split.publish, false));
		if (run.code === 0) publishWaitSince.delete(step);
		const skipped = split.alreadyPublished.length ? `Skipped, the registry already has: ${names(split.alreadyPublished)}.\n` : "";
		const next = run.code === 0 ? `Tick ${step} with plan_check.` : run.code === 3 ? "Blocked meanwhile; call publish_packages again." : "Nothing more was done; report the failure.";
		return reply(`${skipped}publish ${names(split.publish)} exit ${run.code}:\n${lastLines(`${run.stdout}\n${run.stderr}`)}\n${next}`);
	}

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
			const open = list.filter((i) => !isHuman(i) && !i.done && (!staged || i.stage === undefined || i.stage === staged.current));
			const done = list.filter((i) => !isHuman(i) && i.done).length;
			const head = `${done} of ${list.filter((i) => !isHuman(i)).length} steps done${unknown.length ? `; unknown IDs: ${unknown.join(", ")}` : ""}.`;
			const rest = open.length ? `Open${staged ? ` in stage ${staged.current}` : ""}:\n${open.map((i) => `- ${i.id} ${i.text}${deliverLine(i.id, staged?.current)}`).join("\n")}` : `No open steps${staged ? " in this stage" : ""}.`;
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
			"Adversarial review of the diff since the flow's review base (committed or not, plus untracked files) of every git repo in this flow (the working folder's, the /folders ones, and repos edited this flow) by a stronger model that assumes the change is wrong. Returns one line per finding and VERDICT: PASS or FAIL. Call it when the diff is ready; fix blocker and major findings and call it again. On a pass, finish the delivery (push, pull request, and the merge unless the plan says Delivery: no merge), tick the steps and end your turn: the workflow decides whether minor findings get a fix round. Rounds after the first review only the changes since the last round, with its findings. Commits are free; merge, a protected push and publish_packages need a PASS on their exact tree.",
		promptSnippet: "judge: adversarial review of the current diff; must PASS before a merge, a protected push or a publish",
		parameters: Type.Object({
			focus: Type.Optional(Type.String({ description: "What the change is meant to do, or areas to scrutinize" })),
			base: Type.Optional(Type.String({ description: "Git ref to diff against. Default: the flow's review base" })),
			full: Type.Optional(
				Type.Boolean({ description: "Review the whole diff, not only the changes since the last round. Use once before committing a risky change." }),
			),
			disputes: Type.Optional(
				Type.String({ description: "Findings from the last round you believe are wrong, and the evidence (file:line). The judge verifies them against the code; it does not take them on trust." }),
			),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const baseNote = params.base ? undefined : await refreshReviewBase(ctx);
			const diff = await collectFlowDiff(ctx, params.base || undefined);
			if (!diff) throw new Error("no git work tree in this flow (working folder, /folders, or repos edited this flow); the judge reviews git diffs");
			if (state.phase === "execute" && currentStages()) {
				state.stageJudged = true;
				persist();
			}
			if (!diff.text) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const progress = toolProgress(onUpdate);
			const r = await judge(ctx, diff, [params.focus, baseNote].filter(Boolean).join("\n") || undefined, signal, progress.track, params.full === true, params.disputes);
			if (r.verdict === "ERROR") throw new Error(r.text);
			if (r.verdict === "FAIL") state.judgeRounds++;
			let text = r.text;
			if (r.verdict === "PASS" && state.phase === "execute" && !state.testFlow && !hasPlanFlaw(r.text) && !noMerge(state.approvedPlan ?? "") && (await flowHasRemote(ctx))) {
				text += "\n\nNow deliver this exact tree: commit, push, open or update the pull request and merge it with gh pr merge (as its own command), then end your turn.";
			}
			if (r.verdict === "PASS") {
				const knowledge = state.lastKnowledge?.hash === diff.hash ? state.lastKnowledge : undefined;
				const block = knowledge ? deviationBlock(knowledge.deviations) : "";
				if (block) text += `\n\nEnd the pull request body (or the last commit message if there is no pull request) with this block, unchanged:\n\n${block}`;
			}
			const reminder = state.phase === "execute" ? openStepsReminder(state.checklist, currentStages()?.current) : undefined;
			if (reminder) text += `\n\n${reminder}${state.phase === "execute" ? deliverHintsText(currentStages()?.current) : ""}`;
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
			"Create or move a tag on the remote default branch (`tag`), inside the plan, then carry on in the same turn. Commit, push, pull requests and merges are done with git and gh directly or with git_task, not with this tool. Name the plan's `Deliver:` step as `step`; a call without one is added to the plan as an amendment. Tags are created or moved only for a named plan step or when you need them to continue; a move needs a plan step that names the tag and the word move.",
		promptSnippet: "deliver: create or move a tag inside the plan, then continue",
		parameters: Type.Object({
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
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
			const plan = state.approvedPlan;
			if (state.phase !== "execute" || !plan) return reply("deliver works only while executing an approved plan. Nothing changed.");
			const tag = params.tag && params.tag.name?.trim() ? { ...params.tag, name: params.tag.name.trim(), move: params.tag.move === true } : undefined;
			if (!tag) return reply("Give a tag: deliver only creates or moves tags. Commit, push, pull requests and merges are done with git and gh. Nothing changed.");

			const step = params.step?.trim().toUpperCase() || undefined;
			const stepText = step ? parseDeliverStep(plan, step) : null;
			const planned = stepText !== null;
			if (!planned) {
				const reason = params.reason?.trim() || "needed to continue";
				const amend = { tag: tag.name, reason };
				if (!hasCheckpointAmendment(plan, amend)) {
					state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${checkpointAmendment(nextAmendmentNumber(), amend)}\n`;
					refreshChecklist();
					planMilestone(ctx);
					persist();
				}
			}

			const t = await deliverTag(ctx, tag, isPlannedTag(stepText, tag.name, tag.move));
			if (t.wait) {
				state.waiting = { reason: t.wait, ...(planned && step ? { step } : {}), stage: state.stage, since: new Date().toISOString(), planned };
			}
			state.checkpoints = [...(state.checkpoints ?? []), { ...(planned && step ? { step } : {}), stage: state.stage, text: checkpointText(planned ? step : undefined, t.text), ok: t.ok }];
			persist();
			updateStatus(ctx);
			planMilestone(ctx);
			if (t.wait) return reply(`${t.text}\n\nWaiting for: ${t.wait}. End your turn now; the workflow resumes you when the user replies.`);
			const branches: string[] = [];
			for (const ref of await flowRepos(ctx)) {
				const b = (await git(ref.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
				if (b) branches.push(`${path.basename(ref.root)}: ${b}`);
			}
			return reply(`${t.text}${branches.length ? `\n\nCurrent branch: ${branches.join(", ")}` : ""}\n\nContinue with the next steps in this turn.`);
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "deliver", "execute")}${theme.fg("accent", args.tag?.name ? ` tag ${args.tag.name}` : "")}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 40),
	});

	// ----------------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------------

	pi.on("turn_start", async () => {
		refilterTools();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refilterTools();
		const folders = existingFolders();
		const touched = state.touchedRepos ?? [];
		if (folders.length || touched.length) {
			const opts = event.systemPromptOptions;
			const have = new Set(opts.contextFiles.map((f) => repoKey(f.path)));
			const listed: { path: string; size: number }[] = [];
			for (const folder of folders) {
				try {
					for (const f of loadProjectContextFiles({ cwd: folder, agentDir: getAgentDir() })) {
						if (have.has(repoKey(f.path))) continue;
						have.add(repoKey(f.path));
						if (cfg.addedFolderRules === "full") opts.contextFiles.push(f);
						else listed.push({ path: f.path, size: f.content.length });
					}
				} catch {
					// an unreadable folder just adds no context files
				}
			}
			opts.sections.workspace = prompts.workspaceSection(ctx.cwd, folders, touched, listed);
		}
		const staged = state.phase === "execute" ? currentStages() : undefined;
		const phaseText = prompts.phaseSection(state.phase, {
			finalize: cfg.finalizePlan,
			staging: cfg.stagedPlans,
			recap: cfg.planRecap,
			stage: staged ? stageLine(staged.stages, staged.current) : undefined,
			testFix: state.phase === "execute" && !!state.testFlow,
			delivery: state.phase === "execute" ? prompts.deliveryGuidance(cfg.delivery) + (noMerge(state.approvedPlan ?? "") ? "\n- This plan says Delivery: no merge: do not merge, push to a protected branch or publish; commit, push your branch and open the pull request, then stop there." : "") : undefined,
		});
		if (phaseText) event.systemPromptOptions.sections.workflow = phaseText;
		else delete event.systemPromptOptions.sections.workflow;
	});

	// Plan phase is read-only: the planner settles the approach, the execute model changes things.
	// Nested calls (codemode's tools.bash) pass through here too.
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "test_run" && state.phase !== "test") return { block: true, reason: "test_run works only in the test phase." };
		if (state.phase === "execute") {
			// Commits, pushes and pull requests are the executor's; a merge, a push to a protected branch and a publish need a judge pass on their tree; hooks are never skipped.
			const input = (event.input ?? {}) as Record<string, unknown>;
			const texts: { text: string; powershell: boolean }[] = [];
			if (/(^|__)bash$/.test(event.toolName)) texts.push({ text: String(input.command ?? ""), powershell: false });
			else if (/(^|__)run_code$/.test(event.toolName)) {
				const reason = codePublishProblem(String(input.code ?? ""));
				if (reason) return { block: true, reason: publishRefuse(reason) };
				const registry = registryPublishCodeProblem(String(input.code ?? ""));
				if (registry) return { block: true, reason: registry };
			}
			if (texts.length) {
				const registry = registryPublishProblem(texts[0].text);
				if (registry) return { block: true, reason: registry };
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
			const gate = async (kind: "merge" | "protected-push", root: string | undefined, target: string | undefined, repo?: string): Promise<string | null> => {
				const dir = root ?? ctx.cwd;
				const key = repoKey(root ?? (await gitRoot(ctx.cwd)) ?? ctx.cwd);
				if (kind === "merge") await ensureGh(ctx).catch(() => false);
				const res = await gateCheck(defaultRunner, kind, dir, target, { passedTrees: state.passedTrees?.[key] ?? [], noMerge: noMerge(state.approvedPlan ?? ""), repo });
				if (res.problem) return res.problem;
				if (res.tree) {
					const stage = state.stage;
					const record = kind === "merge" ? { pr: target ?? (await branchOf(dir)), tree: res.tree, ...(stage ? { stage } : {}) } : res.commit ? { commit: res.commit, tree: res.tree, ...(stage ? { stage } : {}) } : undefined;
					if (record) {
						state.judgedMerges = { ...(state.judgedMerges ?? {}), [key]: record };
						persist();
					}
				}
				return null;
			};
			const isTag = async (root: string | undefined, name: string) => (await git(root ?? ctx.cwd, "show-ref", "--verify", "--quiet", `refs/tags/${name}`)).code === 0;
			for (const { text, powershell } of gitTexts) {
				const problem = await shellProblem(text, powershell, { roots: multi ? roots : undefined, cwd: ctx.cwd, protectedBranches: cfg.protectedBranches, branchOf, gate, isTag });
				if (problem) return { block: true, reason: publishRefuse(problem) };
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
		if (state.phase !== "plan" && state.phase !== "discuss") return;
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
			"Reading is fine: ls, cat, grep, find, git status/log/diff/show, gh ... view/list/checks, gh api GET, unity cmd *_status/get_*/find_*/list_*/search/console/captures/editor_play|stop|pause, video_frames.",
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
		await joinReviewBase(root);
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
		if (event.message.role === "assistant" && event.message.usage) view.mainUsage(countTokens(event.message.usage, cfg.tokenWeights), false, event.message.model, event.message.usage);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) view.mainUsage(countTokens(event.message.usage, cfg.tokenWeights), true, event.message.model, event.message.usage);
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
				pi.sendMessage({ customType: msg.customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
			};
			const held = ctx.getContextUsage()?.tokens ?? null;
			const plan = state.approvedPlan;
			const action = handoverAction({ aborted: event.aborted, idle: ctx.isIdle(), compacting, hasPlan: !!plan, tokens: held, threshold: cfg.handoverCompactTokens });
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
			const compactStart = Date.now();
			ctx.ui.notify(`workflow: handing over at ${Math.round((held ?? 0) / 1000)}k tokens, compacting first`, "info");
			ctx.compact({
				customInstructions: prompts.HANDOVER_COMPACT,
				onComplete: () => {
					recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "handover", tokensBefore: held ?? null, ms: Date.now() - compactStart, ok: true });
					compacting = false;
					guardTokens = null;
					void planCardReady().then((card) => send(`${msg.content}\n\n${card}`));
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
		// In discuss, a typed "go" only moves to planning: it never approves or executes.
		if (state.phase === "discuss" && event.source !== "extension" && !event.streamingBehavior && approveRe().test(event.text.trim())) {
			await setPhase(ctx, "plan");
			ctx.ui.notify(`workflow: planning on ${describeRole(cfg.roles.plan)}`, "info");
			return { action: "transform", text: `${event.text.trim()}\n\n${prompts.PLAN_KICKOFF}` };
		}
		if (state.phase !== "plan" || event.source === "extension" || event.streamingBehavior) return { action: "continue" };
		// Without a plan on screen, "yes, do that" answers a question; it doesn't approve anything.
		if (!planReady || !approveRe().test(event.text.trim())) return { action: "continue" };
		state.planFlaw = undefined;
		if (cfg.finalizePlan) {
			// Same as the menu: the planner writes the final plan first, in its reply to this message.
			planReady = false;
			state.finalizing = true;
			finalizeWaitRetried = false;
			persist();
			ctx.ui.notify(`workflow: plan approved, the planner writes the final plan`, "info");
			return { action: "transform", text: `${event.text.trim()}\n\n${prompts.finalize(cfg.delivery.splitCommits, cfg.stagedPlans)}` };
		}
		await setPhase(ctx, "execute");
		const extra = startExecution(ctx, lastPlanText);
		persist();
		ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(cfg.roles.execute)}`, "info");
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
				const waitProblems = planWaitProblems(finalText, (c) => readOnlyProblem(c));
				if (waitProblems.length && !finalizeWaitRetried) {
					finalizeWaitRetried = true;
					state.finalizing = true;
					persist();
					pi.sendMessage({ customType: "workflow-finalize", content: `The final plan has wait checks that can't run:\n${waitProblems.map((p) => `- ${p}`).join("\n")}\nFix them and reply with the whole final plan again. A check is one plain read-only command: no backticks around it, no placeholders like <version>, no command substitution. If a value is only known after an earlier stage (a version a script picks), drop that check or the wait itself.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
					return;
				}
				if (waitProblems.length) {
					persist();
					ctx.ui.notify(`workflow: the final plan still has wait checks that can't run (${waitProblems[0]}). Approve again to retry.`, "warning");
					return;
				}
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
			const approveLabel = "Approve";
			const arbiterLabel = "Approve, arbiter solves plan flaws →";
			const showLabel = "Show the full plan";
			const choice = await askUser(ctx, `Plan phase · execute on ${describeRole(cfg.roles.execute)}`, [approveLabel, ...(cfg.planFlaw === "ask" ? [arbiterLabel] : []), ...(recapChanges ? [showLabel] : []), "Back to discussion", "Keep discussing"]);
			if (choice === "Back to discussion") {
				await setPhase(ctx, "discuss");
				ctx.ui.notify(`workflow: back to discussion on ${describeRole(cfg.roles.discuss)}`, "info");
				return;
			}
			if (recapChanges && choice === showLabel) {
				pi.sendMessage({ customType: "workflow-show-plan", content: prompts.SHOW_PLAN, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			if (choice === arbiterLabel && cfg.planFlaw === "ask") {
				await approve(ctx, true);
				return;
			}
			if (choice === approveLabel) await approve(ctx);
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
		state.lastFullPass = undefined;
		view.stage = "execute";
		view.changed();
		planMilestone(ctx);
		persist();
		ctx.ui.notify(`workflow: stage ${next} of ${stages.length}: ${stages[next - 1].title}`, "info");
		const text = nextStage(stages, next, outcome) + deliverHintsText(next);
		if (holdForStageWait(ctx, stages[next - 1], text)) return;
		handover("workflow-stage", text);
	}

	/** A staged plan's turn ended with nothing new to review: it ends the stage only if the executor handed it over (judge called) or the user confirms. */
	async function noChangeTurn(ctx: ExtensionContext, staged: { stages: ReturnType<typeof parseStages>; current: number }): Promise<void> {
		const auto = (cfg.stageAdvance === "auto" || autopilotOn()) && !turnAborted;
		const open = (state.checklist ?? []).filter((i) => !isHuman(i) && !i.done && (i.stage === undefined || i.stage === staged.current)).length;
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
		const outcome = checkpointOutcome(state.checkpoints ?? []) ?? (state.lastJudge?.verdict === "PASS" ? { text: "judge passed, nothing left to review", ok: true } : null);
		if (!outcome || state.phase !== "execute" || turnAborted) return;
		if ((state.checklist ?? []).some((i) => !isHuman(i) && !i.done)) {
			if (!ctx.hasUI) return;
			const yes = "Mark done and finish";
			if ((await askUser(ctx, "All changes were delivered at checkpoints, but plan steps are still open", [yes, "Wait"])) !== yes) return;
		}
		state.minorRounds = 0;
		state.minorSentFor = undefined;
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

	/** diff ready -> judge -> fix loop, or commit (and push) once it passes. */
	async function reviewDiff(ctx: ExtensionContext, manual: boolean): Promise<void> {
		const baseNote = await refreshReviewBase(ctx);
		const diff = await collectFlowDiff(ctx);
		if (!diff?.text) {
			if (manual) ctx.ui.notify("workflow: no changes to review", "info");
			else if (diff && state.passedDiff && passPending({ passedDiff: state.passedDiff, judged: state.lastJudge, summarized: state.summarizedPasses })) {
				// The executor delivered the passed change and the base moved up with it: nothing is left to review, but the pass is still open.
				await stageDone(ctx, { ...diff, hash: state.passedDiff });
			} else {
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
			const open = minorFixOpen({ summarized: !!state.summarizedPasses?.includes(diff.hash), sentFor: state.minorSentFor, hash: diff.hash });
			if (open && fixMinorFindings(prior, diff.hash)) return;
			await stageDone(ctx, diff);
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
			r = await judge(ctx, diff, baseNote);
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
		await stageDone(ctx, diff, report);
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
				pi.sendMessage({ customType: "workflow-fix", content: prompts.FIX_MESSAGE, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			ctx.ui.notify(`workflow: stopped after ${state.judgeRounds} failed judge rounds`, "warning");
			summarizeFlow(stoppedSummary(`stopped: judge failed ${state.judgeRounds} rounds`), false);
			await endFlow(ctx);
			return;
		}
		pi.sendMessage(
			{ customType: "workflow-fix", content: report ? `${report}\n\n${prompts.FIX_MESSAGE}` : prompts.FIX_MESSAGE, display: true },
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
			prompts.minorFixMessage(shown, findings),
		);
		return true;
	}

	/** Remembers a passed diff's flow as ended, so later runs on the same diff don't end another one. */
	function markPassSummarized(hash: string): void {
		state.summarizedPasses = [...(state.summarizedPasses ?? []).filter((h) => h !== hash), hash].slice(-20);
	}

	/** What the stage delivered in each changed repo, read from git and gh: the branch, the commits since the review base, and the pull request if there is one. */
	async function stageOutcomeText(ctx: ExtensionContext, diff: Diff): Promise<string> {
		const changed = diff.repos.filter((r) => r.changed);
		const repos = changed.length ? changed : diff.repos;
		await ensureGh(ctx).catch(() => false);
		const parts = await Promise.all(
			repos.map(async (ref) => {
				const branch = (await git(ref.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || "HEAD";
				const base = state.reviewBase?.[repoKey(ref.root)];
				const counted = base ? await git(ref.dir, "rev-list", "--count", `${base}..HEAD`) : undefined;
				const n = counted?.code === 0 ? Number(counted.stdout.trim()) : undefined;
				let text = `${branch}${n === undefined ? "" : `, ${n} commit${n === 1 ? "" : "s"} since the review base`}`;
				const jm = state.judgedMerges?.[repoKey(ref.root)];
				const merged = mergedInStage(jm, state.stage) ? jm?.pr : undefined;
				const pr = await defaultRunner("gh", ["pr", "view", ...(merged ? [merged] : []), "--json", "number,state,url"], ref.dir);
				if (pr.code === 0) {
					try {
						const j = JSON.parse(pr.stdout) as { number?: unknown; state?: unknown; url?: unknown };
						if (typeof j.number === "number") text += `, PR #${j.number} ${String(j.state ?? "")} ${String(j.url ?? "")}`.trimEnd();
					} catch {}
				}
				return diff.multi ? `${path.basename(ref.root)}: ${text}` : text;
			}),
		);
		return parts.join("; ");
	}

	/** Whether some repo of the flow has a remote, so a pull request can be merged. */
	async function flowHasRemote(ctx: ExtensionContext): Promise<boolean> {
		const remotes = await Promise.all((await flowRepos(ctx)).map((r) => git(r.dir, "remote")));
		return remotes.some((r) => r.stdout.trim() !== "");
	}

	/** The changed repos of a passed diff that have a remote but no judged merge yet, by folder name: the executor still has to merge. Empty when the plan says no merge. */
	async function unmergedRepos(diff: Diff): Promise<string[]> {
		if (noMerge(state.approvedPlan ?? "")) return [];
		const out: string[] = [];
		for (const ref of diff.repos.filter((r) => r.changed)) {
			const jm = state.judgedMerges?.[repoKey(ref.root)];
			if (mergedInStage(jm, state.stage)) {
				// The gate records a merge before the command runs; it counts only once the pull request is MERGED (gh unreadable: believe it).
				if (!jm?.pr) continue;
				const view = await defaultRunner("gh", ["pr", "view", jm.pr, "--json", "state"], ref.dir);
				let state2 = "MERGED";
				try {
					if (view.code === 0) state2 = String(JSON.parse(view.stdout).state);
				} catch {}
				if (state2 === "MERGED") continue;
			}
			if (!(await git(ref.dir, "remote")).stdout.trim()) continue;
			out.push(path.basename(ref.root));
		}
		return out;
	}

	/**
	 * The judge passed and nothing is left to fix. A stage with steps still open gets one reminder per pass; then the stage ends: the review base
	 * moves up to the passed tree, and the next stage starts, or the flow ends. `report` is a verdict the executor has not seen yet.
	 */
	async function stageDone(ctx: ExtensionContext, diff: Diff, report?: string): Promise<void> {
		const hash = diff.hash;
		if (report) pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
		if (state.testFlow) {
			markPassSummarized(hash);
			await advanceReviewBase(ctx);
			if (turnAborted) return;
			await startTestRound(ctx, "retest");
			return;
		}
		const staged = currentStages();
		if (state.summarizedPasses?.includes(hash)) {
			// A staged plan's stage added nothing to the diff that was already passed.
			if (staged) await noChangeTurn(ctx, staged);
			return;
		}
		const open = (state.checklist ?? []).filter((i) => !isHuman(i) && !i.done && (!staged || i.stage === undefined || i.stage === staged.current));
		const unmerged = await unmergedRepos(diff);
		if (stageEndAction({ openSteps: open.length + (unmerged.length ? 1 : 0), nudgedFor: state.stageNudgedFor, hash }) === "nudge") {
			state.stageNudgedFor = hash;
			persist();
			const lines: string[] = [];
			if (open.length) lines.push(`Open steps ${open.map((i) => i.id).join(", ")}: finish them (merge, publish), tick them with plan_check, then end your turn.`);
			if (unmerged.length) lines.push(`The judge passed: merge the pull request (gh pr merge, as its own command)${unmerged.length > 1 || diff.multi ? ` in ${unmerged.join(", ")}` : ""}, then end your turn.`);
			handover("workflow-open-steps", lines.join("\n"));
			return;
		}
		const knowledge = state.lastKnowledge?.hash === hash ? state.lastKnowledge : undefined;
		if (knowledge?.status === "unavailable") ctx.ui.notify(`workflow: judge passed without the knowledge check: ${knowledge.reason}`, "warning");
		let outcome = { text: await stageOutcomeText(ctx, diff), ok: true };
		const cps = stageCheckpoints();
		if (cps.length) outcome = { text: withCheckpoints(cps.map((c) => c.text), outcome.text), ok: cps.every((c) => c.ok) };
		markPassSummarized(hash);
		await advanceReviewBase(ctx);
		state.minorRounds = 0;
		state.minorSentFor = undefined;
		state.stageNudgedFor = undefined;
		if (staged) {
			state.stageOutcomes = [...(state.stageOutcomes ?? []), outcome];
			if (staged.current < staged.stages.length) {
				startNextStage(ctx, staged.stages, outcome.text);
				return;
			}
			outcome = stagesOutcome(state.stageOutcomes, staged.stages.length);
		}
		state.planFlaw = undefined;
		state.stage = undefined;
		state.stageOutcomes = undefined;
		view.stage = "execute";
		if (!summarizeFlow(outcome.text, outcome.ok)) persist();
		await endFlow(ctx);
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
		void ensureGh(ctx).catch(() => false);

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
			if (state.phase === "discuss" || state.phase === "plan" || state.phase === "test") blockPlanTools(state.phase === "test" ? "test" : "plan");
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
		const start = (typeof flag === "string" && ["discuss", "plan", "execute", "test", "off"].includes(flag) ? flag : cfg.startPhase) as Phase;
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
		{ value: "board", label: "board - live view of every flow on this machine" },
		{ value: "discuss", label: "discuss - discuss phase (read-only, talk before planning)" },
		{ value: "plan", label: "plan - plan phase (read-only, planner model)" },
		{ value: "approve", label: "approve - approve the plan, switch to execute and start" },
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
			`judge     ${state.judgeRounds} failed round(s); auto=${cfg.autoJudge}; ${noMerge(state.approvedPlan ?? "") ? "no merge (the plan says so)" : "merge and publish after a judge pass"}`,
			...(state.testFlow ? [`test flow  round ${state.testFlow.round}, fix rounds ${normalize(state.testFlow).fixRounds}, fixed ${normalize(state.testFlow).fixed.length}, open ${openBugs(state.testFlow).length}, pending questions ${normalize(state.testFlow).pending.length}`] : []),
			...(currentStages() ? [`stage     ${currentStages()!.current} of ${currentStages()!.stages.length}: ${currentStages()!.stages[currentStages()!.current - 1].title}`] : []),
			state.planFlaw === "auto" ? "flaws     arbiter (this flow)" : `flaws     ${cfg.planFlaw === "auto" ? "arbiter" : "ask"} (config)`,
			`autopilot ${autopilotOn() ? "on" : "off"} (${autopilotOverride === undefined ? "config" : "session"})`,
			`guard     compact at ${cfg.contextGuardTokens || "off"} tokens`,
			`tokens    ${STAGES.filter((s) => !["discuss", "test", "commit"].includes(s) || view.sessionTokens(s).raw + view.sessionTokens(s).cost > 0).map((s) => `${s} ${fmtTok(view.sessionTokens(s))}`).join(" · ")} · session total ${fmtTok(STAGES.reduce((n, s) => ({ raw: n.raw + view.sessionTokens(s).raw, cost: n.cost + view.sessionTokens(s).cost }), { raw: 0, cost: 0 }))}`,
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
				const addedRoot = await gitRoot(final);
				if (addedRoot) await joinReviewBase(addedRoot);
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
			const matches = SUBCOMMANDS.filter((c) => c.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (sub.toLowerCase()) {
				case "status":
					ctx.ui.notify(statusText(), "info");
					return;
				case "discuss":
				case "plan":
				case "execute":
				case "off": {
					const from = state.phase;
					await setPhase(ctx, sub.toLowerCase() as Phase);
					ctx.ui.notify(`workflow: ${state.phase}`, "info");
					if (from === "discuss" && state.phase === "plan") sendPlanKickoff();
					return;
				}
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
					if (state.phase === "discuss") {
						ctx.ui.notify("workflow: discuss phase; moving to planning first", "info");
						await setPhase(ctx, "plan");
						sendPlanKickoff();
						return;
					}
					if (state.phase === "test") {
						ctx.ui.notify("workflow: approve is not used in the test phase", "info");
						return;
					}
					await approve(ctx);
					return;
				case "resume":
					await resumeFlow(ctx, rest[0]);
					return;
				case "board": {
					let rows = await collectBoard(ctx);
					if ((ctx as { mode?: string }).mode !== "tui" || !ctx.hasUI) {
						ctx.ui.notify(boardLines(rows, -1, 200, Date.now()).join("\n"), "info");
						return;
					}
					let stop = () => {};
					try {
					await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
						let selected = 0;
						let detail = false;
						let busy = false;
						let closed = false;
						const timer = setInterval(() => {
							if (busy || closed) return;
							busy = true;
							collectBoard(ctx)
								.then((r) => {
									if (closed) return;
									rows = r;
									selected = Math.min(selected, Math.max(0, rows.length - 1));
									tui.requestRender();
								})
								.catch(() => {})
								.finally(() => {
									busy = false;
								});
						}, 2_000);
						timer.unref?.();
						stop = () => {
							closed = true;
							clearInterval(timer);
						};
						const close = () => {
							stop();
							done(undefined);
						};
						return {
							render(width: number): string[] {
								const now = Date.now();
								const body = detail && rows[selected] ? detailLines(rows[selected], width, now) : boardLines(rows, selected, width, now);
								return [theme.fg("accent", `flow board · ${rows.length} flows`), ...body, theme.fg("dim", "↑↓ select · enter details · esc back/close · refreshes every 2s")].map((l) => truncateToWidth(l, width));
							},
							handleInput(data: string): void {
								if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
								else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(Math.max(0, rows.length - 1), selected + 1);
								else if (keybindings.matches(data, "tui.select.confirm")) {
									if (rows.length) detail = true;
								} else if (keybindings.matches(data, "tui.select.cancel")) {
									if (detail) detail = false;
									else {
										close();
										return;
									}
								} else return;
								tui.requestRender();
							},
							invalidate() {},
						};
					}, { overlay: true });
					} finally {
						stop();
					}
					return;
				}
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
