/** orchestrate.json lives next to workflow.json in the agent dir. Missing keys fall back to DEFAULTS; a bad value falls back with a warning. */

import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome } from "../agents/subagent.ts";
import { type RoleSpec, THINKING_LEVELS, parseRoleSpec } from "../shared/roles.ts";

export interface OrchestrateConfig {
	/** Sub-sessions running at once. */
	maxSubs: number;
	/** Seconds between git and status checks. */
	pollSeconds: number;
	/** Minutes without any change in execute before a sub-session counts as stalled. */
	stallMinutes: number;
	/** Ask the person before a plan is approved. */
	confirmPlans: boolean;
	/** Consecutive plan rejections in one planning round before the next review goes to the user. */
	maxPlanRejections: number;
	/** "Back to planning" answers per package and run before the next needs the user's quote. */
	maxReplans: number;
	/** Answers per package and menu key before the next ask goes to the user. */
	maxAutoAnswers: number;
	/** Idle reports without progress per package before the next goes to the user. */
	maxIdleAnswers: number;
	/** Regex (case-insensitive) for the typed "go" that moves orchestrator mode on. */
	approvePattern: string;
	/** Models for the orchestrator session and for the proposal judge. A missing role means no switch / the session model. */
	roles: { orchestrator?: RoleSpec; judge?: RoleSpec };
	/** Judge the `## Packages:` proposal before a typed "go" starts the run. */
	autoJudgeProposal: "off" | "auto";
	/** Proposal-judge runs per "go" before the open auto findings go to the run. */
	maxProposalJudgeRounds: number;
	/** How the proposal judge subagent runs. */
	judge: { tools: string[]; timeoutMs: number; idleTimeoutMs: number; extensions: string[] };
}

export const BRIDGE = "~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts";

/** Copy of the default `approvePattern` in workflow/config.ts: the same words mean "go" in both. */
const GO_PATTERN =
	"^((ok(ay)?|yes|yeah|yep|sure|alright|fine|great|good)[,.! ]+)?(then[, ]+)?(go|go ahead|go for it|do it|do that|do this|do them|do (it )?all( of (it|that|them))?|approved?|lgtm|ship it|execute( it| that| this| the plan)?|proceed|start|let'?s go|let'?s do it|run it|implement( it| that| this| the plan)?|build it|make it so)( for me)?( now)?( please)?[.! ]*$";

/** Fresh defaults per call (nested objects are never shared). `judge.extensions` is the bridge path only when that file exists. */
export function defaults(exists: (p: string) => boolean = fs.existsSync): OrchestrateConfig {
	return {
		maxSubs: 4, pollSeconds: 60, stallMinutes: 20, confirmPlans: false, maxPlanRejections: 3, maxReplans: 2, maxAutoAnswers: 2, maxIdleAnswers: 3, approvePattern: GO_PATTERN,
		roles: {}, autoJudgeProposal: "auto", maxProposalJudgeRounds: 2,
		judge: { tools: ["read", "grep", "find", "ls"], timeoutMs: 900000, idleTimeoutMs: 300000, extensions: exists(expandHome(BRIDGE)) ? [BRIDGE] : [] },
	};
}

export const DEFAULTS: OrchestrateConfig = defaults();

const INT_KEYS = ["maxSubs", "pollSeconds", "stallMinutes", "maxPlanRejections", "maxReplans", "maxAutoAnswers", "maxIdleAnswers", "maxProposalJudgeRounds"] as const;

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parseRole(v: unknown): RoleSpec | undefined {
	if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
	const r = v as { model?: unknown; thinking?: unknown };
	if (typeof r.model !== "string") return undefined;
	const spec = parseRoleSpec(r.model);
	if (typeof spec === "string" || spec.thinking) return undefined;
	if (r.thinking !== undefined) {
		if (typeof r.thinking !== "string" || !(THINKING_LEVELS as readonly string[]).includes(r.thinking)) return undefined;
		return { model: spec.model, thinking: r.thinking as RoleSpec["thinking"] };
	}
	return spec;
}

/** Merge a parsed JSON value into the defaults. Pure. */
export function parseConfig(raw: unknown, exists: (p: string) => boolean = fs.existsSync): { config: OrchestrateConfig; warning?: string } {
	const config = defaults(exists);
	if (raw === undefined) return { config };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config, warning: "orchestrate.json: expected an object; using the defaults" };
	const o = raw as Record<string, unknown>;
	const bad: string[] = [];
	for (const k of INT_KEYS) {
		if (!(k in o)) continue;
		const v = o[k];
		if (typeof v === "number" && Number.isInteger(v) && v >= 1) config[k] = v;
		else bad.push(k);
	}
	if ("confirmPlans" in o) {
		if (typeof o.confirmPlans === "boolean") config.confirmPlans = o.confirmPlans;
		else bad.push("confirmPlans");
	}
	if ("approvePattern" in o) {
		let ok = false;
		if (typeof o.approvePattern === "string") {
			try {
				new RegExp(o.approvePattern, "i");
				ok = true;
			} catch {
				// falls through to bad
			}
		}
		if (ok) config.approvePattern = o.approvePattern as string;
		else bad.push("approvePattern");
	}
	if ("autoJudgeProposal" in o) {
		if (o.autoJudgeProposal === "off" || o.autoJudgeProposal === "auto") config.autoJudgeProposal = o.autoJudgeProposal;
		else bad.push("autoJudgeProposal");
	}
	if ("roles" in o) {
		const r = o.roles;
		if (!r || typeof r !== "object" || Array.isArray(r)) bad.push("roles");
		else {
			const ro = r as Record<string, unknown>;
			if ("orchestrator" in ro) {
				if (ro.orchestrator === false) config.roles.orchestrator = undefined;
				else {
					const spec = parseRole(ro.orchestrator);
					if (spec) config.roles.orchestrator = spec;
					else bad.push("roles.orchestrator");
				}
			}
			if ("judge" in ro) {
				const spec = parseRole(ro.judge);
				if (spec) config.roles.judge = spec;
				else bad.push("roles.judge");
			}
		}
	}
	if ("judge" in o) {
		const j = o.judge;
		if (!j || typeof j !== "object" || Array.isArray(j)) bad.push("judge");
		else {
			const jo = j as Record<string, unknown>;
			if ("tools" in jo) {
				if (isStrings(jo.tools) && jo.tools.length > 0) config.judge.tools = jo.tools;
				else bad.push("judge.tools");
			}
			if ("timeoutMs" in jo) {
				if (typeof jo.timeoutMs === "number" && Number.isInteger(jo.timeoutMs) && jo.timeoutMs >= 1) config.judge.timeoutMs = jo.timeoutMs;
				else bad.push("judge.timeoutMs");
			}
			if ("idleTimeoutMs" in jo) {
				if (typeof jo.idleTimeoutMs === "number" && Number.isInteger(jo.idleTimeoutMs) && jo.idleTimeoutMs >= 0) config.judge.idleTimeoutMs = jo.idleTimeoutMs;
				else bad.push("judge.idleTimeoutMs");
			}
			if ("extensions" in jo) {
				if (isStrings(jo.extensions)) config.judge.extensions = jo.extensions;
				else bad.push("judge.extensions");
			}
		}
	}
	return { config, warning: bad.length ? `orchestrate.json: bad value for ${bad.join(", ")}; using the default` : undefined };
}

/** Reads `<agentDir>/orchestrate.json`; no file means the defaults. */
export function loadConfig(agentDir: string): { config: OrchestrateConfig; warning?: string } {
	const file = path.join(agentDir, "orchestrate.json");
	if (!fs.existsSync(file)) return { config: defaults() };
	try {
		return parseConfig(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (e) {
		return { config: defaults(), warning: `orchestrate.json: ${(e as Error).message}; using the defaults` };
	}
}
