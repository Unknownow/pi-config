/** orchestrate.json lives next to workflow.json in the agent dir. Missing keys fall back to DEFAULTS; a bad value falls back with a warning. */

import * as fs from "node:fs";
import * as path from "node:path";

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
}

/** Copy of the default `approvePattern` in workflow/config.ts: the same words mean "go" in both. */
const GO_PATTERN =
	"^((ok(ay)?|yes|yeah|yep|sure|alright|fine|great|good)[,.! ]+)?(then[, ]+)?(go|go ahead|go for it|do it|do that|do this|do them|do (it )?all( of (it|that|them))?|approved?|lgtm|ship it|execute( it| that| this| the plan)?|proceed|start|let'?s go|let'?s do it|run it|implement( it| that| this| the plan)?|build it|make it so)( for me)?( now)?( please)?[.! ]*$";

export const DEFAULTS: OrchestrateConfig = { maxSubs: 4, pollSeconds: 60, stallMinutes: 20, confirmPlans: false, maxPlanRejections: 3, maxReplans: 2, maxAutoAnswers: 2, maxIdleAnswers: 3, approvePattern: GO_PATTERN };

const INT_KEYS = ["maxSubs", "pollSeconds", "stallMinutes", "maxPlanRejections", "maxReplans", "maxAutoAnswers", "maxIdleAnswers"] as const;

/** Merge a parsed JSON value into the defaults. Pure. */
export function parseConfig(raw: unknown): { config: OrchestrateConfig; warning?: string } {
	const config: OrchestrateConfig = { ...DEFAULTS };
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
	return { config, warning: bad.length ? `orchestrate.json: bad value for ${bad.join(", ")}; using the default` : undefined };
}

/** Reads `<agentDir>/orchestrate.json`; no file means the defaults. */
export function loadConfig(agentDir: string): { config: OrchestrateConfig; warning?: string } {
	const file = path.join(agentDir, "orchestrate.json");
	if (!fs.existsSync(file)) return { config: { ...DEFAULTS } };
	try {
		return parseConfig(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (e) {
		return { config: { ...DEFAULTS }, warning: `orchestrate.json: ${(e as Error).message}; using the defaults` };
	}
}
