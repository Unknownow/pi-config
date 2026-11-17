/** Orchestrator mode: a read-only discussion and proposal before any run exists. Pure; index.ts holds the state. */

import { PLAN_TOOLS, planToolProblem, planToolRefused } from "../shared/readonly-tools.ts";
import { PROPOSE_KICKOFF, RELAY_RUN_KICKOFF, RUN_KICKOFF } from "./prompts.ts";

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
export function onTyped(mode: Mode, text: string, proposalReady: boolean, goRe: RegExp, executor: "relay" | "workflow" = "workflow"): { mode: Mode; append: string } | null {
	if (!goRe.test(text.trim())) return null;
	if (mode === "discuss") return { mode: "propose", append: PROPOSE_KICKOFF };
	if (mode === "propose" && proposalReady) return { mode: "run", append: executor === "relay" ? RELAY_RUN_KICKOFF : RUN_KICKOFF };
	return null;
}

const ENDS_IN_QUESTION = /\?[\s*_)"'`]*$/;

/** A finished reply with a `## Packages` section that is not waiting on an answer. */
export function isProposalReady(text: string, stoppedNormally: boolean): boolean {
	if (!stoppedNormally) return false;
	const t = text.trim();
	return /^#+\s*Packages\b/m.test(t) && !ENDS_IN_QUESTION.test(t);
}

const ALWAYS = /^(orch_status|orch_send|orch_review_plan|orch_accept|orch_decide|orch_escalate|orch_merge|ask_orchestrator)$/;

/** A shell command that merges a pull request (`gh pr merge`, `gh api .../merge`). */
export function mergesPullRequest(command: string): boolean {
	return /\bgh\b[^\n;|&]*\bpr\s+merge\b/.test(command) || /\bgh\b[^\n;|&]*\bapi\b[^\n;|&]*\/merge\b/.test(command);
}
const ALLOWED = PLAN_TOOLS.map((p) => new RegExp(p));
/** Orchestrate tools of the workflow executor only: a relay run has no sub-sessions, plans or acceptances. */
const WORKFLOW_ONLY = /^(orch_spawn|orch_send|orch_review_plan|orch_accept|orch_merge)$/;
/** The relay tools the orchestrator of a relay run uses (not relay_followup or relay_dispatch: orchestrate retries and dispatches itself). */
const RELAY_RUN_TOOLS = /^(relay_status|relay_approve|relay_send|relay_resume|relay_stop|relay_replan|relay_deliver)$/;

/** Why the tool may not run in this mode, or null. `executor`: the run's (or, before a run, the configured) executor. */
export function toolRefusal(mode: Mode, name: string, input: Record<string, unknown>, executor: "relay" | "workflow" = "workflow"): string | null {
	if (executor === "relay" && WORKFLOW_ONLY.test(name)) return `${name} is for workflow runs; relay jobs dispatch, merge and retry on their own (a held PR is merged by hand and released by the poll)`;
	if (mode === "off") return null;
	const why = (r: string) => `orchestrator mode (${mode}): ${r}. /orch off lifts this guard.`;
	if (name === "orch_run" || name === "orch_spawn") return mode === "run" ? null : why(`${name} is only allowed after the packages are approved (${executor === "relay" ? "go, then the proposal judge" : "go, twice"})`);
	if (executor === "relay" && mode === "run" && RELAY_RUN_TOOLS.test(name)) return null;
	if (executor === "relay" && /^relay_/.test(name)) return why(`${name} is not for the orchestrator: orchestrate dispatches and retries the packages itself`);
	if (ALWAYS.test(name)) return null;
	if (name === "powershell") return why("PowerShell commands are not checked, so they are off");
	const refused = planToolRefused(name, ALLOWED, []);
	if (refused) return why(refused);
	const problem = planToolProblem(name, input, []);
	return problem ? why(problem) : null;
}
