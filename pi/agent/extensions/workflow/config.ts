/**
 * workflow.json lives next to settings.json in ~/.pi/agent, so the pi-config
 * repo mirrors it like every other extension config. Missing keys fall back to
 * DEFAULTS; `/flow model` writes the file back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export const ROLES = ["plan", "execute", "explore", "advisor", "judge", "escalate"] as const;
export type Role = (typeof ROLES)[number];

export interface RoleSpec {
	/** `provider/model-id`, as accepted by `pi --model`. */
	model: string;
	thinking?: Thinking;
}

export interface WorkflowConfig {
	roles: Record<Role, RoleSpec>;
	/** Phase a new session starts in. */
	startPhase: "plan" | "execute" | "off";
	/** Compact once context crosses this many tokens, whatever the model's window, when the run settles (never mid-run). 0 disables. */
	contextGuardTokens: number;
	/** At the end of an execute run with an unreviewed diff: ask to run the judge, run it, or do nothing. */
	autoJudge: "ask" | "auto" | "off";
	/** Judge -> fix rounds before handing back to you. */
	maxJudgeRounds: number;
	/** After the judge passes: ask, commit, commit and push, or do nothing. */
	autoCommit: "ask" | "commit" | "push" | "off";
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
	explore: { maxQueries: number; concurrency: number; tools: string[] };
	advisor: { tools: string[]; maxTranscriptChars: number };
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
	subagent: { extensions: string[]; timeoutMs: number };
}

export const DEFAULTS: WorkflowConfig = {
	roles: {
		plan: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		execute: { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
		explore: { model: "claude-bridge/claude-haiku-5-5", thinking: "off" },
		advisor: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		judge: { model: "claude-bridge/claude-opus-5-5", thinking: "high" },
		escalate: { model: "claude-bridge/claude-fable-5-1", thinking: "high" },
	},
	startPhase: "plan",
	contextGuardTokens: 140_000,
	autoJudge: "auto",
	maxJudgeRounds: 3,
	autoCommit: "push",
	protectedBranches: ["main", "master"],
	approvePattern:
		"^(ok(ay)?[, ]+|yes[, ]+|sure[, ]+)?(go|go ahead|go for it|do it|approved?|lgtm|ship it|execute( it)?|proceed|start|let'?s go|let'?s do it|run it|implement it|build it)( now| please)?[.! ]*$",
	planPrompt: false,
	repeatedErrorThreshold: 3,
	planBlockedTools: ["edit", "write"],
	explore: { maxQueries: 8, concurrency: 4, tools: ["read", "grep", "find", "ls"] },
	advisor: { tools: ["read", "grep", "find", "ls"], maxTranscriptChars: 1_500_000 },
	judge: {
		tools: ["read", "grep", "find", "ls"],
		maxDiffChars: 400_000,
		recheck: true,
		recheckThinking: "medium",
		recheckMaxShare: 0.5,
		finalFullReviewOverChars: 80_000,
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
		return { config: merge(DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))) };
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
