/** The workflow's shared context: `Flow` (the session's state, created once in index.ts and passed to every flow/ module as `fl`), the persisted `FlowState` and the types and helpers the modules share. */
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROLES, CONFIG_PATH, loadConfig, type WorkflowConfig } from "../config.ts";
import type { PlanDraft } from "../agent-end.ts";
import type { Tok } from "../../shared/tokens.ts";
import type { PlanGate, DiscussionReview, Finding } from "../gates.ts";
import type { ChecklistItem, Finished, PlanStatus } from "../plan-doc.ts";
import type { LiveInfo } from "../board.ts";
import type { FlowFinding } from "../flow-report.ts";
import { MetricsQueue } from "../metrics.ts";
import { type DiffPart, emptyUsage } from "../../agents/api.ts";
import type { Deviation } from "../knowledge.ts";
import { type Stage, type FlowUsage, FlowView } from "../view.ts";

export type Phase = "off" | "discuss" | "plan" | "execute";

export interface FlowState {
	phase: Phase;
	/** Main session is on the escalate model instead of the phase's own. */
	escalated: boolean;
	judgeRounds: number;
	/** Rounds spent fixing minor findings of passed reviews since the last commit. */
	minorRounds?: number;
	/** Diff the last minor-fix message was sent for. */
	minorSentFor?: string;
	/** The passed tree per repo and the files the minor findings cite: a fix that touches only those files needs no re-review. */
	minorFix?: { trees: Record<string, string>; cited: string[]; text: string };
	/** Late findings (new problems a recheck found outside the changed lines, not blockers): listed on the final card, never blocking. */
	lateFindings?: string[];
	/** Autopilot: judge caps taken, automatic retries in a row, and the decisions listed on the final card. */
	autoCaps?: number;
	autoRetries?: number;
	autoDecisions?: string[];
	/** Hash of the last diff the judge passed. */
	passedDiff?: string;
	/** The last judge round, so the next one reviews only what changed since. */
	lastJudge?: LastJudge;
	/** The last full review that passed in this stage. */
	lastFullPass?: { repos: Snaps; base: string };
	/** Active tools before plan mode switched some off. */
	toolsBeforePlan?: string[];
	/** The main session's model and thinking level before the flow started, restored when it ends. */
	preFlowModel?: { model: string; thinking?: string };
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
	/** The flow waits for a person (and maybe a check) before it continues; no judge, delivery or stage advance meanwhile. */
	waiting?: { waitKind?: "external"; reason: string; check?: string; step?: string; stage?: number; since: string; planned: boolean; atStageStart?: boolean; checkPassed?: boolean; held?: string };
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
	/** What the automatic plan judge knows about the plan on screen: its hash, runs, open findings and the text it judged. */
	planGate?: PlanGate;
	/** The discussion gate's last review (the list it judged, its findings, and whether a fix round is open). */
	discussionReview?: DiscussionReview;
}

export interface LastJudge {
	/** Hash of the full diff it reviewed. */
	hash: string;
	/** Per repo (key: repoKey(root)): the working tree it reviewed, as a git tree id, and HEAD then. Absent in state saved by older versions. */
	repos?: Record<string, { tree: string; head: string }>;
	base: string;
	verdict: "PASS" | "FAIL";
	/** The judge's reply, in agents' findings format; text saved by older versions parses as no findings. */
	text: string;
}

export interface LastKnowledge {
	/** Hash of the diff it checked. */
	hash: string;
	status: "checked" | "skipped" | "unavailable";
	reason?: string;
	deviations: Deviation[];
}

export const STATE_ENTRY = "workflow-state";

/** Public contract K1: the session's working folder and added folders, `{ v: 1, cwd, folders }`. The workflow is its only writer. */
export const FOLDERS_ENTRY = "session-folders";

/** Display-only entry (never sent to the model) with the token breakdown of a finished flow. */
export const SUMMARY_ENTRY = "workflow-summary";

export const APPROVED_FINAL = "The final plan is approved. Execute it exactly, step by step, following the workflow rules.";

/** The judge reads at most this much of the plan; the end (the arbiter's amendments) is kept. */
export const MAX_PLAN_CHARS = 60_000;

/** Roles `/flow model` sets (workflow.json); explore, advisor, runner, judge and critic are the agents extension's (`/agents model`). */
export const MODEL_ROLES: readonly string[] = ROLES;

export const OWN_TOOLS = new Set(["explore", "advisor", "judge", "critic"]);

export const execFileAsync = promisify(execFile);

/** Subagent-only extension that registers forwarded MCP servers (see mcp-forward.ts). */
export const FORWARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "agents", "mcp-forward.ts");

/** Subagent-only extension that guards the git_task subagent's git and gh commands (see git-guard.ts). */
export const GIT_GUARD_EXTENSION = path.join(path.dirname(CONFIG_PATH), "extensions", "workflow", "git-guard.ts");

export interface Diff {
	/** The whole diff (several repos: each section headed `=== repo: <root> ===`); hashed, never sent as is. */
	text: string;
	/** The diff per repo, as agents' judge takes it (fitted to agents.json `judge.maxDiffChars`). */
	parts: DiffPart[];
	hash: string;
	files: number;
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

export interface RepoRef {
	root: string;
	/** Where git runs for it: the session's working folder for the primary repo, else the root. */
	dir: string;
	changed: boolean;
}

export type Snaps = Record<string, { tree: string; head: string }>;

export function assistantText(m: AgentMessage | undefined): string {
	if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
	return m.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join("\n");
}

export function countFindings(findings: Finding[]): { total: number; late: number } {
	const late = findings.filter((f) => f.late).length;
	return { total: findings.length - late, late };
}

/** The paths a judge report's findings cite (`` `path:line` `` in their heads), with `/` separators. */
export function citedPaths(findings: Finding[]): string[] {
	const out = new Set<string>();
	for (const f of findings) {
		const m = /`([^`]+?):\d+(?:-\d+)?`/.exec(f.head);
		if (m) out.add(m[1].replace(/\\/g, "/"));
	}
	return [...out];
}

/** Why a running gate was aborted. */
export type GateAbort = "esc" | "command" | "message" | "phase" | "restart";

export interface JudgeResult {
	verdict: "PASS" | "FAIL" | "ERROR";
	text: string;
	/** The findings of `text` (agents' format); [] for an error or a pass without a review. */
	findings: Finding[];
	hash: string;
	usage: ReturnType<typeof emptyUsage>;
}

export type ReviewPlan =
	| { kind: "full"; snaps: Snaps | null }
	| { kind: "recheck"; snaps: Snaps; prev: LastJudge; delta: string; parts: DiffPart[]; changed: string[]; cites: string[] }
	| { kind: "same"; prev: LastJudge };

export interface PlanSnap {
	flowId: string;
	rev: number;
	roots: string[];
	plan: string;
	checklist?: ChecklistItem[];
	stage?: number;
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

export type ToolReply = { content: { type: "text"; text: string }[]; details: object };

/** The workflow's session state: everything `workflow(pi)` used to hold in its closure. Created once per extension load. */
export interface Flow {
	pi: ExtensionAPI;
	cfg: WorkflowConfig;
	configError: string | undefined;
	/** The old-keys warning of workflow.json already shown this session. */
	configWarning: string | undefined;
	state: FlowState;
	/** Diffs already judged or declined this session, so agent_end doesn't ask twice. */
	seenDiffs: Set<string>;
	consecutiveErrors: number;
	/** The planner's last reply has a "Plan:" section and no open question; only then does a typed "go" / "do it" approve. */
	planReady: boolean;
	/** The plan's broken wait checks were already sent back to the planner once. */
	planWaitRetried: boolean;
	/** Wait checks of the current plan that can't run; they block approval. */
	planWaitNow: string[];
	/** A planner reply in the current plan phase was a full `## Plan:`; a typed "go" then approves later replies without one. Reset when the phase changes. */
	planProposed: boolean;
	/** The full plan and the change sections after it; the approved plan. */
	planDraft: PlanDraft;
	guardTokens: number | null;
	compacting: boolean;
	/** The guard threshold was crossed during a run; compact when the run settles. */
	compactPending: boolean;
	/** A handover message (execute, fix round, next stage) sent from agent_end; it goes out when the run settles, after an optional compaction. */
	pendingHandover: { customType: string; content: string } | undefined;
	/** nesting depth: a run can end while a handler still waits on a subagent */
	inAgentEnd: number;
	/** The automatic judge gate that runs now (not persisted: a restart drops it). Only one at a time. */
	gateRun: { kind: "discussion" | "plan"; controller: AbortController; offEsc?: () => void; judgedHash: string; reason?: GateAbort } | undefined;
	/** A "go" typed while the plan judge ran or the planner fixed its findings: it approves only after a clean PASS. */
	planApproveQueued: boolean;
	/** The planner is fixing the plan judge's findings (between the fix message and the next reply). */
	planFixing: boolean;
	/** An overflow compaction is retrying the turn; the bridge may answer that retry with an empty reply. */
	overflowRetry: boolean;
	/** Automatic resumes since the user's last prompt. */
	resumes: number;
	/** /flow autopilot sets this for the session; it is not persisted, so a restart falls back to the config. */
	autopilotOverride: boolean | undefined;
	view: FlowView;
	lastCtx: ExtensionContext | undefined;
	lastStatusEvent: string;
	/** The read-only tool set of plan phase. */
	publishCache: { key: string; value: boolean } | undefined;
	rootCache: Map<string, string>;
	goneBases: Set<string>;
	/** Review-base refs written this session by repo key, so the end of the flow can delete them. */
	reviewRefs: Map<string, { dir: string; flowId: string }>;
	/** Metrics wait here until the flow has a plan folder. */
	metrics: MetricsQueue;
	/** True while handling the end of a run the user aborted: stageAdvance "auto" must not move on then. */
	turnAborted: boolean;
	ghNoticed: boolean;
	/** The list hash the discuss model was already asked to restate; one restate per list. */
	restateAskedFor: string | undefined;
	notify: {
		lastNotifyAt: number | undefined;
		/** a notification already went out for this turn */
		notifiedSinceStart: boolean;
		idleTimer: ReturnType<typeof setTimeout> | undefined;
	};
	plan: {
		/** Where each flow's plan folder lives, and what was last written there (so the file can be rewritten without git calls). */
		planDirs: Map<string, string>;
		planLast: Map<string, { dir: string; status: PlanStatus }>;
		planWarned: Set<string>;
		planChain: Promise<void>;
		/** Plan folder per repo root: `plansDir` runs git, and the answer does not change during a session. */
		plansDirCache: Map<string, string>;
	};
	claim: {
		/** S2: this session's claim on its unfinished flow, rewritten every 60 s so others can tell it is alive. */
		claimedFlow: string | undefined;
		claimTimer: ReturnType<typeof setInterval> | undefined;
		claimCwd: string;
	};
	live: {
		/** The flow's `live.json`: what the board shows of this session. Written on change and every 60 s. */
		liveLast: LiveInfo | undefined;
		liveLastJson: string;
		liveLastWrite: number;
		liveEventLog: { at: string; text: string }[];
		liveTimer: ReturnType<typeof setInterval> | undefined;
		liveFlow: string | undefined;
		liveRegistered: Set<string>;
	};
	wait: {
		waitTimer: ReturnType<typeof setInterval> | undefined;
		waitTimerStart: number;
		waitFirstTimer: ReturnType<typeof setTimeout> | undefined;
		/** First wait of each Publish/Mirror step, so the wait's time limit counts across blocked retries. */
		publishWaitSince: Map<string, string>;
		waitChecking: boolean;
		/** pi's own bash (Git Bash on Windows), looked up once; a failed lookup is cached too. */
		waitShell: { shell: string; args: string[] } | { error: string } | undefined;
	};
}

export function createFlow(pi: ExtensionAPI): Flow {
	const { config: cfg, error: configError } = loadConfig();
	return {
		pi,
		cfg,
		configError,
		configWarning: undefined,
		state: { phase: "off", escalated: false, judgeRounds: 0 },
		seenDiffs: new Set<string>(),
		consecutiveErrors: 0,
		planReady: false,
		planWaitRetried: false,
		planWaitNow: [],
		planProposed: false,
		planDraft: { full: "", changes: [] },
		guardTokens: null,
		compacting: false,
		compactPending: false,
		pendingHandover: undefined,
		inAgentEnd: 0,
		gateRun: undefined,
		planApproveQueued: false,
		planFixing: false,
		overflowRetry: false,
		resumes: 0,
		autopilotOverride: undefined,
		view: new FlowView(cfg.roles),
		lastCtx: undefined,
		lastStatusEvent: "",
		publishCache: undefined,
		rootCache: new Map<string, string>(),
		goneBases: new Set<string>(),
		reviewRefs: new Map<string, { dir: string; flowId: string }>(),
		metrics: new MetricsQueue(),
		turnAborted: false,
		ghNoticed: false,
		restateAskedFor: undefined,
		notify: {
			lastNotifyAt: undefined,
			notifiedSinceStart: false,
			idleTimer: undefined,
		},
		plan: {
			planDirs: new Map<string, string>(),
			planLast: new Map<string, { dir: string; status: PlanStatus }>(),
			planWarned: new Set<string>(),
			planChain: Promise.resolve(),
			plansDirCache: new Map<string, string>(),
		},
		claim: {
			claimedFlow: undefined,
			claimTimer: undefined,
			claimCwd: "",
		},
		live: {
			liveLast: undefined,
			liveLastJson: "",
			liveLastWrite: 0,
			liveEventLog: [],
			liveTimer: undefined,
			liveFlow: undefined,
			liveRegistered: new Set<string>(),
		},
		wait: {
			waitTimer: undefined,
			waitTimerStart: 0,
			waitFirstTimer: undefined,
			publishWaitSince: new Map<string, string>(),
			waitChecking: false,
			waitShell: undefined,
		},
	};
}
