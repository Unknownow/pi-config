/**
 * workflow.json lives next to settings.json in ~/.pi/agent, so the pi-config
 * repo mirrors it like every other extension config. Missing keys fall back to
 * DEFAULTS; `/flow model` writes the file back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PLAN_TOOLS } from "./readonly-tools.ts";
import type { Delivery, MergeMethod } from "./delivery.ts";
import type { TokenWeights } from "./tokens.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export const ROLES = ["plan", "execute", "explore", "advisor", "judge", "arbiter", "escalate"] as const;
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
}

/** "auto": the planner proposes stages itself when the work warrants them; "onRequest": only when the user asks for delivery in parts. */
export type StagedPlans = "auto" | "onRequest";

/** "changes": after a plan is proposed, planner replies repeat only what changed; "always": every reply ends with the full plan. */
export type PlanRecap = "changes" | "always";

export interface WorkflowConfig {
	roles: Record<Role, RoleSpec>;
	/** Phase a new session starts in. */
	startPhase: "plan" | "execute" | "off";
	/** Compact once context crosses this many tokens, whatever the model's window, when the run settles (never mid-run). 0 disables. */
	contextGuardTokens: number;
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
	/** When the planner splits a plan into stages, each executed, judged and delivered on its own. */
	stagedPlans: StagedPlans;
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
	explore: { maxQueries: number; concurrency: number; tools: string[] };
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
	};
	knowledge: KnowledgeConfig;
	subagent: { extensions: string[]; timeoutMs: number };
}

export const DEFAULTS: WorkflowConfig = {
	roles: {
		plan: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		execute: { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
		explore: { model: "claude-bridge/claude-haiku-5-5", thinking: "off" },
		advisor: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		judge: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		arbiter: { model: "claude-bridge/claude-fable-5-1", thinking: "high" },
		escalate: { model: "claude-bridge/claude-fable-5-1", thinking: "high" },
	},
	startPhase: "plan",
	contextGuardTokens: 140_000,
	autoJudge: "auto",
	maxJudgeRounds: 5,
	maxMinorRounds: 2,
	finalizePlan: true,
	returnToPlan: true,
	planFlaw: "ask",
	stagedPlans: "auto",
	planRecap: "changes",
	maxPlanRevisions: 2,
	delivery: { ask: true, default: "commit", splitCommits: true, mergeMethod: "merge", deleteBranch: true, base: "", branchPrefix: "flow/" },
	protectedBranches: ["main", "master"],
	approvePattern:
		"^((ok(ay)?|yes|yeah|yep|sure|alright|fine|great|good)[,.! ]+)?(then[, ]+)?(go|go ahead|go for it|do it|do that|do this|do them|do (it )?all( of (it|that|them))?|approved?|lgtm|ship it|execute( it| that| this| the plan)?|proceed|start|let'?s go|let'?s do it|run it|implement( it| that| this| the plan)?|build it|make it so)( for me)?( now)?( please)?[.! ]*$",
	planPrompt: true,
	repeatedErrorThreshold: 3,
	planBlockedTools: ["edit", "write"],
	planAllowedTools: PLAN_TOOLS,
	planReadOnlyBash: true,
	planBashAllow: ["^unity (cmd )?(editor_status|console_status)\\b"],
	tokenWeights: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	explore: { maxQueries: 8, concurrency: 4, tools: ["read", "grep", "find", "ls"] },
	advisor: { tools: ["read", "grep", "find", "ls"], maxTranscriptChars: 1_500_000 },
	arbiter: { tools: ["read", "grep", "find", "ls"] },
	judge: {
		tools: ["read", "grep", "find", "ls"],
		maxDiffChars: 400_000,
		recheck: true,
		recheckThinking: "medium",
		recheckMaxShare: 0.5,
		finalFullReviewOverChars: 80_000,
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

export function loadConfig(): { config: WorkflowConfig; error?: string } {
	if (!fs.existsSync(CONFIG_PATH)) return { config: DEFAULTS };
	try {
		const config = merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
		// A delivery that is not an object (the old autoCommit style, null) would crash the first approval.
		if (!isObject(config.delivery)) config.delivery = DEFAULTS.delivery;
		for (const k of ["base", "branchPrefix"] as const) if (typeof config.delivery[k] !== "string") config.delivery[k] = DEFAULTS.delivery[k];
		if (config.stagedPlans !== "auto" && config.stagedPlans !== "onRequest") config.stagedPlans = DEFAULTS.stagedPlans;
		if (config.planRecap !== "changes" && config.planRecap !== "always") config.planRecap = DEFAULTS.planRecap;
		return { config };
	} catch (e) {
		return { config: DEFAULTS, error: `${CONFIG_PATH}: ${(e as Error).message}` };
	}
}

/** Updates one role in workflow.json, leaving the rest of the file as it was. */
export function saveRole(role: Role, spec: RoleSpec): void {
	const raw = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) : {};
	raw.roles = { ...(raw.roles ?? {}), [role]: spec };
	fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`);
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
