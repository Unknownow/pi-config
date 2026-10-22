/**
 * workflow.json lives next to settings.json in ~/.pi/agent, so the pi-config
 * repo mirrors it like every other extension config. Missing keys fall back to
 * DEFAULTS; `/flow model` writes the file back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PLAN_TOOLS } from "./readonly-tools.ts";
import { type Delivery, isDelivery, type MergeMethod } from "./delivery.ts";
import type { TokenWeights } from "./tokens.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export const ROLES = ["plan", "execute", "explore", "advisor", "judge", "arbiter", "commit", "escalate", "test", "runner"] as const;
export type Role = (typeof ROLES)[number];

export interface RoleSpec {
	/** `provider/model-id`, as accepted by `pi --model`. */
	model: string;
	thinking?: Thinking;
}

export interface KnowledgeConfig {
	/** MCP server a pi package registers (IEC: "knowledge"). "" turns it off; off too when nothing registered it. */
	server: string;
	/** Subagent roles that get the server's tools. */
	roles: Role[];
	/** The server's tools those roles get. Never list one that writes (propose_entry). */
	tools: string[];
	/** Added to the environment of the subagents' copy of the server. */
	env: Record<string, string>;
	/** The judge's last step is the knowledge check; a skipped check gets a separate pass. */
	judgeCheck: boolean;
}

export interface DeliveryConfig {
	/** Ask at each plan approval; otherwise `default` is used. */
	ask: boolean;
	/** Listed first in the menu, chosen on Escape, and used when not asking or when executing without approval. */
	default: Delivery;
	/** One commit per function (feature, fix, refactor, ...) instead of one commit for the whole change. */
	splitCommits: boolean;
	/** `gh pr merge --<method>`. "merge" keeps the per-function commits. */
	mergeMethod: MergeMethod;
	/** `gh pr merge --delete-branch`: delete the branch, local and remote, after the merge. */
	deleteBranch: boolean;
	/** Pull request base; "" uses the branch the flow started on when it had to make a new branch, else the repo's default branch. */
	base: string;
	/** Pull request mode on a protected branch or a detached HEAD commits on a new branch: this prefix + a slug of the plan title. */
	branchPrefix: string;
	/** Where the commit step runs: a fresh subagent (`commit` role) or the main session (compacted first at the handover). */
	runner: "subagent" | "main";
}

/** "auto": the planner proposes stages itself when the work warrants them; "onRequest": only when the user asks for delivery in parts. */
export type StagedPlans = "auto" | "onRequest";

/** "changes": after a plan is proposed, planner replies repeat only what changed; "always": every reply ends with the full plan. */
export type PlanRecap = "changes" | "always";

/** Desktop notifications when a session needs the user. */
export interface NotifyConfig {
	enabled: boolean;
	/** A session idle this long after a turn notifies; a new turn cancels it. */
	idleMs: number;
}

/** Where approved plans are kept (inside each repo's .git folder) and how long. */
export interface WaitConfig {
	/** How often a waiting flow runs its check while the session is idle. */
	pollMs: number;
	/** Polling stops after this long; your next message checks again. */
	maxMs: number;
	/** A check that runs longer than this counts as not passed. */
	checkTimeoutMs: number;
	/** Continue by itself when the check passes; false only notifies. */
	autoResume: boolean;
}

export interface PlansConfig {
	/** "remote": plan refs are pushed to each repo's remote (Stage 3); "local": never pushed. */
	sync: "remote" | "local";
	/** Repos whose normalised remote URL contains one of these (case-insensitive) are never pushed. */
	localOnly: string[];
	/** Plans last updated more than this many days ago are deleted. 0 means no age limit. */
	keepDays: number;
	/** Finished plans beyond the newest this many are deleted. 0 deletes a plan as soon as its flow ends. */
	keepCount: number;
}

/** The test-and-fix flow: a supervisor (role `test`) sends `runner` subagents through the test_run tool. */
export interface TestConfig {
	/** Runners at once; tasks sharing a resource always run one after another. 1 = one at a time. */
	concurrency: number;
	/** Tasks one test_run call may carry. */
	maxTasks: number;
	/** One runner's time limit. */
	runnerTimeoutMs: number;
	/** Fix rounds before the flow asks whether to go on. 0 = no limit. */
	maxRounds: number;
	/** Failed fixes of one bug before the user is asked. */
	refails: number;
	/** Delivery after each fix round; test flows never show the delivery menu. */
	delivery: Delivery;
	/** The runners' tools (regular names; no edit or write). */
	runnerTools: string[];
	/** Extra commands the supervisor's bash may run, as regexes over the command's words. */
	supervisorBashAllow: string[];
	/** Commands runners may not run, as regexes over the command's words or the whole text. */
	runnerDeny: string[];
	/** Flags whose value is a project path that must lie inside the flow's folders. */
	runnerPathFlags: string[];
	/** Environment variable names that runners may not set (use the path flags instead). */
	runnerPathEnv: string[];
}

export interface WorkflowConfig {
	roles: Record<Role, RoleSpec>;
	/** Phase a new session starts in. */
	startPhase: "plan" | "execute" | "off";
	/** Compact once context crosses this many tokens, whatever the model's window, when the run settles (never mid-run). 0 disables. */
	contextGuardTokens: number;
	/** At a handover to execute, a minor-fix round or the next stage, compact first when the context is over this many tokens (the plan is re-sent). 0 disables. */
	handoverCompactTokens: number;
	/** At the end of an execute run with an unreviewed diff: ask to run the judge, run it, or do nothing. */
	autoJudge: "ask" | "auto" | "off";
	/** Judge -> fix rounds in a row before the flow asks you what to do. 0 means no limit. */
	maxJudgeRounds: number;
	/** After approval the planner writes one more reply, the final execution plan, which is stored and given to the judge. */
	finalizePlan: boolean;
	/** When a flow ends (delivered, passed without a commit, or stopped), switch back to the plan phase. */
	returnToPlan: boolean;
	/** The judge says the approved plan itself is flawed: "ask" you, or let the "auto" arbiter decide. */
	planFlaw: "ask" | "auto";
	/** The agent resolves waits itself (approves with a comment, acts when a non-interactive command may) and the workflow skips its routine menus; see README "Autopilot". */
	autopilot: boolean;
	/** When the planner splits a plan into stages, each executed, judged and delivered on its own. */
	stagedPlans: StagedPlans;
	/** Staged plans: "auto" starts the next stage at once, even after an incomplete delivery or a stage with no changes; "ask" asks you first. */
	stageAdvance: "auto" | "ask";
	/** How much of the plan the planner repeats in later discussion replies (needs finalizePlan; otherwise it always repeats it). */
	planRecap: PlanRecap;
	/** Amendments the arbiter may add to the plan in one flow before it asks you instead. */
	maxPlanRevisions: number;
	/** Extra judge -> fix rounds spent on minor findings after a pass, before committing anyway. 0 commits at once. */
	maxMinorRounds: number;
	/** After the judge passes: commit, push, pull request, merge or nothing, chosen for each flow at plan approval. */
	delivery: DeliveryConfig;
	/** Branches never pushed automatically; the commit stays local. */
	protectedBranches: string[];
	plans: PlansConfig;
	/** Wait points: how a flow waits for a person and checks that the wait is over. */
	wait: WaitConfig;
	/** Desktop notification when a session needs you. */
	notify: NotifyConfig;
	/** In plan phase, a message matching this (case-insensitive, whole message) approves the plan. */
	approvePattern: string;
	/** Pop up an Approve / Keep planning menu whenever a plan is ready (otherwise just a hint). */
	planPrompt: boolean;
	/** Consecutive failed tool calls before the executor is told to ask the advisor. 0 disables. */
	repeatedErrorThreshold: number;
	/** Tools switched off while planning. */
	planBlockedTools: string[];
	/** The only tools plan phase may call, as regexes over the tool name; the rest are switched off. */
	planAllowedTools: string[];
	/** In plan phase, refuse bash commands that can change files, git or GitHub (see readonly-bash.ts). */
	planReadOnlyBash: boolean;
	/** Extra commands plan phase may run, as regexes over the command's words (e.g. "^unity cmd editor_status\\b"). */
	planBashAllow: string[];
	/**
	 * Token counts in the widget and the flow summary show the raw total, with this cost-weighted
	 * figure in brackets. Each kind is weighted by its price relative to uncached input. Claude:
	 * cache reads 0.1, cache writes 1.25, output 5. All 1 makes the two figures equal.
	 */
	tokenWeights: TokenWeights;
	test: TestConfig;
	explore: {
		maxQueries: number;
		concurrency: number;
		tools: string[];
		/** Explore subagents load AGENTS.md / CLAUDE.md files when true; off keeps them cheap. */
		contextFiles: boolean;
	};
	/** Rules files of added folders: "paths" lists them in the workspace section, "full" loads them into the prompt. */
	addedFolderRules: "paths" | "full";
	advisor: { tools: string[]; maxTranscriptChars: number };
	arbiter: { tools: string[] };
	judge: {
		tools: string[];
		maxDiffChars: number;
		/** Rounds after the first review only the changes since the last round, with its findings. */
		recheck: boolean;
		/** Thinking level of those re-reviews. */
		recheckThinking: Thinking;
		/** Full review instead when the changes since the last round exceed this share of the whole diff. */
		recheckMaxShare: number;
		/** A re-review that passes a whole diff over this many characters gets one final full review. 0 disables. */
		finalFullReviewOverChars: number;
		/** The final full review runs only when the changes since the last round touched a file its findings did not cite. */
		finalFullReviewNewFilesOnly: boolean;
		/** The final full review is skipped when the changes since the last passing full review of this stage are at most this share of the whole diff. 0 never skips. */
		finalFullReviewRepeatMaxShare: number;
	};
	knowledge: KnowledgeConfig;
	subagent: {
		extensions: string[];
		timeoutMs: number;
		/** Ends a subagent that writes nothing this long while no tool runs; 0 turns it off. */
		idleTimeoutMs: number;
	};
}

export const DEFAULTS: WorkflowConfig = {
	roles: {
		plan: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		execute: { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
		explore: { model: "claude-bridge/claude-haiku-5-5", thinking: "off" },
		advisor: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		judge: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		arbiter: { model: "claude-bridge/claude-fable-5-1", thinking: "high" },
		commit: { model: "claude-bridge/claude-sonnet-5-5", thinking: "low" },
		escalate: { model: "claude-bridge/claude-fable-5-1", thinking: "high" },
		test: { model: "claude-bridge/claude-opus-5-5", thinking: "medium" },
		runner: { model: "claude-bridge/claude-haiku-5-5", thinking: "low" },
	},
	startPhase: "plan",
	contextGuardTokens: 140_000,
	handoverCompactTokens: 30_000,
	autoJudge: "auto",
	maxJudgeRounds: 5,
	maxMinorRounds: 1,
	finalizePlan: true,
	returnToPlan: true,
	planFlaw: "ask",
	autopilot: false,
	stagedPlans: "auto",
	stageAdvance: "auto",
	planRecap: "changes",
	maxPlanRevisions: 2,
	delivery: { ask: true, default: "commit", splitCommits: true, mergeMethod: "merge", deleteBranch: true, base: "", branchPrefix: "flow/", runner: "subagent" },
	protectedBranches: ["main", "master"],
	plans: { sync: "remote", localOnly: [], keepDays: 14, keepCount: 50 },
	wait: { pollMs: 120_000, maxMs: 3_600_000, checkTimeoutMs: 30_000, autoResume: true },
	notify: { enabled: true, idleMs: 10_000 },
	approvePattern:
		"^((ok(ay)?|yes|yeah|yep|sure|alright|fine|great|good)[,.! ]+)?(then[, ]+)?(go|go ahead|go for it|do it|do that|do this|do them|do (it )?all( of (it|that|them))?|approved?|lgtm|ship it|execute( it| that| this| the plan)?|proceed|start|let'?s go|let'?s do it|run it|implement( it| that| this| the plan)?|build it|make it so)( for me)?( now)?( please)?[.! ]*$",
	planPrompt: true,
	repeatedErrorThreshold: 3,
	planBlockedTools: ["edit", "write"],
	planAllowedTools: PLAN_TOOLS,
	planReadOnlyBash: true,
	planBashAllow: ["^unity (cmd )?(editor_status|console_status)\\b"],
	tokenWeights: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	test: {
		concurrency: 4,
		maxTasks: 8,
		runnerTimeoutMs: 45 * 60_000,
		maxRounds: 3,
		refails: 2,
		delivery: "commit",
		runnerTools: ["bash", "read", "grep", "find", "ls"],
		supervisorBashAllow: ["^adb( -[sdetHP] \\S+)* (devices|shell getprop)\\b", "^unity (cmd )?(status|editor_status|console_status)\\b"],
		runnerDeny: [
			"^adb( -[sdetHP] \\S+)* (reboot|reboot-bootloader|sideload|root|unroot|remount|disable-verity|enable-verity)\\b",
			"^adb\\b.*\\bshell\\b.*(\\brm\\s+-[a-z]*r|\\bwipe\\b|\\brecovery\\b|\\bfactory\\b|\\bformat\\b|\\breboot\\b)",
			"^fastboot\\b",
		],
		runnerPathFlags: ["--project-path", "-projectPath"],
		runnerPathEnv: ["UNITY_PROJECT_PATH"],
	},
	explore: { maxQueries: 8, concurrency: 8, tools: ["read", "grep", "find", "ls"], contextFiles: false },
	addedFolderRules: "paths",
	advisor: { tools: ["read", "grep", "find", "ls"], maxTranscriptChars: 1_500_000 },
	arbiter: { tools: ["read", "grep", "find", "ls"] },
	judge: {
		tools: ["read", "grep", "find", "ls"],
		maxDiffChars: 400_000,
		recheck: true,
		recheckThinking: "medium",
		recheckMaxShare: 0.5,
		finalFullReviewOverChars: 80_000,
		finalFullReviewNewFilesOnly: true,
		finalFullReviewRepeatMaxShare: 0.1,
	},
	knowledge: {
		server: "knowledge",
		roles: ["explore", "advisor", "judge", "arbiter"],
		tools: ["search", "get_entry", "get_rule_pack", "get_schema", "status"],
		env: { KNOWLEDGE_OFFLINE: "1" },
		judgeCheck: true,
	},
	subagent: {
		extensions: ["~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts"],
		timeoutMs: 15 * 60_000,
		idleTimeoutMs: 5 * 60_000,
	},
};

export const CONFIG_PATH = path.join(getAgentDir(), "workflow.json");

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars replace. */
function merge<T>(base: T, over: unknown): T {
	if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) {
		if (k.startsWith("_")) continue;
		out[k] = k in base ? merge((base as Record<string, unknown>)[k], v) : v;
	}
	return out as T;
}

type Loaded = { config: WorkflowConfig; error?: string };
let cache: { file: string; key: string; result: Loaded } | null = null;

/** Parsed again only when the file's mtime, ctime or size changed; `saveRole` clears the cache. */
export function loadConfig(file = CONFIG_PATH): Loaded {
	let key: string;
	try {
		const st = fs.statSync(file);
		key = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
	} catch {
		cache = null;
		return { config: DEFAULTS };
	}
	if (cache && cache.file === file && cache.key === key) return cache.result;
	const result = parseConfig(file);
	cache = { file, key, result };
	return result;
}

function parseConfig(file: string): Loaded {
	try {
		const config = merge(DEFAULTS, JSON.parse(fs.readFileSync(file, "utf8")));
		// A delivery that is not an object (the old autoCommit style, null) would crash the first approval.
		if (!isObject(config.delivery)) config.delivery = DEFAULTS.delivery;
		for (const k of ["base", "branchPrefix"] as const) if (typeof config.delivery[k] !== "string") config.delivery[k] = DEFAULTS.delivery[k];
		if (config.delivery.runner !== "subagent" && config.delivery.runner !== "main") config.delivery.runner = DEFAULTS.delivery.runner;
		if (isObject(config.subagent) && (typeof config.subagent.idleTimeoutMs !== "number" || !Number.isFinite(config.subagent.idleTimeoutMs) || config.subagent.idleTimeoutMs < 0)) config.subagent.idleTimeoutMs = DEFAULTS.subagent.idleTimeoutMs;
		if (typeof config.handoverCompactTokens !== "number" || !Number.isFinite(config.handoverCompactTokens) || config.handoverCompactTokens < 0) config.handoverCompactTokens = DEFAULTS.handoverCompactTokens;
		if (!isObject(config.plans)) config.plans = DEFAULTS.plans;
		if (config.plans.sync !== "remote" && config.plans.sync !== "local") config.plans.sync = DEFAULTS.plans.sync;
		if (!Array.isArray(config.plans.localOnly) || config.plans.localOnly.some((s) => typeof s !== "string")) config.plans.localOnly = DEFAULTS.plans.localOnly;
		for (const k of ["keepDays", "keepCount"] as const) if (typeof config.plans[k] !== "number" || !Number.isFinite(config.plans[k]) || config.plans[k] < 0) config.plans[k] = DEFAULTS.plans[k];
		if (!isObject(config.explore)) config.explore = DEFAULTS.explore;
		if (typeof config.explore.contextFiles !== "boolean") config.explore.contextFiles = DEFAULTS.explore.contextFiles;
		if (config.addedFolderRules !== "paths" && config.addedFolderRules !== "full") config.addedFolderRules = DEFAULTS.addedFolderRules;
		if (typeof config.autopilot !== "boolean") config.autopilot = DEFAULTS.autopilot;
		if (!isObject(config.wait)) config.wait = DEFAULTS.wait;
		for (const k of ["pollMs", "maxMs", "checkTimeoutMs"] as const) if (typeof config.wait[k] !== "number" || !Number.isFinite(config.wait[k]) || config.wait[k] <= 0) config.wait[k] = DEFAULTS.wait[k];
		if (typeof config.wait.autoResume !== "boolean") config.wait.autoResume = DEFAULTS.wait.autoResume;
		if (!isObject(config.notify)) config.notify = DEFAULTS.notify;
		if (typeof config.notify.enabled !== "boolean") config.notify.enabled = DEFAULTS.notify.enabled;
		if (typeof config.notify.idleMs !== "number" || !Number.isFinite(config.notify.idleMs) || config.notify.idleMs <= 0) config.notify.idleMs = DEFAULTS.notify.idleMs;
		if (config.stagedPlans !== "auto" && config.stagedPlans !== "onRequest") config.stagedPlans = DEFAULTS.stagedPlans;
		if (config.stageAdvance !== "auto" && config.stageAdvance !== "ask") config.stageAdvance = DEFAULTS.stageAdvance;
		if (config.planRecap !== "changes" && config.planRecap !== "always") config.planRecap = DEFAULTS.planRecap;
		const t = (config.test = isObject(config.test) ? config.test : DEFAULTS.test);
		const num = (v: unknown, min: number, max = Infinity): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
		if (!num(t.concurrency, 1)) t.concurrency = DEFAULTS.test.concurrency;
		if (!num(t.maxTasks, 1, 16)) t.maxTasks = DEFAULTS.test.maxTasks;
		if (typeof t.runnerTimeoutMs !== "number" || !Number.isFinite(t.runnerTimeoutMs) || t.runnerTimeoutMs < 60_000) t.runnerTimeoutMs = DEFAULTS.test.runnerTimeoutMs;
		if (!num(t.maxRounds, 0)) t.maxRounds = DEFAULTS.test.maxRounds;
		if (!num(t.refails, 1)) t.refails = DEFAULTS.test.refails;
		if (!isDelivery(t.delivery)) t.delivery = DEFAULTS.test.delivery;
		for (const k of ["runnerTools", "supervisorBashAllow", "runnerDeny", "runnerPathFlags", "runnerPathEnv"] as const) {
			if (!Array.isArray(t[k]) || t[k].some((s) => typeof s !== "string")) t[k] = DEFAULTS.test[k];
		}
		return { config };
	} catch (e) {
		return { config: DEFAULTS, error: `${file}: ${(e as Error).message}` };
	}
}

/** Updates one role in workflow.json, leaving the rest of the file as it was. */
export function saveRole(role: Role, spec: RoleSpec, file = CONFIG_PATH): void {
	const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	raw.roles = { ...(raw.roles ?? {}), [role]: spec };
	fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
	cache = null;
}

/** `provider/id[:thinking]` -> RoleSpec. */
export function parseRoleSpec(input: string): RoleSpec | string {
	const m = input.trim().match(/^([^/\s]+\/[^:\s]+)(?::(\w+))?$/);
	if (!m) return `expected provider/model-id[:thinking], got "${input}"`;
	const thinking = m[2] as Thinking | undefined;
	if (thinking && !THINKING_LEVELS.includes(thinking)) return `thinking must be one of ${THINKING_LEVELS.join(", ")}`;
	return thinking ? { model: m[1], thinking } : { model: m[1] };
}

export function describeRole(spec: RoleSpec): string {
	return `${spec.model}${spec.thinking ? `:${spec.thinking}` : ""}`;
}
