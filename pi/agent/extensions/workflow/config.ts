/**
 * workflow.json lives next to settings.json in ~/.pi/agent, so the pi-config
 * repo mirrors it like every other extension config. Missing keys fall back to
 * DEFAULTS; `/flow model` writes the file back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { UNITY_PLAN_ALLOW } from "./readonly-bash.ts";
import { PLAN_TOOLS } from "./readonly-tools.ts";
import type { MergeMethod } from "./delivery.ts";
import type { TokenWeights } from "./tokens.ts";
import { type KnowledgeConfig, type RoleSpec, type Thinking, THINKING_LEVELS } from "../agents/types.ts";

export { THINKING_LEVELS };
export type { KnowledgeConfig, RoleSpec, Thinking };

/** Roles of workflow.json; explore, advisor and runner live in agents.json (extensions/agents). */
export const ROLES = ["discuss", "plan", "execute", "judge", "arbiter", "commit", "escalate", "test"] as const;
export type Role = (typeof ROLES)[number];

/** Guidance for the executor's own commit, push, pull request and merge. Merging, pushing to a protected branch and publishing still wait for a judge pass; a plan line `Delivery: no merge` turns them off for a flow. */
export interface DeliveryConfig {
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
}

/** "auto": the planner proposes stages itself when the work warrants them; "onRequest": only when the user asks for delivery in parts. */
export type StagedPlans = "auto" | "onRequest";

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

/** The test-and-fix flow: a supervisor (role `test`) sends runners through the test_run tool (settings in agents.json). */
export interface TestConfig {
	/** Fix rounds before the flow asks whether to go on. 0 = no limit. */
	maxRounds: number;
	/** Failed fixes of one bug before the user is asked. */
	refails: number;
	/** Extra commands the supervisor's bash may run, as regexes over the command's words. */
	supervisorBashAllow: string[];
}

export interface WorkflowConfig {
	roles: Record<Role, RoleSpec>;
	/** Phase a new session starts in. */
	startPhase: "discuss" | "plan" | "execute" | "test" | "off";
	/** Compact once context crosses this many tokens, whatever the model's window, when the run settles (never mid-run). 0 disables. */
	contextGuardTokens: number;
	/** At a handover to execute, a minor-fix round or the next stage, compact first when the context is over this many tokens (the plan is re-sent). 0 disables. */
	handoverCompactTokens: number;
	/** At the end of an execute run with an unreviewed diff: ask to run the judge, run it, or do nothing. */
	autoJudge: "ask" | "auto" | "off";
	/** Judge -> fix rounds in a row before the flow asks you what to do. 0 means no limit. */
	maxJudgeRounds: number;
	/** When a flow ends (delivered, passed without a commit, or stopped), switch to this phase ("off" stays in execute). */
	returnTo: "discuss" | "plan" | "off";
	/** The judge says the approved plan itself is flawed: "ask" you, or let the "auto" arbiter decide. */
	planFlaw: "ask" | "auto";
	/** The agent resolves waits itself (approves with a comment, acts when a non-interactive command may) and the workflow skips its routine menus; see README "Autopilot". */
	autopilot: boolean;
	/** When the planner splits a plan into stages, each executed, judged and delivered on its own. */
	stagedPlans: StagedPlans;
	/** Staged plans: "auto" starts the next stage at once, even after an incomplete delivery or a stage with no changes; "ask" asks you first. */
	stageAdvance: "auto" | "ask";
	/** Amendments the arbiter may add to the plan in one flow before it asks you instead. */
	maxPlanRevisions: number;
	/** Extra judge -> fix rounds spent on minor findings after a pass, before committing anyway. 0 commits at once. */
	maxMinorRounds: number;
	/** After the judge passes: commit, push, pull request, merge or nothing, chosen for each flow at plan approval. */
	delivery: DeliveryConfig;
	/** Protected branches: a push to one, like a merge, needs a judge pass on its exact tree. */
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
	/** Rules files of added folders: "paths" lists them in the workspace section, "full" loads them into the prompt. */
	addedFolderRules: "paths" | "full";
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
		discuss: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		plan: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		execute: { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
		judge: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		arbiter: { model: "claude-bridge/claude-fable-5-1", thinking: "high" },
		commit: { model: "claude-bridge/claude-haiku-5-5", thinking: "medium" },
		escalate: { model: "claude-bridge/claude-fable-5-1", thinking: "high" },
		test: { model: "claude-bridge/claude-opus-5-5", thinking: "medium" },
	},
	startPhase: "discuss",
	contextGuardTokens: 140_000,
	handoverCompactTokens: 30_000,
	autoJudge: "auto",
	maxJudgeRounds: 5,
	maxMinorRounds: 1,
	returnTo: "discuss",
	planFlaw: "ask",
	autopilot: false,
	stagedPlans: "auto",
	stageAdvance: "auto",
	maxPlanRevisions: 2,
	delivery: { splitCommits: true, mergeMethod: "merge", deleteBranch: true, base: "", branchPrefix: "flow/" },
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
	planBashAllow: UNITY_PLAN_ALLOW,
	tokenWeights: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	test: {
		maxRounds: 3,
		refails: 2,
		supervisorBashAllow: ["^adb( -[sdetHP] \\S+)* (devices|shell getprop)\\b", "^unity (cmd )?(status|editor_status|console_status)\\b"],
	},
	addedFolderRules: "paths",
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
		roles: ["judge", "arbiter"],
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
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		const config = merge(DEFAULTS, raw);
		const rawObj = isObject(raw) ? (raw as Record<string, unknown>) : {};
		const isReturn = (v: unknown): v is WorkflowConfig["returnTo"] => v === "discuss" || v === "plan" || v === "off";
		if (isReturn(rawObj.returnTo)) config.returnTo = rawObj.returnTo;
		else config.returnTo = DEFAULTS.returnTo;
		// Keys of removed settings (the finalize rewrite, the plan recap, the old boolean returnToPlan) are dropped silently.
		for (const old of ["finalizePlan", "planRecap", "returnToPlan"]) delete (config as unknown as Record<string, unknown>)[old];
		if (!["discuss", "plan", "execute", "test", "off"].includes(config.startPhase)) config.startPhase = DEFAULTS.startPhase;
		// A delivery that is not an object (the old autoCommit style, null) would crash the first approval.
		if (!isObject(config.delivery)) config.delivery = DEFAULTS.delivery;
		for (const k of ["base", "branchPrefix"] as const) if (typeof config.delivery[k] !== "string") config.delivery[k] = DEFAULTS.delivery[k];
		// Keys of the removed delivery menu and commit step: ignored.
		for (const k of ["ask", "default", "runner"]) delete (config.delivery as unknown as Record<string, unknown>)[k];
		if (isObject(config.subagent) && (typeof config.subagent.idleTimeoutMs !== "number" || !Number.isFinite(config.subagent.idleTimeoutMs) || config.subagent.idleTimeoutMs < 0)) config.subagent.idleTimeoutMs = DEFAULTS.subagent.idleTimeoutMs;
		if (typeof config.handoverCompactTokens !== "number" || !Number.isFinite(config.handoverCompactTokens) || config.handoverCompactTokens < 0) config.handoverCompactTokens = DEFAULTS.handoverCompactTokens;
		if (!isObject(config.plans)) config.plans = DEFAULTS.plans;
		if (config.plans.sync !== "remote" && config.plans.sync !== "local") config.plans.sync = DEFAULTS.plans.sync;
		if (!Array.isArray(config.plans.localOnly) || config.plans.localOnly.some((s) => typeof s !== "string")) config.plans.localOnly = DEFAULTS.plans.localOnly;
		for (const k of ["keepDays", "keepCount"] as const) if (typeof config.plans[k] !== "number" || !Number.isFinite(config.plans[k]) || config.plans[k] < 0) config.plans[k] = DEFAULTS.plans[k];
		// Settings that moved to agents.json (the explore, advisor and runner roles and blocks, the runner keys of test) are dropped silently.
		for (const old of ["explore", "advisor"]) delete (config as unknown as Record<string, unknown>)[old];
		for (const old of ["explore", "advisor", "runner"]) delete (config.roles as unknown as Record<string, unknown>)[old];
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
		const t = (config.test = isObject(config.test) ? config.test : DEFAULTS.test);
		const num = (v: unknown, min: number, max = Infinity): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
		for (const old of ["concurrency", "maxTasks", "runnerTimeoutMs", "runnerTools", "runnerDeny", "runnerPathFlags", "runnerPathEnv"]) delete (t as unknown as Record<string, unknown>)[old];
		if (!num(t.maxRounds, 0)) t.maxRounds = DEFAULTS.test.maxRounds;
		if (!num(t.refails, 1)) t.refails = DEFAULTS.test.refails;
		delete (t as unknown as Record<string, unknown>).delivery;
		if (!Array.isArray(t.supervisorBashAllow) || t.supervisorBashAllow.some((s) => typeof s !== "string")) t.supervisorBashAllow = DEFAULTS.test.supervisorBashAllow;
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
