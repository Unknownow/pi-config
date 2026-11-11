/** Orchestrator mode: a read-only discussion and proposal before any run exists. Pure; index.ts holds the state. */

import { PLAN_TOOLS, planToolProblem, planToolRefused } from "../shared/readonly-tools.ts";
import { PROPOSE_KICKOFF, RUN_KICKOFF } from "./prompts.ts";

export type Mode = "off" | "discuss" | "propose" | "run";

export const MODE_ENTRY = "orchestrate-mode";
const MODES: Mode[] = ["off", "discuss", "propose", "run"];

/** The newest `orchestrate-mode` custom entry wins; anything unreadable means off. */
export function modeFromEntries(entries: unknown[]): Mode {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (!e || e.type !== "custom" || e.customType !== MODE_ENTRY) continue;
		const d = e.data as { v?: unknown; mode?: unknown } | undefined;
		return d && d.v === 1 && typeof d.mode === "string" && (MODES as string[]).includes(d.mode) ? (d.mode as Mode) : "off";
	}
	return "off";
}

/** What a typed message does to the mode. `append` is added to the message for the model. Null: no change. */
export function onTyped(mode: Mode, text: string, proposalReady: boolean, goRe: RegExp): { mode: Mode; append: string } | null {
	if (!goRe.test(text.trim())) return null;
	if (mode === "discuss") return { mode: "propose", append: PROPOSE_KICKOFF };
	if (mode === "propose" && proposalReady) return { mode: "run", append: RUN_KICKOFF };
	return null;
}

const ENDS_IN_QUESTION = /\?[\s*_)"'`]*$/;

/** A finished reply with a `## Packages` section that is not waiting on an answer. */
export function isProposalReady(text: string, stoppedNormally: boolean): boolean {
	if (!stoppedNormally) return false;
	const t = text.trim();
	return /^#+\s*Packages\b/m.test(t) && !ENDS_IN_QUESTION.test(t);
}

const ALWAYS = /^(orch_status|orch_send|orch_review_plan|orch_accept|ask_orchestrator)$/;
const ALLOWED = PLAN_TOOLS.map((p) => new RegExp(p));

/** Why the tool may not run in this mode, or null. */
export function toolRefusal(mode: Mode, name: string, input: Record<string, unknown>): string | null {
	if (mode === "off") return null;
	const why = (r: string) => `orchestrator mode (${mode}): ${r}. /orch off lifts this guard.`;
	if (name === "orch_run" || name === "orch_spawn") return mode === "run" ? null : why(`${name} is only allowed after the packages are approved (go, twice)`);
	if (ALWAYS.test(name)) return null;
	if (name === "powershell") return why("PowerShell commands are not checked, so they are off");
	const refused = planToolRefused(name, ALLOWED, []);
	if (refused) return why(refused);
	const problem = planToolProblem(name, input, []);
	return problem ? why(problem) : null;
}
