/** Pure helpers for orchestrate's model switch (and, later, the proposal judge gate). Imports only from `shared/` and this folder. */

import type { Finding } from "../shared/findings.ts";
import { blockingFindings, findingsBlock, isClean, textHash } from "../shared/findings.ts";
import { isProposalReady, type Mode, MODE_ENTRY } from "./mode.ts";
import { JUDGE_PROPOSAL, JUDGE_PROPOSAL_RECHECK, JUDGE_RELAY_CHECKS, NO_AGREED_NOTE } from "./prompts.ts";

export interface ProposalReview {
	hash: string;
	verdict: "PASS" | "FAIL";
	findings: Finding[];
	rounds: number;
	status: "idle" | "awaiting-fix" | "paused";
}
export const GATE_ENTRY = "orchestrate-proposal-gate";

/** What a "go" on a ready proposal does: move on, run the full judge, or recheck the earlier findings. */
export function proposalGateStart(o: { mode: "off" | "auto"; hash: string; last?: ProposalReview }): "move" | "full" | "recheck" {
	if (o.mode === "off") return "move";
	const l = o.last;
	if (l && l.hash === o.hash && isClean(l.verdict, l.findings)) return "move";
	if (l && blockingFindings(l.findings).length > 0) return "recheck";
	return "full";
}

/** After a judge run (`rounds` counts this run): move on, send the auto findings back for a fix, or pause. */
export function proposalGateAfterVerdict(o: { verdict: string; findings: Finding[]; rounds: number; max: number }): "move" | "fix" | "pause" | "move-open" {
	if (isClean(o.verdict, o.findings)) return "move";
	if (blockingFindings(o.findings).some((f) => f.route === "user")) return "pause";
	return o.rounds < o.max ? "fix" : "move-open";
}

/** After the model answered a fix request: recheck only a ready proposal that changed. */
export function proposalGateAfterFixReply(o: { prevHash: string; ready: boolean; replyHash?: string }): "recheck" | "pause" {
	return o.ready && o.replyHash !== undefined && o.replyHash !== o.prevHash ? "recheck" : "pause";
}

/** Typed input while the judge runs: a second "go" only shows a notice, other text cancels. */
export function proposalGateOnInput(o: { running: boolean; isGo: boolean }): "notice" | "cancel" | "pass" {
	if (!o.running) return "pass";
	return o.isGo ? "notice" : "cancel";
}

/** The rounds a run starts with: a typed "go" resets them, a recheck after a fix keeps them. */
export function proposalGateRounds(o: { resetRounds: boolean; last?: ProposalReview }): number {
	return o.resetRounds ? 0 : o.last?.rounds ?? 0;
}

/** The judge's system prompts. */
export function proposalReviewPrompts(o: { proposal: string; list?: string; repoTable?: string; recheck?: Finding[]; executor?: "relay" | "workflow" }): string[] {
	const head = o.recheck ? JUDGE_PROPOSAL_RECHECK : JUDGE_PROPOSAL;
	const parts = [o.executor === "relay" ? `${head}\n\n${JUDGE_RELAY_CHECKS}` : head, "## Agreed list\n" + (o.list ?? NO_AGREED_NOTE), "## Repos\n" + (o.repoTable ?? "single repo: the working folder"), "## Proposal\n" + o.proposal];
	if (o.recheck) parts.splice(4, 0, "## Previous findings\n" + findingsBlock(o.recheck));
	return parts;
}

/**
 * The one-go chain at the end of a reply in propose mode. Both executors: an answer to a fix request is checked (`fix-reply`).
 * Relay only: any other finished proposal starts the gate on its own (`gate`; after a pause too), no second "go".
 */
export function oneGoOnReply(o: { executor: "relay" | "workflow"; mode: Mode; ready: boolean; running: boolean; status?: ProposalReview["status"] }): "none" | "fix-reply" | "gate" {
	if (o.mode !== "propose" || o.running) return "none";
	if (o.status === "awaiting-fix") return "fix-reply";
	return o.executor === "relay" && o.ready ? "gate" : "none";
}

/** What a pause (a finding routed to the user) does: relay runs ask the user through the model; workflow runs wait for a typed "go". */
export function pauseAction(executor: "relay" | "workflow"): "ask-user" | "wait-go" {
	return executor === "relay" ? "ask-user" : "wait-go";
}

/** The newest saved gate state; `awaiting-fix` becomes `idle` (the fix turn does not survive a restart). */
export function proposalGateFromEntries(entries: unknown[]): ProposalReview | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: Record<string, unknown> } | null;
		if (!e || e.type !== "custom" || e.customType !== GATE_ENTRY) continue;
		const d = e.data;
		if (!d || typeof d.hash !== "string" || (d.verdict !== "PASS" && d.verdict !== "FAIL") || !Array.isArray(d.findings) || typeof d.rounds !== "number") return undefined;
		const status = d.status === "paused" ? "paused" : "idle";
		return { hash: d.hash, verdict: d.verdict, findings: d.findings as Finding[], rounds: d.rounds, status };
	}
	return undefined;
}

/** The proposal a ready reply in propose mode leaves behind. */
export function nextLastProposal(mode: string, body: string, stoppedNormally: boolean): { text: string; hash: string } | undefined {
	if (mode !== "propose" || !isProposalReady(body, stoppedNormally)) return undefined;
	return { text: body, hash: textHash(body) };
}

export type SavedModel = { model: string; thinking?: string };

export type RoleAction = "apply" | "restore" | "warn" | "none";

/** What a mode change does to the session model. Only off<->on, never in a sub; a running workflow phase turns the switch into a warning. */
export function roleSwitch(o: { from: Mode; to: Mode; isSub: boolean; workflowPhase?: string; hasRole: boolean; hasPrev: boolean }): RoleAction {
	if (o.isSub) return "none";
	const on = o.from === "off" && o.to !== "off" && o.hasRole;
	const off = o.from !== "off" && o.to === "off" && o.hasPrev;
	if (!on && !off) return "none";
	if (o.workflowPhase && o.workflowPhase !== "off") return "warn";
	return on ? "apply" : "restore";
}

/** The warning when the switch is skipped because a workflow phase is running. */
export function roleWarnText(direction: "on" | "off", phase: string, saved?: SavedModel): string {
	if (direction === "on") return `orchestrate: the workflow is in phase ${phase}; the model was not switched`;
	const back = saved ? ` Set it back with /model ${saved.model}${saved.thinking ? ` and thinking ${saved.thinking}` : ""}` : "";
	return `orchestrate: the workflow is in phase ${phase}; the model was not restored.${back}`;
}

/** The newest mode entry's `prevModel`, only when that entry's mode is not off. */
export function roleOnRestore(entries: unknown[]): SavedModel | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (!e || e.type !== "custom" || e.customType !== MODE_ENTRY) continue;
		const d = e.data as { mode?: unknown; prevModel?: { model?: unknown; thinking?: unknown } } | undefined;
		if (!d || d.mode === "off") return undefined;
		const p = d.prevModel;
		if (!p || typeof p.model !== "string" || !p.model) return undefined;
		return typeof p.thinking === "string" ? { model: p.model, thinking: p.thinking } : { model: p.model };
	}
	return undefined;
}
