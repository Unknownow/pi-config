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
	/** Minutes ask_orchestrator waits for an answer. */
	askTimeoutMinutes: number;
	/** Ask the person before a plan is approved. */
	confirmPlans: boolean;
}

export const DEFAULTS: OrchestrateConfig = { maxSubs: 4, pollSeconds: 60, stallMinutes: 20, askTimeoutMinutes: 15, confirmPlans: true };

const INT_KEYS = ["maxSubs", "pollSeconds", "stallMinutes", "askTimeoutMinutes"] as const;

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
