import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Role, CONFIG_PATH } from "../config.ts";
import { describeRole } from "../../shared/roles.ts";
import { phaseAfterFlow, preFlowModelAction, approvalBlock, composePlan } from "../agent-end.ts";
import * as prompts from "../prompts.ts";
import { planGateReset, type Finding, textHash, findingText } from "../gates.ts";
import { planTitle } from "../delivery.ts";
import { isHuman, mergeChecklist } from "../plan-doc.ts";
import { type ReportStep, reportFindings, autopilotDecisions } from "../flow-report.ts";
import { deliverHintsBlock, publishRefusal, deliverStepSpec, deliverHint } from "../checkpoints.ts";
import { type HumanCheck, humanChecks } from "../waits.ts";
import { parseStages, stageStart } from "../stages.ts";
import { planToolRefused } from "../../shared/readonly-tools.ts";
import { hiddenInPhase, refilterPlanTools, syncFlowOnlyTools } from "../plan-tools.ts";
import type { Stage } from "../view.ts";
import { APPROVED_FINAL, type Flow, FOLDERS_ENTRY, type Phase, STATE_ENTRY, SUMMARY_ENTRY } from "./context.ts";
import { dropReviewRefs, existingFolders, initReviewBase } from "./diff.ts";
import { abortGate, notifyUser } from "./notify.ts";
import { liveTick, planMilestone, recordMetric } from "./plan-files.ts";
import { modelOf } from "./roles.ts";

export const autopilotOn = (fl: Flow): boolean => fl.autopilotOverride ?? fl.cfg.autopilot;
/** An autopilot choice for the final card. */
export const noteAuto = (fl: Flow, text: string): void => {
	fl.state.autoDecisions = [...(fl.state.autoDecisions ?? []), text.replace(/\s+/g, " ").slice(0, 240)].slice(-30);
	persist(fl);
};

// ----------------------------------------------------------------------
// Phases and models
// ----------------------------------------------------------------------

export function persist(fl: Flow): void {
	fl.state.tokens = { ...fl.view.used };
	fl.state.tokenUnit = "both";
	fl.state.flow = structuredClone(fl.view.flow);
	fl.state.flowStarted = fl.view.flowStarted;
	fl.pi.appendEntry(STATE_ENTRY, fl.state);
}

/** K1: appends the folder list as a `session-folders` entry when the newest one on the branch differs. */
export function publishFolders(fl: Flow, ctx: ExtensionContext): void {
	const data = { v: 1, cwd: ctx.cwd.replace(/\\/g, "/"), folders: [...(fl.state.folders ?? [])] };
	const newest = ctx.sessionManager
		.getBranch()
		.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === FOLDERS_ENTRY)
		.pop() as { data?: { cwd?: unknown; folders?: unknown } } | undefined;
	if (newest?.data && newest.data.cwd === data.cwd && JSON.stringify(newest.data.folders) === JSON.stringify(data.folders)) return;
	fl.pi.appendEntry(FOLDERS_ENTRY, data);
}

/** Ends the current flow: shows its token breakdown and starts counting the next one. False if it had none. */
export function summarizeFlow(fl: Flow, outcome: string, ok: boolean, extra?: HumanCheck[]): boolean {
	const fromPlan = humanChecks(fl.state.approvedPlan, fl.state.checklist);
	const human = [...fromPlan, ...(extra ?? [])];
	if (fromPlan.length) outcome += ` · ${fromPlan.length} human check(s) for you (see the card)`;
	if ((fl.state.unresolvedPlanFlaws ?? 0) > 0) outcome += ` · ${fl.state.unresolvedPlanFlaws} plan flaw(s) not settled (see the plan)`;
	fl.state.unresolvedPlanFlaws = undefined;
	const steps: ReportStep[] | undefined = fl.state.checklist?.some((c) => !isHuman(c)) ? fl.state.checklist.filter((c) => !isHuman(c)).map((c) => ({ id: c.id, text: c.text, done: c.done })) : undefined;
	const found = reportFindings(fl.state.flowFindings, fl.state.approvedPlan);
	const findings = found.length ? found : undefined;
	const flowId = fl.state.planDoc?.flowId;
	fl.state.flowSummarized = true;
	fl.state.flowFindings = undefined;
	const lateFindings = fl.state.lateFindings?.length ? fl.state.lateFindings : undefined;
	fl.state.lateFindings = undefined;
	const autopilot = autopilotDecisions(fl.state.approvedPlan, fl.state.autoDecisions);
	fl.state.autoDecisions = undefined;
	fl.state.autoCaps = undefined;
	fl.state.autoRetries = undefined;
	if (fl.state.planDoc && !fl.state.planDoc.finished) planMilestone(fl, undefined, { at: new Date().toISOString(), ok, text: outcome });
	fl.state.touchedRepos = undefined;
	fl.view.settleMain();
	if (!fl.view.hasFlowUsage() && !steps && !findings && !lateFindings && !autopilot.length && !human.length) {
		if (flowId) {
			const empty = fl.view.peekFlow(outcome, ok);
			recordMetric(fl, { kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: empty.started, ended: empty.ended, stages: empty.stages });
		}
		persist(fl);
		return false;
	}
	const summary = fl.view.endFlow(outcome, ok);
	fl.pi.appendEntry(SUMMARY_ENTRY, { ...summary, steps, findings, ...(lateFindings ? { lateFindings } : {}), ...(autopilot.length ? { autopilot } : {}), ...(human.length ? { humanChecks: human } : {}) });
	if (flowId) recordMetric(fl, { kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: summary.started, ended: summary.ended, stages: summary.stages });
	persist(fl);
	return true;
}

/** A flow has ended: on to the phase `returnTo` names. */
export async function endFlow(fl: Flow, ctx: ExtensionContext): Promise<void> {
	notifyUser(fl, ctx, "flow finished");
	await dropReviewRefs(fl, ctx);
	fl.state.reviewBase = undefined;
	fl.state.passedTrees = undefined;
	fl.state.judgedMerges = undefined;
	fl.state.waiting = undefined;
	fl.legacy.stopWaitTimer();
	updateStatus(fl, ctx);
	const next = phaseAfterFlow(fl.cfg.returnTo, fl.state.phase);
	if (!next) {
		if (fl.cfg.returnTo === "off" && fl.state.phase === "execute") await setPhase(fl, ctx, "off"); // restores the model from before the flow
		return;
	}
	await setPhase(fl, ctx, next);
	ctx.ui.notify(`workflow: flow done, back to ${next === "discuss" ? "discussion" : "planning"} on ${describeRole(fl.cfg.roles[next])}`, "info");
}

export function updateStatus(fl: Flow, ctx: ExtensionContext): void {
	fl.lastCtx = ctx;
	fl.view.roles = fl.cfg.roles;
	fl.view.judge = modelOf(fl, "judge");
	fl.view.weights = fl.cfg.tokenWeights;
	fl.view.phase = fl.state.phase;
	fl.view.escalated = fl.state.escalated;
	if (fl.state.phase === "discuss") fl.view.stage = "discuss";
	else if (fl.state.phase === "plan") fl.view.stage = "plan";
	else if (fl.view.stage === "discuss" || fl.view.stage === "plan") fl.view.stage = "execute";
	if (ctx.hasUI) fl.view.mount(ctx.ui);
	const n = existingFolders(fl).length + (fl.state.touchedRepos?.length ?? 0);
	const cl = fl.state.checklist;
	if (ctx.hasUI) ctx.ui.setStatus("workflow-plan", cl?.length && fl.state.phase === "execute" ? `plan ${cl.filter((i) => !isHuman(i) && i.done).length}/${cl.filter((i) => !isHuman(i)).length}` : undefined);
	if (ctx.hasUI) ctx.ui.setStatus("workflow-wait", fl.state.waiting && fl.state.phase === "execute" ? `waiting: ${fl.state.waiting.reason.slice(0, 40)}` : undefined);
	if (ctx.hasUI) ctx.ui.setStatus("workflow-judge", fl.gateRun ? (fl.gateRun.kind === "plan" ? `critic on the plan (run ${(fl.state.planGate?.rounds ?? 0) + 1}/${fl.cfg.maxPlanJudgeRounds})` : "critic on the discussion") : undefined);
	if (ctx.hasUI) ctx.ui.setStatus("workflow-autopilot", autopilotOn(fl) ? "autopilot" : undefined);
	if (ctx.hasUI) ctx.ui.setStatus("workflow-folders", n ? `+${n} folder${n === 1 ? "" : "s"}` : undefined);
	if (fl.state.approvedPlan && cl?.length && fl.state.phase === "execute") {
		const st = currentStages(fl);
		const open = cl.find((i) => !i.done && !isHuman(i));
		fl.view.progress = {
			...(st ? { stage: st.current, stages: st.stages.length } : {}),
			done: cl.filter((i) => !isHuman(i) && i.done).length,
			total: cl.filter((i) => !isHuman(i)).length,
			...(open ? { current: `${open.id} ${open.text}` } : {}),
			judgeRound: fl.state.judgeRounds,
			...(fl.state.waiting ? { waiting: fl.state.waiting.reason } : {}),
		};
	} else fl.view.progress = undefined;
	emitStatus(fl);
	liveTick(fl);
}

/** K4: tells other extensions the phase and stage; only when it changed. */
export function emitStatus(fl: Flow): void {
	const st = currentStages(fl);
	const cl = fl.state.approvedPlan && fl.state.phase === "execute" ? fl.state.checklist?.filter((i) => !isHuman(i)) : undefined;
	const payload = {
		v: 1,
		phase: fl.state.phase,
		...(fl.state.planDoc?.flowId ? { flowId: fl.state.planDoc.flowId } : {}),
		...(fl.state.approvedPlan ? { title: planTitle(fl.state.approvedPlan) } : {}),
		...(st ? { stage: st.current, stages: st.stages.length } : {}),
		...(cl?.length ? { done: cl.filter((i) => i.done).length, total: cl.length } : {}),
		...(cl && fl.state.waiting ? { waiting: true } : {}),
		...(fl.gateRun ? { judging: fl.gateRun.kind } : {}),
		delivery: { mergeMethod: fl.cfg.delivery.mergeMethod, deleteBranch: fl.cfg.delivery.deleteBranch },
	};
	const json = JSON.stringify(payload);
	if (json === fl.lastStatusEvent) return;
	fl.lastStatusEvent = json;
	try {
		fl.pi.events.emit("workflow:status", payload);
	} catch {}
}

/** Switches the main session to a role's model and thinking level. */
export async function applyRole(fl: Flow, ctx: ExtensionContext, role: Role): Promise<boolean> {
	const spec = fl.cfg.roles[role];
	const slash = spec.model.indexOf("/");
	const model = slash > 0 ? ctx.modelRegistry.find(spec.model.slice(0, slash), spec.model.slice(slash + 1)) : undefined;
	if (!model) {
		ctx.ui.notify(`workflow: model ${spec.model} (${role}) not found — check ${CONFIG_PATH}`, "error");
		return false;
	}
	if (!(await fl.pi.setModel(model))) {
		ctx.ui.notify(`workflow: no credentials for ${spec.model} (${role})`, "error");
		return false;
	}
	if (spec.thinking) fl.pi.setThinkingLevel(spec.thinking);
	return true;
}

/** Puts back the model and thinking level the session had before the flow; keeps the current ones when the model is gone. */
export async function restorePreFlowModel(fl: Flow, ctx: ExtensionContext, saved: { model: string; thinking?: string }): Promise<void> {
	const slash = saved.model.indexOf("/");
	const model = slash > 0 ? ctx.modelRegistry.find(saved.model.slice(0, slash), saved.model.slice(slash + 1)) : undefined;
	if (!model || !(await fl.pi.setModel(model))) {
		ctx.ui.notify(`workflow: the model from before the flow (${saved.model}) is not available; keeping the current one`, "warning");
		return;
	}
	if (saved.thinking) fl.pi.setThinkingLevel(saved.thinking as ReturnType<typeof fl.pi.getThinkingLevel>);
}

export function blockPlanTools(fl: Flow): void {
	fl.state.toolsBeforePlan ??= fl.pi.getActiveTools();
	fl.pi.setActiveTools(fl.state.toolsBeforePlan.filter((t) => !planToolRefusedIn(fl, t)));
}

export function planToolRefusedIn(fl: Flow, name: string): boolean {
	return hiddenInPhase("plan", name, (n) => planToolRefused(n, fl.legacy.planAllowedTools(), fl.cfg.planBlockedTools) !== null);
}

/** Tools that registered after the phase began (an MCP server that connected late) get the same filter. */
export function refilterTools(fl: Flow): void {
	if ((fl.state.phase !== "discuss" && fl.state.phase !== "plan") || !fl.state.toolsBeforePlan) return;
	try {
		refilterPlanTools(fl.pi, fl.state.toolsBeforePlan, (t) => planToolRefusedIn(fl, t));
	} catch {
		// the turn goes on with the tools it has
	}
}

/** The widget stage the main session is in. */
export function phaseStage(fl: Flow): Stage {
	return fl.state.phase === "discuss" ? "discuss" : fl.state.phase === "plan" ? "plan" : "execute";
}

export function restorePlanTools(fl: Flow): void {
	if (!fl.state.toolsBeforePlan) return;
	const extra = fl.pi.getActiveTools().filter((t) => !fl.state.toolsBeforePlan!.includes(t));
	fl.pi.setActiveTools([...fl.state.toolsBeforePlan, ...extra]);
	fl.state.toolsBeforePlan = undefined;
}

/** The result is always true. */
export async function setPhase(fl: Flow, ctx: ExtensionContext, phase: Phase): Promise<boolean> {
	const leavingFlow = fl.state.phase === "execute" && phase !== fl.state.phase;
	if (phase !== fl.state.phase) {
		abortGate(fl, "phase");
		fl.planApproveQueued = false;
		fl.planFixing = false;
	}
	if (phase === "plan" && fl.state.phase !== "plan") {
		fl.state.planGate = planGateReset(fl.state.planGate, "enter-plan");
	}
	if (leavingFlow && fl.state.approvedPlan && !fl.state.flowSummarized) {
		summarizeFlow(fl, fl.legacy.stoppedSummary(phase === "plan" ? "back to planning" : phase === "discuss" ? "back to discussion" : "abandoned"), false);
	}
	fl.planReady = false;
	fl.planProposed = false;
	fl.planDraft = { full: "", changes: [] };
	fl.planWaitRetried = false; fl.planWaitNow = [];
	const readOnly = (p: Phase) => p === "discuss" || p === "plan";
	// Discuss and plan share one tool set, so moving between them keeps the snapshot.
	if (phase !== fl.state.phase && !(readOnly(fl.state.phase) && readOnly(phase))) {
		if (readOnly(fl.state.phase)) restorePlanTools(fl);
		if (readOnly(phase)) blockPlanTools(fl);
	}
	if (!readOnly(phase)) syncFlowOnlyTools(fl.pi, phase); // plan_check and deliver only exist inside a flow
	if (leavingFlow && fl.state.planDoc && !fl.state.planDoc.finished) planMilestone(fl, ctx, { at: new Date().toISOString(), ok: false, text: "abandoned" });
	const samePhase = phase === fl.state.phase; // a repeated setPhase keeps what the judge already passed
	const modelAction = preFlowModelAction(fl.state.phase, phase);
	if (modelAction === "save" && ctx.model) fl.state.preFlowModel = { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: fl.pi.getThinkingLevel() };
	const restoreModel = modelAction === "restore" ? fl.state.preFlowModel : undefined;
	if (leavingFlow) await dropReviewRefs(fl, ctx);
	fl.state.phase = phase;
	fl.state.escalated = false;
	fl.state.judgeRounds = 0;
	fl.state.minorRounds = 0;
	fl.state.minorSentFor = undefined;
	fl.state.minorFix = undefined;
	fl.state.waiting = undefined;
	fl.state.checkpoints = undefined;
	if (!samePhase) {
		fl.state.reviewBase = undefined;
		fl.state.passedTrees = undefined;
		fl.state.judgedMerges = undefined;
		fl.state.stageNudgedFor = undefined;
	}
	fl.wait.publishWaitSince.clear();
	fl.legacy.stopWaitTimer();
	fl.state.planRevisions = undefined;
	fl.state.pendingPlanFlaw = undefined;
	fl.state.unresolvedPlanFlaws = undefined;
	fl.state.touchedRepos = undefined;
	fl.state.stage = undefined;
	fl.state.stageJudged = undefined;
	fl.state.stageOutcomes = undefined;
	if (phase === "discuss" || phase === "plan") {
		fl.state.approvedPlan = undefined;
		fl.state.checklist = undefined;
		fl.state.planDoc = undefined;
		fl.state.planFlaw = undefined;
	}
	fl.consecutiveErrors = 0;
	if (phase === "execute" && !(samePhase && fl.state.reviewBase)) await initReviewBase(fl, ctx);
	if (phase !== "off") await applyRole(fl, ctx, phase);
	else if (restoreModel) await restorePreFlowModel(fl, ctx, restoreModel);
	if (phase === "off") fl.state.preFlowModel = undefined;
	persist(fl);
	updateStatus(fl, ctx);
	return true;
}

export function sendPlanKickoff(fl: Flow, open?: Finding[], notes?: Finding[]): void {
	const extra = (open?.length ? "\n\nOpen discussion-judge findings the plan must address:\n" + open.map((f) => `- ${f.head}`).join("\n") : "") + (notes?.length ? "\n\nMinor discussion-judge notes (take them into the plan where they fit; they are not blockers):\n" + notes.map((f) => `- ${f.head}`).join("\n") : "");
	fl.pi.sendMessage({ customType: "workflow-plan-kickoff", content: prompts.PLAN_KICKOFF + extra, display: true }, { triggerTurn: true, deliverAs: "followUp" });
}

/** Re-reads the steps from the approved plan (after an amendment too), keeping the ticks of the steps still in it. */
export function refreshChecklist(fl: Flow): void {
	const list = fl.state.approvedPlan ? mergeChecklist(fl.state.approvedPlan, fl.state.checklist) : [];
	fl.state.checklist = list.length ? list : undefined;
}

/** Records the plan that starts executing; for a staged plan also stage 1. Returns the text to add to the start message. */
export function startExecution(fl: Flow, ctx: ExtensionContext, plan: string | undefined): string {
	fl.state.approvedPlan = plan || undefined;
	fl.state.checklist = undefined;
	fl.state.planDoc = undefined;
	fl.state.flowFindings = undefined;
	fl.state.flowSummarized = undefined;
	refreshChecklist(fl);
	updateStatus(fl, ctx);
	fl.state.stageOutcomes = undefined;
	fl.state.stageJudged = undefined;
	const stages = parseStages(plan);
	fl.state.stage = stages.length ? 1 : undefined;
	planMilestone(fl, ctx);
	if (!stages.length) return deliverHintsText(fl, undefined);
	ctx.ui.notify(`workflow: staged plan, ${stages.length} stages; stage 1: ${stages[0].title}`, "info");
	const first = stageStart(stages, 1);
	if (fl.legacy.holdForStageWait(ctx, stages[0], first)) return `\n\nStage 1 waits for: ${stages[0].after?.reason}. Don't start it; end your turn now. The workflow sends you the stage when the wait is over.`;
	return `\n\n${first}${deliverHintsText(fl, 1)}`;
}

/** The stages of the approved plan and the current one, or null when the plan is not staged. */
export function currentStages(fl: Flow) {
	const stages = fl.state.stage ? parseStages(fl.state.approvedPlan) : [];
	return stages.length && fl.state.stage ? { stages, current: fl.state.stage } : null;
}

/** The open Deliver steps of `stage` with the call each one makes, as text to append to a message ("" when there are none). */
export function deliverHintsText(fl: Flow, stage: number | undefined): string {
	const block = deliverHintsBlock(fl.state.approvedPlan ?? "", fl.state.checklist, stage);
	return block ? `\n\n${block}` : "";
}

/** A refusal of a command the executor may not run. */
export function publishRefuse(problem: string): string {
	return publishRefusal(problem);
}

/** ` → call deliver …` for a Deliver step that names a tag, or "". */
export function deliverLine(fl: Flow, id: string, stage: number | undefined): string {
	const spec = deliverStepSpec(fl.state.approvedPlan ?? "", id);
	const hint = spec ? deliverHint(id, spec) : "";
	return hint ? ` ${hint}` : "";
}

export async function approve(fl: Flow, ctx: ExtensionContext, arbiterOnFlaw = false): Promise<void> {
	const blocked = approvalBlock(fl.planDraft, fl.planWaitNow);
	if (blocked) {
		ctx.ui.notify(`workflow: can't approve: ${blocked}.`, "warning");
		return;
	}
	fl.state.planFlaw = arbiterOnFlaw ? "auto" : undefined;
	const composed = composePlan(fl.planDraft);
	// minors of the plan judge are notes for the executor, never another review
	const minors = fl.state.planGate && fl.state.planGate.planHash === textHash(composed) ? fl.state.planGate.notes ?? [] : [];
	const minorNotes = minors.length ? `## Notes for the executor\n${minors.map((f) => `- ${findingText(f).replace(/\n/g, "\n  ")}`).join("\n")}` : "";
	const plan = [composed, minorNotes].filter(Boolean).join("\n\n");
	await setPhase(fl, ctx, "execute");
	const extra = startExecution(fl, ctx, plan);
	persist(fl);
	fl.legacy.handover("workflow-execute", APPROVED_FINAL + extra, ctx);
}

export async function escalate(fl: Flow, ctx: ExtensionContext): Promise<void> {
	if (await applyRole(fl, ctx, "escalate")) {
		fl.state.escalated = true;
		persist(fl);
		updateStatus(fl, ctx);
		ctx.ui.notify(`workflow: escalated to ${describeRole(fl.cfg.roles.escalate)}. /flow back to return.`, "warning");
	}
}

export async function deescalate(fl: Flow, ctx: ExtensionContext): Promise<void> {
	fl.state.escalated = false;
	if (fl.state.phase !== "off") await applyRole(fl, ctx, fl.state.phase);
	persist(fl);
	updateStatus(fl, ctx);
	ctx.ui.notify(`workflow: back to ${fl.state.phase}${fl.state.phase === "off" ? "" : ` on ${describeRole(fl.cfg.roles[fl.state.phase])}`}`, "info");
}
