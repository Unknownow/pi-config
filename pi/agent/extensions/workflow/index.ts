/**
 * Workflow extension: one model per job.
 *
 *   you -> plan (Opus, high) -> approve -> execute (Sonnet, medium) -> judge (Opus) -> commit
 *                                             |-- explore (Haiku, parallel): file:line only
 *                                             `-- advisor (Opus): reads the full transcript at decision points
 *
 *   escalation (manual)  /flow escalate -> Fable, /flow back -> the phase's own model
 *   context guard        compact at ~140k tokens on every model, once the run settles
 *
 * plan and execute switch the main session's model. explore, advisor and judge
 * are tools of the agents extension that run in a separate `pi` process; the
 * flow's code review is agents' runJudge, its plan and discussion reviews agents'
 * runCritic (all through ../agents/api.ts). The workflow roles' models come from
 * ~/.pi/agent/workflow.json (`/flow model`); judge and critic from agents.json.
 *
 * view.ts draws it live: the pipeline above the editor with the active stage
 * and its model, plus a row per running subagent with what it is doing now.
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getShellConfig,
	loadProjectContextFiles,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	CONFIG_PATH,
	DEFAULTS,
	loadConfig,
	ROLES,
	type Role,
	type RoleSpec,
	saveRole,
	type WorkflowConfig,
} from "./config.ts";
import { describeRole, parseRoleSpec, pickRoleSpec } from "../shared/roles.ts";
import { judgeAddenda, handoverAction, handoverKind, preFlowModelAction, gitTaskAllowed, migrateSavedState, afterPass, noChangeStage, arbiterFirst, fixableFindings, codeVerdict, lateFindingLines, canApprove, approvalBlock, addPlanReply, composePlan, type PlanDraft, planFlaws, planFlawOnPass, judgeCapReached, minorFixOpen, passPending, stageEndAction, parseArbiter, parseMergeArbiter, phaseAfterFlow, shouldResume, skipJudge } from "./agent-end.ts";
import { countTokens, fmtTok, type Tok } from "../shared/tokens.ts";
import { idleReason, notifyCommand, notifyDue } from "./notify.ts";
import * as prompts from "./prompts.ts";
import { discussionCriticRequest, discussionVerdict, lastAgreedList } from "./discussion-review.ts";
import { branchTranscript } from "../shared/transcript.ts";
import { type DiscussionReview, type Finding, type PlanGate, type SpecKind, discussionGateAfterFixReply, discussionGateAfterVerdict, discussionGateOnInput, discussionGateStart, findingText, forcedOpenFindings, blockingFindings, isClean, minorFindings, isEscKey, parseFindings, planCriticRequest, planDisputes, planGateAfterVerdict, planGateDecide, planGateReset, planOfferAction, textHash } from "./gates.ts";
import { planTitle } from "./delivery.ts";
import { FLOW_UNKNOWN, FOLDERS_SUBS, flowCompletions, foldersCompletions, foldersDescription, foldersUsage } from "./commands.ts";
import { isKnown } from "../shared/completions.ts";
import { ghCandidates, withPathDir } from "./gh-path.ts";
import { citeNames, collectRepoDiff as collectRepoDiffImpl, needsFinalFullReview, shouldSkipRepeatFullReview, type RepoDiff } from "../shared/git/repo-diff.ts";
import { GIT_GUARD_ENV, type GitGuardSpec } from "./git-guard.ts";
import { forkBase, midFlowMergeProblem, unpushedReason, mergedInStage, baseFromTree, defaultRunner, recordJudged, gateCheck, originRepo, mergedBase, noMerge } from "../shared/git/merge-gate.ts";
import { combineRepoTexts, followFolders, parseAddDir, parseWorktreeList, repoKey, uniqueRoots } from "../shared/repos.ts";
import { askFolderAdd } from "./folder-add.ts";
import { codePublishProblem, registryPublishCodeProblem, registryPublishProblem, shellProblem } from "../shared/git/push-guard.ts";
import { blockedWaitCheck, classifyPublish, lockDecision, lockWaitCheck, NO_JUDGED_MERGE, waitSince, mirrorArgs, parseMirrorStep, parsePublishStep, publishArgs } from "./registry-publish.ts";
import { type Finished, mergeChecklist, newFlowId, isHuman, openStepsReminder, parseChecklist, type PlanStatus, planCard, pruneIds, renderPlanFile, splitPlanFile, type ChecklistItem } from "./plan-doc.ts";
import { addToRegistry, type BoardEntry, boardLines, boardRows, detailLines, liveEvents, type LiveInfo, readLive, readRegistry } from "./board.ts";
import { adoptHigher, claimLive, commitRef, dropClaim, pidAlive, readClaim, writeClaim, deleteLocal, deleteRef, deleteReviewRef, fetchMirror, type Git, listRefs, plansDir, pushRef, readLocalStatuses, readPlanMd, refRev, remoteOf, repoInfo, type RefEntry, sweepReviewRefs, writeLocal, writeReviewRef } from "./plan-store.ts";
import { autopilotDecisions, type FlowFinding, recordFindings, reportFindings, type ReportStep } from "./flow-report.ts";
import { readOnlyProblem } from "../shared/readonly-bash.ts";
import { afterMergeStep, gateOpenSteps, deliverMergeOpen, mergeAmendment, mergeDecisions, mergeDecisionsText, checkpointAmendment, checkpointNote, checkpointOutcome, deliverHint, deliverHintsBlock, deliverStepSpec, hasCheckpointAmendment, checkpointText, isPlannedTag, parseDeliverStep, publishRefusal, withCheckpoints } from "./checkpoints.ts";
import { pushArgs, tagDecision } from "./tags.ts";
import { type CheckVerdict, autopilotAmendment, autopilotReply, checkTitle, checkVerdict, cleanCheck, waitCheckProblem, type HumanCheck, humanChecks, parseVerifyStep, parseWaitStep, pollDecision, waitKindProblem, autopilotSkipsWait, replaceWait, resumePrefix, verifyAmendment, waitAmendment } from "./waits.ts";
import { nextStage, parseStages, planWaitProblems, stageLine, stageNote, stageStart, stagesOutcome } from "./stages.ts";
import { planToolProblem, planToolRefused, phaseToolRefusal } from "../shared/readonly-tools.ts";
import { PLAN_ARBITER, PLAN_APPROVE, PLAN_BACK, askMenu, planMenuRequest, resumeContent } from "./asks.ts";
import { refilterPlanTools, hiddenInPhase, syncFlowOnlyTools } from "./plan-tools.ts";
import { claimJudgeCall, type JudgeParams } from "./judge-claim.ts";
import { countSubagent } from "./agent-events.ts";
import { MetricsQueue, type MetricEvent, subagentMetric, judgeMetric } from "./metrics.ts";
import {
	AGENT_ROLES,
	addUsage,
	type DiffPart,
	emptyUsage,
	fitDiffs,
	forwardedServers,
	knowledgeFor as agentsKnowledgeFor,
	loadConfig as loadAgentsConfig,
	mapLimit,
	type ReviewResult,
	type RunResult,
	roleTools,
	runCritic,
	runJudge,
	runSubagent,
	renderRuns,
	toolProgress,
} from "../agents/api.ts";
import type { RunView } from "../shared/runs.ts";
import { covers, type Deviation, deviationBlock, judgeKnowledge, knowledgeFooter, parseDeviations } from "./knowledge.ts";
import {
	emptyFlowUsage,
	emptyStageTokens,
	type FlowSummary,
	type FlowRun,
	type FlowUsage,
	FlowView,
	STAGES,
	type Stage,
	type SubRole,
	summaryLines,
} from "./view.ts";
import { shortModel } from "../shared/runs.ts";
import { APPROVED_FINAL, assistantText, citedPaths, countFindings, createFlow, type Diff, execFileAsync, type FlowState, FOLDERS_ENTRY, GIT_GUARD_EXTENSION, type JudgeResult, type LastKnowledge, MAX_PLAN_CHARS, MODEL_ROLES, OWN_TOOLS, type Phase, type PlanSnap, type ReviewPlan, STATE_ENTRY, SUMMARY_ENTRY, type ToolReply } from "./flow/context.ts";
import { advanceReviewBase, collectBoard, collectFlowDiff, dropReviewRefs, existingFolders, flowRepos, git, gitRoot, initReviewBase, joinReviewBase, judge, markPassed, nextAmendmentNumber, planCardReady, planCardText, planForJudge, refreshReviewBase, repoRoots, restoreReview, stageCheckpoints } from "./flow/diff.ts";
import { abortGate, askUser, lastAssistantText, notifyUser, scheduleIdleNotice } from "./flow/notify.ts";
import { judgeKnowledgeServer, modelOf, roleSpecOf, runRole } from "./flow/roles.ts";

export default function workflow(pi: ExtensionAPI) {
	const fl = createFlow(pi);

	const autopilotOn = (): boolean => fl.autopilotOverride ?? fl.cfg.autopilot;
	/** An autopilot choice for the final card. */
	const noteAuto = (text: string): void => {
		fl.state.autoDecisions = [...(fl.state.autoDecisions ?? []), text.replace(/\s+/g, " ").slice(0, 240)].slice(-30);
		persist();
	};

	pi.registerFlag("add-dir", {
		description: "Extra folders for this session, separated by ; on Windows and : elsewhere",
		type: "string",
	});

	pi.registerFlag("flow", {
		description: "Workflow phase to start in: discuss, plan, execute, test or off (default from workflow.json)",
		type: "string",
	});

	// ----------------------------------------------------------------------
	// Phases and models
	// ----------------------------------------------------------------------

	function persist(): void {
		fl.state.tokens = { ...fl.view.used };
		fl.state.tokenUnit = "both";
		fl.state.flow = structuredClone(fl.view.flow);
		fl.state.flowStarted = fl.view.flowStarted;
		pi.appendEntry(STATE_ENTRY, fl.state);
	}

	/** K1: appends the folder list as a `session-folders` entry when the newest one on the branch differs. */
	function publishFolders(ctx: ExtensionContext): void {
		const data = { v: 1, cwd: ctx.cwd.replace(/\\/g, "/"), folders: [...(fl.state.folders ?? [])] };
		const newest = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === FOLDERS_ENTRY)
			.pop() as { data?: { cwd?: unknown; folders?: unknown } } | undefined;
		if (newest?.data && newest.data.cwd === data.cwd && JSON.stringify(newest.data.folders) === JSON.stringify(data.folders)) return;
		pi.appendEntry(FOLDERS_ENTRY, data);
	}

	/** Ends the current flow: shows its token breakdown and starts counting the next one. False if it had none. */
	function summarizeFlow(outcome: string, ok: boolean, extra?: HumanCheck[]): boolean {
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
		if (fl.state.planDoc && !fl.state.planDoc.finished) planMilestone(undefined, { at: new Date().toISOString(), ok, text: outcome });
		fl.state.touchedRepos = undefined;
		fl.view.settleMain();
		if (!fl.view.hasFlowUsage() && !steps && !findings && !lateFindings && !autopilot.length && !human.length) {
			if (flowId) {
				const empty = fl.view.peekFlow(outcome, ok);
				recordMetric({ kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: empty.started, ended: empty.ended, stages: empty.stages });
			}
			persist();
			return false;
		}
		const summary = fl.view.endFlow(outcome, ok);
		pi.appendEntry(SUMMARY_ENTRY, { ...summary, steps, findings, ...(lateFindings ? { lateFindings } : {}), ...(autopilot.length ? { autopilot } : {}), ...(human.length ? { humanChecks: human } : {}) });
		if (flowId) recordMetric({ kind: "flow", at: new Date().toISOString(), flowId, outcome, ok, started: summary.started, ended: summary.ended, stages: summary.stages });
		persist();
		return true;
	}

	/** A flow has ended: on to the phase `returnTo` names. */
	async function endFlow(ctx: ExtensionContext): Promise<void> {
		notifyUser(fl, ctx, "flow finished");
		await dropReviewRefs(fl, ctx);
		fl.state.reviewBase = undefined;
		fl.state.passedTrees = undefined;
		fl.state.judgedMerges = undefined;
		fl.state.waiting = undefined;
		stopWaitTimer();
		updateStatus(ctx);
		const next = phaseAfterFlow(fl.cfg.returnTo, fl.state.phase);
		if (!next) {
			if (fl.cfg.returnTo === "off" && fl.state.phase === "execute") await setPhase(ctx, "off"); // restores the model from before the flow
			return;
		}
		await setPhase(ctx, next);
		ctx.ui.notify(`workflow: flow done, back to ${next === "discuss" ? "discussion" : "planning"} on ${describeRole(fl.cfg.roles[next])}`, "info");
	}

	function updateStatus(ctx: ExtensionContext): void {
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
		if (ctx.hasUI) ctx.ui.setStatus("workflow-autopilot", autopilotOn() ? "autopilot" : undefined);
		if (ctx.hasUI) ctx.ui.setStatus("workflow-folders", n ? `+${n} folder${n === 1 ? "" : "s"}` : undefined);
		if (fl.state.approvedPlan && cl?.length && fl.state.phase === "execute") {
			const st = currentStages();
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
		emitStatus();
		liveTick();
	}

	/** K4: tells other extensions the phase and stage; only when it changed. */
	function emitStatus(): void {
		const st = currentStages();
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
			pi.events.emit("workflow:status", payload);
		} catch {}
	}

	/** Switches the main session to a role's model and thinking level. */
	async function applyRole(ctx: ExtensionContext, role: Role): Promise<boolean> {
		const spec = fl.cfg.roles[role];
		const slash = spec.model.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(spec.model.slice(0, slash), spec.model.slice(slash + 1)) : undefined;
		if (!model) {
			ctx.ui.notify(`workflow: model ${spec.model} (${role}) not found — check ${CONFIG_PATH}`, "error");
			return false;
		}
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`workflow: no credentials for ${spec.model} (${role})`, "error");
			return false;
		}
		if (spec.thinking) pi.setThinkingLevel(spec.thinking);
		return true;
	}

	/** Puts back the model and thinking level the session had before the flow; keeps the current ones when the model is gone. */
	async function restorePreFlowModel(ctx: ExtensionContext, saved: { model: string; thinking?: string }): Promise<void> {
		const slash = saved.model.indexOf("/");
		const model = slash > 0 ? ctx.modelRegistry.find(saved.model.slice(0, slash), saved.model.slice(slash + 1)) : undefined;
		if (!model || !(await pi.setModel(model))) {
			ctx.ui.notify(`workflow: the model from before the flow (${saved.model}) is not available; keeping the current one`, "warning");
			return;
		}
		if (saved.thinking) pi.setThinkingLevel(saved.thinking as ReturnType<typeof pi.getThinkingLevel>);
	}

	function blockPlanTools(): void {
		fl.state.toolsBeforePlan ??= pi.getActiveTools();
		pi.setActiveTools(fl.state.toolsBeforePlan.filter((t) => !planToolRefusedIn(t)));
	}

	function planToolRefusedIn(name: string): boolean {
		return hiddenInPhase("plan", name, (n) => planToolRefused(n, planAllowedTools(), fl.cfg.planBlockedTools) !== null);
	}

	/** Tools that registered after the phase began (an MCP server that connected late) get the same filter. */
	function refilterTools(): void {
		if ((fl.state.phase !== "discuss" && fl.state.phase !== "plan") || !fl.state.toolsBeforePlan) return;
		try {
			refilterPlanTools(pi, fl.state.toolsBeforePlan, (t) => planToolRefusedIn(t));
		} catch {
			// the turn goes on with the tools it has
		}
	}

	/** The widget stage the main session is in. */
	function phaseStage(): Stage {
		return fl.state.phase === "discuss" ? "discuss" : fl.state.phase === "plan" ? "plan" : "execute";
	}

	function restorePlanTools(): void {
		if (!fl.state.toolsBeforePlan) return;
		const extra = pi.getActiveTools().filter((t) => !fl.state.toolsBeforePlan!.includes(t));
		pi.setActiveTools([...fl.state.toolsBeforePlan, ...extra]);
		fl.state.toolsBeforePlan = undefined;
	}

	/** The result is always true. */
	async function setPhase(ctx: ExtensionContext, phase: Phase): Promise<boolean> {
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
			summarizeFlow(stoppedSummary(phase === "plan" ? "back to planning" : phase === "discuss" ? "back to discussion" : "abandoned"), false);
		}
		fl.planReady = false;
		fl.planProposed = false;
		fl.planDraft = { full: "", changes: [] };
		fl.planWaitRetried = false; fl.planWaitNow = [];
		const readOnly = (p: Phase) => p === "discuss" || p === "plan";
		// Discuss and plan share one tool set, so moving between them keeps the snapshot.
		if (phase !== fl.state.phase && !(readOnly(fl.state.phase) && readOnly(phase))) {
			if (readOnly(fl.state.phase)) restorePlanTools();
			if (readOnly(phase)) blockPlanTools();
		}
		if (!readOnly(phase)) syncFlowOnlyTools(pi, phase); // plan_check and deliver only exist inside a flow
		if (leavingFlow && fl.state.planDoc && !fl.state.planDoc.finished) planMilestone(ctx, { at: new Date().toISOString(), ok: false, text: "abandoned" });
		const samePhase = phase === fl.state.phase; // a repeated setPhase keeps what the judge already passed
		const modelAction = preFlowModelAction(fl.state.phase, phase);
		if (modelAction === "save" && ctx.model) fl.state.preFlowModel = { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel() };
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
		stopWaitTimer();
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
		if (phase !== "off") await applyRole(ctx, phase);
		else if (restoreModel) await restorePreFlowModel(ctx, restoreModel);
		if (phase === "off") fl.state.preFlowModel = undefined;
		persist();
		updateStatus(ctx);
		return true;
	}

	function sendPlanKickoff(open?: Finding[], notes?: Finding[]): void {
		const extra = (open?.length ? "\n\nOpen discussion-judge findings the plan must address:\n" + open.map((f) => `- ${f.head}`).join("\n") : "") + (notes?.length ? "\n\nMinor discussion-judge notes (take them into the plan where they fit; they are not blockers):\n" + notes.map((f) => `- ${f.head}`).join("\n") : "");
		pi.sendMessage({ customType: "workflow-plan-kickoff", content: prompts.PLAN_KICKOFF + extra, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	/** Re-reads the steps from the approved plan (after an amendment too), keeping the ticks of the steps still in it. */
	function refreshChecklist(): void {
		const list = fl.state.approvedPlan ? mergeChecklist(fl.state.approvedPlan, fl.state.checklist) : [];
		fl.state.checklist = list.length ? list : undefined;
	}

	/** Records the plan that starts executing; for a staged plan also stage 1. Returns the text to add to the start message. */
	function startExecution(ctx: ExtensionContext, plan: string | undefined): string {
		fl.state.approvedPlan = plan || undefined;
		fl.state.checklist = undefined;
		fl.state.planDoc = undefined;
		fl.state.flowFindings = undefined;
		fl.state.flowSummarized = undefined;
		refreshChecklist();
		updateStatus(ctx);
		fl.state.stageOutcomes = undefined;
		fl.state.stageJudged = undefined;
		const stages = parseStages(plan);
		fl.state.stage = stages.length ? 1 : undefined;
		planMilestone(ctx);
		if (!stages.length) return deliverHintsText(undefined);
		ctx.ui.notify(`workflow: staged plan, ${stages.length} stages; stage 1: ${stages[0].title}`, "info");
		const first = stageStart(stages, 1);
		if (holdForStageWait(ctx, stages[0], first)) return `\n\nStage 1 waits for: ${stages[0].after?.reason}. Don't start it; end your turn now. The workflow sends you the stage when the wait is over.`;
		return `\n\n${first}${deliverHintsText(1)}`;
	}

	/** The stages of the approved plan and the current one, or null when the plan is not staged. */
	function currentStages() {
		const stages = fl.state.stage ? parseStages(fl.state.approvedPlan) : [];
		return stages.length && fl.state.stage ? { stages, current: fl.state.stage } : null;
	}

	/** The open Deliver steps of `stage` with the call each one makes, as text to append to a message ("" when there are none). */
	function deliverHintsText(stage: number | undefined): string {
		const block = deliverHintsBlock(fl.state.approvedPlan ?? "", fl.state.checklist, stage);
		return block ? `\n\n${block}` : "";
	}

	/** A refusal of a command the executor may not run. */
	function publishRefuse(problem: string): string {
		return publishRefusal(problem);
	}

	/** ` → call deliver …` for a Deliver step that names a tag, or "". */
	function deliverLine(id: string, stage: number | undefined): string {
		const spec = deliverStepSpec(fl.state.approvedPlan ?? "", id);
		const hint = spec ? deliverHint(id, spec) : "";
		return hint ? ` ${hint}` : "";
	}

	async function approve(ctx: ExtensionContext, arbiterOnFlaw = false): Promise<void> {
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
		await setPhase(ctx, "execute");
		const extra = startExecution(ctx, plan);
		persist();
		handover("workflow-execute", APPROVED_FINAL + extra, ctx);
	}

	async function escalate(ctx: ExtensionContext): Promise<void> {
		if (await applyRole(ctx, "escalate")) {
			fl.state.escalated = true;
			persist();
			updateStatus(ctx);
			ctx.ui.notify(`workflow: escalated to ${describeRole(fl.cfg.roles.escalate)}. /flow back to return.`, "warning");
		}
	}

	async function deescalate(ctx: ExtensionContext): Promise<void> {
		fl.state.escalated = false;
		if (fl.state.phase !== "off") await applyRole(ctx, fl.state.phase);
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`workflow: back to ${fl.state.phase}${fl.state.phase === "off" ? "" : ` on ${describeRole(fl.cfg.roles[fl.state.phase])}`}`, "info");
	}

	// ----------------------------------------------------------------------
	// Plan files
	// ----------------------------------------------------------------------

	const gitEnv: Git = async (cwd, args, env) => {
		try {
			const r = await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
			return { code: 0, stdout: String(r.stdout), stderr: String(r.stderr) };
		} catch (e) {
			const err = e as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
			return { code: typeof err.code === "number" ? err.code : 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") };
		}
	};

	const metricsFolder = (id: string) => {
		const d = fl.plan.planDirs.get(id);
		return d ? path.join(d, id) : undefined;
	};
	const metricsFlushAll = () => fl.metrics.flush(metricsFolder, fl.state.planDoc && !fl.state.planDoc.finished ? fl.state.planDoc.flowId : undefined);
	function recordMetric(e: MetricEvent): void {
		fl.metrics.record(e);
		metricsFlushAll();
	}

	async function planDirFor(root: string | null): Promise<string> {
		if (root === null) return plansDir(gitEnv, null, getAgentDir());
		const key = repoKey(root);
		let dir = fl.plan.plansDirCache.get(key);
		if (dir === undefined) {
			let answered = false;
			dir = await plansDir(async (cwd, args, env) => {
				const r = await gitEnv(cwd, args, env);
				answered = r.code === 0;
				return r;
			}, root, getAgentDir());
			if (answered) fl.plan.plansDirCache.set(key, dir);
		}
		return dir;
	}

	function refreshClaim(): void {
		const dir = fl.claim.claimedFlow ? fl.plan.planDirs.get(fl.claim.claimedFlow) : undefined;
		if (!fl.claim.claimedFlow || !dir) return;
		try {
			writeClaim(dir, fl.claim.claimedFlow, { v: 1, pid: process.pid, host: os.hostname(), cwd: fl.claim.claimCwd || process.cwd(), updated: new Date().toISOString() });
		} catch {}
	}
	function stopClaimTimer(): void {
		if (fl.claim.claimTimer) clearInterval(fl.claim.claimTimer);
		fl.claim.claimTimer = undefined;
		fl.claim.claimedFlow = undefined;
	}

	function liveSnapshot(): LiveInfo | undefined {
		const flowId = fl.state.planDoc?.flowId;
		if (!flowId || !fl.plan.planDirs.get(flowId)) return undefined;
		const st = currentStages();
		return {
			v: 1,
			flowId,
			title: fl.state.approvedPlan ? planTitle(fl.state.approvedPlan) : flowId,
			pid: process.pid,
			host: os.hostname(),
			cwd: fl.claim.claimCwd || process.cwd(),
			updated: new Date().toISOString(),
			phase: fl.state.phase,
			...(st ? { stage: st.current, stages: st.stages.length } : {}),
			steps: (fl.state.checklist ?? []).map((i) => ({ id: i.id, text: i.text.slice(0, 80), done: i.done })),
			judgeRound: fl.state.judgeRounds,
			autopilot: autopilotOn(),
			...(fl.state.waiting ? { waiting: fl.state.waiting.reason.slice(0, 120) } : {}),
			runs: fl.view.runs.filter((r) => r.status === "running").slice(0, 6).map((r) => ({ role: r.role, label: r.label.slice(0, 80), activity: (r.activity ?? "").slice(0, 80) })),
			events: [],
		};
	}
	function stopLiveTimer(): void {
		if (fl.live.liveTimer) clearInterval(fl.live.liveTimer);
		fl.live.liveTimer = undefined;
	}
	/** Ends the snapshot of a flow this session no longer holds in `state`: no wait, no runs, a final event. */
	function liveFinish(dir: string, flowId: string, text: string): void {
		try {
			const cur = readLive(dir, flowId);
			if (!cur) return;
			cur.waiting = undefined;
			cur.runs = [];
			cur.updated = new Date().toISOString();
			cur.events = [...cur.events, { at: cur.updated, text: `finished: ${text}` }].slice(-20);
			fs.writeFileSync(path.join(dir, flowId, "live.json"), `${JSON.stringify(cur, null, 2)}
`);
		} catch {}
	}
	function liveTick(extra?: string): void {
		// Once the flow is finished only the final write (with `extra`) goes through.
		if (fl.state.planDoc?.finished && !extra) {
			stopLiveTimer();
			return;
		}
		try {
			const snap = liveSnapshot();
			if (!snap) {
				stopLiveTimer();
				return;
			}
			if (fl.live.liveFlow !== snap.flowId) {
				fl.live.liveFlow = snap.flowId;
				fl.live.liveLast = undefined;
				fl.live.liveLastJson = "";
				fl.live.liveEventLog = [];
			}
			const now = Date.now();
			const at = new Date(now).toISOString();
			const texts = [...liveEvents(fl.live.liveLast, snap), ...(extra ? [extra] : [])];
			const log = [...fl.live.liveEventLog, ...texts.map((text) => ({ at, text }))].slice(-20);
			snap.events = log;
			const key = JSON.stringify({ ...snap, updated: "" });
			if (key === fl.live.liveLastJson && now - fl.live.liveLastWrite < 60_000) return;
			const dir = fl.plan.planDirs.get(snap.flowId)!;
			const folder = path.join(dir, snap.flowId);
			fs.mkdirSync(folder, { recursive: true });
			fs.writeFileSync(path.join(folder, "live.json"), `${JSON.stringify(snap, null, 2)}\n`);
			fl.live.liveLast = snap;
			fl.live.liveLastJson = key;
			fl.live.liveLastWrite = now;
			fl.live.liveEventLog = log;
			if (!fl.live.liveRegistered.has(dir)) {
				fl.live.liveRegistered.add(dir);
				addToRegistry(path.join(getAgentDir(), "workflow", "board.json"), dir, new Date());
			}
			if (!fl.live.liveTimer && !fl.state.planDoc?.finished) {
				fl.live.liveTimer = setInterval(() => liveTick(), 5_000);
				fl.live.liveTimer.unref?.();
			}
		} catch {}
	}

	async function writePlan(ctx: ExtensionContext, snap: PlanSnap): Promise<void> {
		fl.claim.claimCwd = ctx.cwd.replace(/\\/g, "/");
		const found = [...(await flowRepos(fl, ctx)).map((r) => r.root), ...(await Promise.all(snap.touched.map((t) => gitRoot(fl, t))))];
		const roots = uniqueRoots([...snap.roots, ...found.filter((r): r is string => !!r)]);
		const dir = fl.plan.planDirs.get(snap.flowId) ?? (await planDirFor(roots[0] ?? null));
		const infos = await Promise.all(roots.map((r) => repoInfo(gitEnv, r)));
		const status: PlanStatus = {
			v: 1,
			flowId: snap.flowId,
			rev: snap.rev,
			updated: new Date().toISOString(),
			title: planTitle(snap.plan),
			...(snap.stage ? { stage: snap.stage } : {}),
			...(snap.kind ? { kind: snap.kind } : {}),
			done: (snap.checklist ?? []).filter((i) => i.done).map((i) => i.id),
			...(snap.finished ? { finished: snap.finished } : {}),
			...(snap.waiting ? { waiting: snap.waiting } : {}),
			...(snap.checkpoints?.length ? { checkpoints: snap.checkpoints } : {}),
			...(snap.reviewBase && Object.keys(snap.reviewBase).length ? { reviewBase: snap.reviewBase } : {}),
			...(snap.passedTrees && Object.keys(snap.passedTrees).length ? { passedTrees: snap.passedTrees } : {}),
			...(snap.judgedMerges && Object.keys(snap.judgedMerges).length ? { judgedMerges: snap.judgedMerges } : {}),
			repos: infos.map((info, i) => ({ ...info, primary: i === 0 })),
		};
		const planMd = renderPlanFile(snap.flowId, snap.plan, snap.checklist, snap.finished, snap.waiting?.reason);
		writeLocal(dir, snap.flowId, planMd, status);
		fl.plan.planDirs.set(snap.flowId, dir);
		fl.plan.planLast.set(snap.flowId, { dir, status });
		if (snap.finished) {
			dropClaim(dir, snap.flowId);
			if (fl.claim.claimedFlow === snap.flowId) stopClaimTimer();
			if (fl.state.planDoc?.flowId === snap.flowId) {
				liveTick(`finished: ${snap.finished.text}`);
				stopLiveTimer();
			} else liveFinish(dir, snap.flowId, snap.finished.text);
		} else if (fl.state.planDoc?.flowId === snap.flowId) {
			fl.claim.claimedFlow = snap.flowId;
			refreshClaim();
			fl.claim.claimTimer ??= setInterval(refreshClaim, 60_000);
			fl.claim.claimTimer.unref?.();
		}
		metricsFlushAll();
		const live = fl.state.planDoc?.flowId === snap.flowId ? fl.state.planDoc : undefined;
		if (live && roots.join("\n") !== live.roots.join("\n")) {
			live.roots = roots;
			persist();
		}
		const revs = await mapLimit(roots, 3, (root) => syncRoot(ctx, root, snap, planMd, status));
		const top = Math.max(snap.rev, ...revs);
		if (live && top > live.rev) {
			live.rev = top;
			persist();
		}
		if (snap.finished && fl.cfg.plans.keepCount === 0) deleteLocal(dir, snap.flowId);
	}

	function planWarn(ctx: ExtensionContext, flowId: string, text: string): void {
		if (fl.plan.planWarned.has(flowId)) return;
		fl.plan.planWarned.add(flowId);
		ctx.ui.notify(`workflow: ${text}`, "warning");
	}

	/** Whether plan refs of a repo with this remote URL may be pushed. */
	function syncAllowed(url: string): boolean {
		const u = url.toLowerCase();
		return fl.cfg.plans.sync === "remote" && !fl.cfg.plans.localOnly.some((s) => s && u.includes(s.toLowerCase()));
	}

	/** Commits the plan into the repo's plan ref and pushes it. Returns the highest rev written (a rejected push is redone on top of the remote's commit). Never throws. */
	async function syncRoot(ctx: ExtensionContext, root: string, snap: PlanSnap, planMd: string, status0: PlanStatus): Promise<number> {
		let status = status0;
		try {
			const remote = await remoteOf(gitEnv, root);
			const push = !!remote && syncAllowed(remote.url);
			if (snap.finished && fl.cfg.plans.keepCount === 0) {
				await deleteRef(gitEnv, root, snap.flowId, push ? remote?.name : undefined);
				return 0;
			}
			const cur = await refRev(gitEnv, root, snap.flowId);
			if (cur !== null) {
				if (snap.retry) {
					if (cur > status.rev) {
						planWarn(ctx, snap.flowId, "this flow moved on in another device; use /flow resume");
						return cur;
					}
				} else if (cur >= status.rev) status = { ...status, rev: cur + 1 };
			}
			if (!(await commitRef(gitEnv, root, snap.flowId, planMd, `${JSON.stringify(status, null, 2)}\n`))) {
				planWarn(ctx, snap.flowId, `could not save the plan ref in ${root}`);
				return 0;
			}
			if (!push || !remote) return status.rev;
			const first = await pushRef(gitEnv, root, remote.name, snap.flowId);
			if (first === "ok") return status.rev;
			if (first === "failed") {
				planWarn(ctx, snap.flowId, `could not push the plan to ${remote.url} (it stays local; plans.sync "local" or plans.localOnly turns pushing off)`);
				return status.rev;
			}
			const theirs = (await fetchMirror(gitEnv, root, remote.name)) ? (await listRefs(gitEnv, root, "remote-plans")).find((e) => e.flowId === snap.flowId) : undefined;
			if (!theirs) {
				planWarn(ctx, snap.flowId, `could not push the plan to ${remote.url}: it changed there`);
				return status.rev;
			}
			const rev = Math.max(status.rev, theirs.status?.rev ?? 0) + 1;
			const next: PlanStatus = { ...status, rev };
			const commit = await commitRef(gitEnv, root, snap.flowId, planMd, `${JSON.stringify(next, null, 2)}\n`, theirs.commit);
			if (!commit || (await pushRef(gitEnv, root, remote.name, snap.flowId)) !== "ok") planWarn(ctx, snap.flowId, `could not push the plan to ${remote.url}: it changed there`);
			return rev;
		} catch (e) {
			planWarn(ctx, snap.flowId, `plan sync failed in ${root}: ${(e as Error).message}`);
			return 0;
		}
	}

	/** A point where the plan file is rewritten: approval, an amendment, a stage end, the flow's end. Runs in the background, in order; `bump: false` only restores the file. */
	/** The wait and checkpoints as they go into the plan's status. */
	function waitSnapshot(): Pick<PlanSnap, "waiting" | "checkpoints" | "reviewBase" | "passedTrees" | "judgedMerges"> {
		const w = fl.state.waiting;
		return {
			...(w ? { waiting: { reason: w.reason, ...(w.check ? { check: w.check } : {}), ...(w.waitKind ? { waitKind: w.waitKind } : {}), since: w.since, planned: w.planned, ...(w.atStageStart ? { atStageStart: true } : {}), ...(w.held ? { held: w.held } : {}) } } : {}),
			...(fl.state.checkpoints?.length ? { checkpoints: fl.state.checkpoints.map((c) => ({ ...(c.step ? { step: c.step } : {}), ...(c.stage ? { stage: c.stage } : {}), text: c.text, ok: c.ok })) } : {}),
			...(fl.state.reviewBase && Object.keys(fl.state.reviewBase).length ? { reviewBase: { ...fl.state.reviewBase } } : {}),
			...(fl.state.passedTrees && Object.keys(fl.state.passedTrees).length ? { passedTrees: { ...fl.state.passedTrees } } : {}),
			...(fl.state.judgedMerges && Object.keys(fl.state.judgedMerges).length ? { judgedMerges: { ...fl.state.judgedMerges } } : {}),
		};
	}

	function planMilestone(ctx: ExtensionContext | undefined, finished?: Finished, bump = true): void {
		const plan = fl.state.approvedPlan;
		if (!plan) return;
		const doc = (fl.state.planDoc ??= { flowId: newFlowId(planTitle(plan), new Date(), randomUUID().slice(0, 4)), rev: 0, roots: [] });
		if (bump) doc.rev++;
		if (finished) doc.finished = finished;
		const snap: PlanSnap = {
			flowId: doc.flowId,
			rev: doc.rev,
			roots: [...doc.roots],
			plan,
			checklist: fl.state.checklist?.map((i) => ({ ...i })),
			stage: fl.state.stage,
			touched: [...(fl.state.touchedRepos ?? [])],
			finished: doc.finished,
			...waitSnapshot(),
			retry: !bump,
		};
		const c = ctx ?? fl.lastCtx;
		if (!c) return;
		fl.plan.planChain = fl.plan.planChain
			.then(() => writePlan(c, snap))
			.catch((e) => {
				if (fl.plan.planWarned.has(snap.flowId)) return;
				fl.plan.planWarned.add(snap.flowId);
				c.ui.notify(`workflow: could not save the plan file: ${(e as Error).message}`, "warning");
			});
	}

	/** Rewrites the current plan file from state (ticks changed). No rev, no git. Returns the path, or undefined when nothing was written before. */
	function rewritePlanFile(): string | undefined {
		const doc = fl.state.planDoc;
		const last = doc && fl.plan.planLast.get(doc.flowId);
		if (!doc || !last || !fl.state.approvedPlan) return undefined;
		try {
			const status: PlanStatus = { ...last.status, updated: new Date().toISOString(), done: (fl.state.checklist ?? []).filter((i) => i.done).map((i) => i.id) };
			delete status.waiting;
			delete status.checkpoints;
			delete status.reviewBase;
			delete status.passedTrees;
			delete status.judgedMerges;
			Object.assign(status, waitSnapshot());
			const file = writeLocal(last.dir, doc.flowId, renderPlanFile(doc.flowId, fl.state.approvedPlan, fl.state.checklist, doc.finished, fl.state.waiting?.reason), status);
			last.status = status;
			return file;
		} catch {
			return undefined;
		}
	}

	/** The path of the plan file, rewritten from state first when it went missing; undefined when there is none yet. */
	function planFilePath(): string | undefined {
		const doc = fl.state.planDoc;
		const dir = doc && fl.plan.planDirs.get(doc.flowId);
		if (!doc || !dir || !fl.state.approvedPlan) return undefined;
		const file = path.join(dir, doc.flowId, "plan.md");
		if (fs.existsSync(file)) return file;
		if (doc.finished && fl.cfg.plans.keepCount === 0) return undefined;
		return rewritePlanFile();
	}

	/** Deletes plans past the retention limits in this flow's plan folders, and restores the active flow's file. */
	async function planHousekeeping(ctx: ExtensionContext): Promise<void> {
		try {
			const repos = await flowRepos(fl, ctx);
			const dirs = new Set<string>([await planDirFor(null)]);
			for (const r of repos) dirs.add(await planDirFor(r.root));
			const active = fl.state.planDoc && !fl.state.planDoc.finished ? fl.state.planDoc.flowId : undefined;
			for (const dir of dirs) {
				const entries = readLocalStatuses(dir).map((e) => {
					const t = e.status ? Date.parse(e.status.updated) : NaN;
					return { flowId: e.flowId, updated: Number.isFinite(t) ? t : e.mtime, finished: e.status ? !!e.status.finished : true };
				});
				for (const id of pruneIds(entries, { keepDays: fl.cfg.plans.keepDays, keepCount: fl.cfg.plans.keepCount, now: Date.now(), activeId: active })) deleteLocal(dir, id);
			}
			fl.plan.planChain = fl.plan.planChain.then(() => mapLimit(repos, 3, (r) => pruneRefs(r.root, active))).then(() => {}, () => {});
			await fl.plan.planChain;
			if (active && fl.state.approvedPlan) planMilestone(ctx, undefined, false);
		} catch {}
	}

	/** The plan refs of one repo: fetch the remote's, keep the higher revs, delete those past retention (also on the remote). */
	async function pruneRefs(root: string, activeId: string | undefined): Promise<void> {
		try {
			const remote = await remoteOf(gitEnv, root);
			const sync = !!remote && syncAllowed(remote.url);
			if (remote && sync && (await fetchMirror(gitEnv, root, remote.name))) {
				for (const e of await listRefs(gitEnv, root, "remote-plans")) await adoptHigher(gitEnv, root, e.flowId);
			}
			const entries = (await listRefs(gitEnv, root, "plans")).map((e) => {
				const t = e.status ? Date.parse(e.status.updated) : NaN;
				return { flowId: e.flowId, updated: Number.isFinite(t) ? t : e.date, finished: e.status ? !!e.status.finished : true };
			});
			const pruned = pruneIds(entries, { keepDays: fl.cfg.plans.keepDays, keepCount: fl.cfg.plans.keepCount, now: Date.now(), activeId });
			for (const id of pruned) {
				await deleteRef(gitEnv, root, id, sync ? remote?.name : undefined);
			}
			// Review bases are local only: the pruned flows' go, and so do leftovers of crashed flows older than a day.
			const keep = new Set(entries.map((e) => e.flowId).filter((id) => !pruned.includes(id)));
			if (activeId) keep.add(activeId);
			const finished = entries.filter((e) => e.finished && e.flowId !== activeId).map((e) => e.flowId);
			await sweepReviewRefs(gitEnv, root, { drop: [...pruned, ...finished], keep, now: Date.now(), minAgeMs: 86_400_000 });
		} catch {}
	}

	const isDir = (p: string): boolean => {
		try {
			return fs.statSync(p).isDirectory();
		} catch {
			return false;
		}
	};

	/** `/flow resume`: rebuilds an unfinished flow from its plan ref, found in the working folder's repo or an added folder. */
	async function resumeFlow(ctx: ExtensionContext, wanted: string | undefined): Promise<void> {
		const notify = (text: string, level: "info" | "warning" = "warning") => ctx.ui.notify(`workflow: ${text}`, level);
		const busy = fl.state.phase === "execute" && fl.state.planDoc && !fl.state.planDoc.finished ? fl.state.planDoc.flowId : undefined;
		if (busy && (!wanted || !busy.startsWith(wanted))) {
			notify(`a flow is already running (${busy}); finish or leave it before resuming another`);
			return;
		}
		const cwdRoot = await gitRoot(fl, ctx.cwd);
		if (!cwdRoot) {
			notify("the working folder is not in a git repo, so there is no plan to resume");
			return;
		}
		const searchRoots: string[] = [cwdRoot];
		for (const f of existingFolders(fl)) {
			const r = await gitRoot(fl, f);
			if (r && !searchRoots.some((s) => repoKey(s) === repoKey(r))) searchRoots.push(r);
		}
		const found = new Map<string, { entry: RefEntry; root: string }>();
		fl.plan.planChain = fl.plan.planChain
			.then(async () => {
				for (const root of searchRoots) {
					const remote = await remoteOf(gitEnv, root);
					if (remote && (await fetchMirror(gitEnv, root, remote.name))) {
						for (const e of await listRefs(gitEnv, root, "remote-plans")) await adoptHigher(gitEnv, root, e.flowId);
					}
				}
			})
			.then(() => {}, () => {});
		await fl.plan.planChain;
		for (const root of searchRoots) {
			for (const e of await listRefs(gitEnv, root, "plans")) {
				if (!e.status || e.status.finished) continue;
				const prev = found.get(e.flowId);
				if (!prev || (prev.entry.status?.rev ?? 0) < e.status.rev) found.set(e.flowId, { entry: e, root });
			}
		}
		let candidates = [...found.values()].sort((a, b) => Date.parse(b.entry.status?.updated ?? "") - Date.parse(a.entry.status?.updated ?? ""));
		if (wanted) candidates = candidates.filter((c) => c.entry.flowId.startsWith(wanted));
		if (!candidates.length) {
			notify(wanted ? `no unfinished plan matches "${wanted}" in this repo or the added folders` : "no unfinished plan found in this repo or the added folders");
			return;
		}
		// S2: another live session may be running the flow.
		const claims = await Promise.all(
			candidates.map(async (c) => {
				const claim = readClaim(await planDirFor(c.root), c.entry.flowId);
				return claim && claim.pid !== process.pid ? claim : null;
			}),
		);
		const liveClaim = (i: number) => (claims[i] && claimLive(claims[i], Date.now(), os.hostname(), pidAlive) ? claims[i] : null);
		let pickIdx = 0;
		if (candidates.length > 1) {
			const labels = candidates.map((c, i) => {
				const live = liveClaim(i);
				return `${c.entry.status?.title} \u2014 ${c.entry.status?.updated.slice(0, 16).replace("T", " ")}${c.entry.status?.stage ? `, stage ${c.entry.status.stage}` : ""}${c.entry.status?.kind === "test" ? " (test flow)" : ""} (${c.entry.flowId})${live ? ` \u2014 running in ${live.cwd} (pid ${live.pid})` : ""}`;
			});
			const chosen = await ctx.ui.select("Resume which flow?", labels);
			const i = chosen ? labels.indexOf(chosen) : -1;
			if (i < 0) return;
			pickIdx = i;
		}
		const pick = candidates[pickIdx];
		const heldBy = liveClaim(pickIdx);
		if (heldBy) {
			notify(`${pick.entry.status?.title} is running in ${heldBy.cwd} (pid ${heldBy.pid}); finish or leave it there first`);
			return;
		}
		if (claims[pickIdx]) notify(`took over a stale claim from pid ${claims[pickIdx]!.pid}`, "info");
		if (busy && busy !== pick.entry.flowId) {
			notify(`a flow is already running (${busy}); finish or leave it before resuming another`);
			return;
		}
		const status = pick.entry.status;
		if (status?.kind === "test") {
			notify("test flows are gone; this one can't be resumed");
			return;
		}
		const md = await readPlanMd(gitEnv, pick.root, pick.entry.commit);
		if (!status || !md) {
			notify("the plan ref is unreadable");
			return;
		}
		const plan = splitPlanFile(md);

		const mine = new Map<string, string>();
		for (const root of searchRoots) {
			const remote = await remoteOf(gitEnv, root);
			if (remote) mine.set(remote.url, root);
		}
		const parent = path.dirname(cwdRoot);
		let siblings: string[] | undefined;
		const findSibling = async (url: string): Promise<string | undefined> => {
			if (!siblings) {
				try {
					siblings = fs.readdirSync(parent).slice(0, 200).map((n) => path.join(parent, n)).filter((d) => fs.existsSync(path.join(d, ".git")));
				} catch {
					siblings = [];
				}
			}
			for (const d of siblings) {
				const remote = await remoteOf(gitEnv, d);
				if (remote?.url === url) return (await gitRoot(fl, d)) ?? undefined;
			}
			return undefined;
		};
		const roots: { root: string; branch?: string; remote?: string }[] = [];
		for (const r of status.repos) {
			let root = r.remote ? mine.get(r.remote) : undefined;
			if (!root && r.remote) root = await findSibling(r.remote);
			if (!root) {
				const label = r.remote ?? "a repo without a remote";
				const answer = r.remote ? (await ctx.ui.input(`Where is ${label} on this device?`, "path to the repo, empty to skip"))?.trim() : "";
				const abs = answer ? path.resolve(ctx.cwd, answer).replace(/\\/g, "/") : "";
				root = abs && isDir(abs) ? ((await gitRoot(fl, abs)) ?? undefined) : undefined;
				if (!root) {
					notify(`${label}: not found on this device, skipped`);
					continue;
				}
			}
			if (!roots.some((x) => repoKey(x.root) === repoKey(root))) roots.push({ root, branch: r.branch, remote: r.remote });
		}
		if (!roots.some((x) => repoKey(x.root) === repoKey(cwdRoot))) roots.unshift({ root: cwdRoot });

		for (const r of roots) {
			if (!r.branch) continue;
			if (r.branch.startsWith("-") || r.branch.includes("@{") || (await gitEnv(r.root, ["check-ref-format", "--branch", r.branch])).code !== 0) {
				notify(`${r.root}: the plan names an invalid branch, left alone`);
				continue;
			}
			const info = await repoInfo(gitEnv, r.root);
			const dirty = await gitEnv(r.root, ["status", "--porcelain"]);
			if (dirty.code !== 0 || dirty.stdout.trim()) {
				notify(`${r.root} has uncommitted changes; it stays on ${info.branch ?? "a detached HEAD"} (the flow used ${r.branch})`);
				continue;
			}
			const remote = await remoteOf(gitEnv, r.root);
			const fetched = remote ? (await gitEnv(r.root, ["fetch", "--quiet", remote.name, `+refs/heads/${r.branch}:refs/remotes/${remote.name}/${r.branch}`])).code === 0 : false;
			const stuck = () => notify(`${r.root}: could not bring ${r.branch} up to ${remote?.name ?? "the remote"}/${r.branch}; check it by hand`);
			if (info.branch !== r.branch && (await gitEnv(r.root, ["switch", "--quiet", r.branch])).code !== 0) {
				stuck();
				continue;
			}
			if (remote && fetched && (await gitEnv(r.root, ["merge", "--ff-only", "--quiet", `${remote.name}/${r.branch}`])).code !== 0) stuck();
		}

		if (!(await setPhase(ctx, "execute"))) return;
		const folders = [...(fl.state.folders ?? [])];
		let added = 0;
		for (const r of roots) {
			const abs = path.resolve(r.root).replace(/\\/g, "/");
			if (repoKey(abs) === repoKey(ctx.cwd) || repoKey(abs) === repoKey(cwdRoot) || folders.some((f) => repoKey(f) === repoKey(abs))) continue;
			folders.push(abs);
			added++;
		}
		fl.state.folders = folders;
		fl.state.approvedPlan = plan;
		fl.state.stage = status.stage;
		fl.state.stageOutcomes = undefined;
		fl.state.stageJudged = undefined;
		fl.state.checklist = parseChecklist(plan).map((i) => ({ ...i, done: status.done.includes(i.id) }));
		if (!fl.state.checklist.length) fl.state.checklist = undefined;
		fl.state.checkpoints = status.checkpoints?.map((c) => ({ ...c }));
		await restoreReview(fl, ctx, status);
		fl.state.waiting = undefined;
		fl.wait.publishWaitSince.clear();
		if (status.waiting) {
			// Older status files lack the held text and the flags: rebuild the plain stage start for a stage that declares this wait.
			const resumedStages = fl.state.stage ? parseStages(plan) : [];
			const after = fl.state.stage ? resumedStages[fl.state.stage - 1]?.after : undefined;
			const atStart = status.waiting.atStageStart ?? (!!after && after.reason === status.waiting.reason);
			const held = status.waiting.held ?? (atStart && fl.state.stage ? stageStart(resumedStages, fl.state.stage) : undefined);
			const publishStep = /^Call publish_packages again with step (\S+)\.$/.exec(status.waiting.held ?? "")?.[1];
			if (publishStep) fl.wait.publishWaitSince.set(publishStep, status.waiting.since);
			setWaiting({
				...(publishStep ? { step: publishStep } : {}),
				...(status.waiting.waitKind === "external" ? { waitKind: "external" as const } : {}),
				reason: status.waiting.reason,
				...(cleanCheck(status.waiting.check) ? { check: cleanCheck(status.waiting.check) } : {}),
				since: status.waiting.since,
				stage: fl.state.stage,
				planned: status.waiting.planned ?? true,
				...(atStart ? { atStageStart: true } : {}),
				...(held ? { held } : {}),
			});
		}
		fl.state.planDoc = { flowId: status.flowId, rev: status.rev, roots: roots.map((r) => r.root) };
		persist();
		publishFolders(ctx);
		updateStatus(ctx);
		planMilestone(ctx);
		startWaitTimer(fl.state.waiting?.step && fl.wait.publishWaitSince.has(fl.state.waiting.step) ? Date.parse(fl.state.waiting.since) : undefined);
		await fl.plan.planChain;
		pi.sendMessage(
			{ customType: "workflow-resume-plan", content: `Resumed on this device: check \`git status\` and the branch in each repo, then continue with the open steps.\n\n${planCardText(fl)}`, display: true },
			{ triggerTurn: false },
		);
		notify(`resumed "${status.title}"${status.stage ? ` at stage ${status.stage}` : ""}; send a message to continue${added ? ` (reloading to add ${added} folder${added === 1 ? "" : "s"})` : ""}`, "info");
		if (added) {
			await ctx.waitForIdle();
			await ctx.reload();
		}
	}

	/** A very long plan loses its middle, never its amendments. */
	function trimPlan(plan: string): string {
		if (plan.length <= MAX_PLAN_CHARS) return plan;
		return `${plan.slice(0, 45_000)}\n\n[... middle of the plan omitted ...]\n\n${plan.slice(-15_000)}`;
	}

	/**
	 * Ends the view row of a review agents ran for flow (runJudge, runCritic) with flow's outcome, and records its
	 * usage and metric. A run that never reported a row gets one now, so the stage still counts it.
	 */
	function endReview(role: "judge" | "critic", ext: RunView | undefined, r: ReviewResult, started: number, ok: boolean, outcome: string): FlowRun {
		const row = (ext && fl.view.endMirror(ext, ok, outcome, r.model, r.usage)) ?? (() => {
			const run = fl.view.start(role, role === "judge" ? "review" : "document review", r.model);
			fl.view.finish(run, ok, outcome);
			fl.view.addFinished(role, r.model, r.usage);
			return run;
		})();
		recordMetric(subagentMetric(role, row.label, row.stage, r.model, started, Date.now(), r));
		return row;
	}

	/**
	 * One run of agents' judge with the approved plan as its spec: the whole diff ("full"), or for a re-review the changes
	 * since the last round with its findings ("incremental"). Flow recomputes the verdict and checks the knowledge step.
	 */
	async function judgeOnce(
		ctx: ExtensionContext,
		diff: Diff,
		focus: string | undefined,
		plan: Exclude<ReviewPlan, { kind: "same" }>,
		signal?: AbortSignal,
		onChange?: (run: FlowRun) => void,
		disputes?: string,
	): Promise<JudgeResult & { run: FlowRun }> {
		const recheck = plan.kind === "recheck";
		const server = judgeKnowledgeServer(fl);
		// After a round whose knowledge check passed, only the files changed since are checked again.
		const prevKnowledge = recheck && fl.state.lastKnowledge?.status === "checked" && fl.state.lastKnowledge.hash === plan.prev.hash ? fl.state.lastKnowledge : undefined;
		const scoped = prevKnowledge ? diff.checkNames.filter((f) => covers(plan.changed, f)) : [];
		const files = scoped.length ? scoped : diff.checkNames;
		const prev = recheck ? plan.prev : fl.state.lastJudge?.base === diff.base ? fl.state.lastJudge : undefined;
		const criteria = [
			prompts.JUDGE_CRITERIA,
			judgeAddenda(fl.state.minorRounds ?? 0),
			diff.multi ? prompts.repoNote(repoRoots(diff)) : "",
			`Every file in the whole change (${diff.names.length}):\n${diff.names.join("\n")}`,
		]
			.filter(Boolean)
			.join("\n\n");
		fl.view.stage = "judge";
		let ext: RunView | undefined;
		const started = Date.now();
		const r = await runJudge({
			mode: recheck ? "incremental" : "full",
			diff: recheck ? plan.parts : diff.parts,
			files,
			spec: fl.state.approvedPlan ? planForJudge(fl) : undefined,
			focus,
			criteria,
			previousFindings: prev ? parseFindings(prev.text) : undefined,
			disputes,
			cwd: ctx.cwd,
			signal,
			mcpServers: pi.getMcpServers(),
			onRun: (run) => {
				ext = run;
				onChange?.(fl.view.mirror("judge", run));
			},
		});
		fl.seenDiffs.add(diff.hash);
		if (!r.ok) {
			const run = endReview("judge", ext, r, started, false, r.error ?? "failed");
			onChange?.(run);
			fl.view.stage = phaseStage();
			return { verdict: "ERROR", text: `judge failed: ${r.error}`, findings: [], hash: diff.hash, usage: r.usage, run };
		}
		let text = r.text;
		const findings = r.findings;
		let knowledge: LastKnowledge | undefined;
		if (server) {
			const status = judgeKnowledge(r.toolCalls, text, files, server);
			// A scoped check did not look at the other files again: their deviations of the last round still stand.
			const fresh = parseDeviations(findings);
			const kept = scoped.length ? (prevKnowledge?.deviations ?? []).filter((d) => !covers(scoped, d.where.replace(/:\d.*$/, "")) && !fresh.some((n) => n.id === d.id && n.where === d.where)) : [];
			const deviations = [...fresh, ...kept];
			text += `\n\n${knowledgeFooter(status, deviations.length)}`;
			knowledge = { hash: diff.hash, status: status.status, ...(status.status === "checked" ? {} : { reason: status.reason }), deviations };
		}
		const verdict = codeVerdict(r.text, findings);
		const counted = countFindings(findings);
		const lateNote = counted.late ? ` + ${counted.late} late` : "";
		const knowledgeNote = knowledge ? ` · knowledge ${knowledge.status === "checked" ? "checked" : "not checked"}` : "";
		const run = endReview("judge", ext, r, started, verdict === "PASS", `${verdict} · ${counted.total} finding${counted.total === 1 ? "" : "s"}${lateNote}${recheck ? " · re-review" : ""}${knowledgeNote}`);
		recordMetric(judgeMetric("code", fl.state.judgeRounds + 1, verdict, findings));
		const late = lateFindingLines(findings);
		if (late.length) fl.state.lateFindings = [...new Set([...(fl.state.lateFindings ?? []), ...late])].slice(-30);
		onChange?.(run);
		// Back to the phase's stage either way.
		fl.view.stage = phaseStage();
		fl.state.lastJudge = plan.snaps ? { hash: diff.hash, repos: plan.snaps, base: diff.base, verdict, text } : undefined;
		if (plan.kind === "full") fl.state.lastFullPass = plan.snaps && verdict === "PASS" && !planFlaws(findings).length ? { repos: plan.snaps, base: diff.base } : undefined;
		if (fl.state.phase === "execute") fl.state.flowFindings = recordFindings(fl.state.flowFindings, fl.state.stage, findings);
		fl.state.lastKnowledge = knowledge;
		persist();
		return { verdict, text, findings, hash: diff.hash, usage: r.usage, run };
	}

	// ----------------------------------------------------------------------
	// Tools
	// ----------------------------------------------------------------------

	const title = (theme: Theme, name: string, role: Role | "judge" | "critic") =>
		theme.fg("toolTitle", theme.bold(`${name} `)) + theme.fg("muted", shortModel(modelOf(fl, role).model));

	// ----------------------------------------------------------------------
	// Wait points
	// ----------------------------------------------------------------------

	function stopWaitTimer(): void {
		if (fl.wait.waitTimer) clearInterval(fl.wait.waitTimer);
		fl.wait.waitTimer = undefined;
		if (fl.wait.waitFirstTimer) clearTimeout(fl.wait.waitFirstTimer);
		fl.wait.waitFirstTimer = undefined;
	}

	/** Polls the wait's check every `wait.pollMs` while the session is idle. A wait without a check, or whose check already passed, is not polled. */
	function startWaitTimer(sinceMs?: number): void {
		stopWaitTimer();
		const w = fl.state.waiting;
		if (!w?.check || w.checkPassed) return;
		fl.wait.waitTimerStart = sinceMs ?? Date.now();
		fl.wait.waitTimer = setInterval(() => void waitTick(), fl.cfg.wait.pollMs);
		(fl.wait.waitTimer as { unref?: () => void }).unref?.();
		fl.wait.waitFirstTimer = setTimeout(() => void waitTick(), 5_000);
		(fl.wait.waitFirstTimer as { unref?: () => void }).unref?.();
	}

	function resolveWaitShell(): { shell: string; args: string[] } | { error: string } {
		if (fl.wait.waitShell) return fl.wait.waitShell;
		try {
			const c = getShellConfig();
			fl.wait.waitShell = c.commandTransport === "stdin" ? { error: "no usable bash: only a WSL bash that needs stdin was found" } : { shell: c.shell, args: c.args };
		} catch (e) {
			fl.wait.waitShell = { error: `no usable bash: ${e instanceof Error ? e.message : String(e)}` };
		}
		return fl.wait.waitShell;
	}

	/** Runs a wait's check in pi's bash. Exit 0 passes; a failure or timeout is "not yet"; a check that cannot run is broken. */
	async function runWaitCheck(check: string): Promise<CheckVerdict> {
		const sh = resolveWaitShell();
		if ("error" in sh) return checkVerdict(sh, fl.cfg.wait.checkTimeoutMs);
		try {
			const r = await pi.exec(sh.shell, [...sh.args, check], { cwd: fl.lastCtx?.cwd, timeout: fl.cfg.wait.checkTimeoutMs });
			return checkVerdict({ code: r.code, stderr: r.stderr ?? "", killed: !!r.killed }, fl.cfg.wait.checkTimeoutMs);
		} catch (e) {
			return checkVerdict({ error: e instanceof Error ? e.message : String(e) }, fl.cfg.wait.checkTimeoutMs);
		}
	}

	/** The wait is over: clears it and records the new state. */
	function clearWait(ctx: ExtensionContext): void {
		fl.state.waiting = undefined;
		stopWaitTimer();
		persist();
		updateStatus(ctx);
		planMilestone(ctx);
	}

	/** Sets the wait; a wait set over an open one stops the old one's poll timer. */
	function setWaiting(next: FlowState["waiting"]): void {
		replaceWait(fl.state.waiting, { stopTimer: stopWaitTimer });
		fl.state.waiting = next;
	}

	/** The wait is over because a person typed: clears it and returns the message that resumes the executor. */
	function finishWait(ctx: ExtensionContext, w: NonNullable<FlowState["waiting"]>, how: "passed" | "forced" | "plain", text: string | undefined): string {
		clearWait(ctx);
		return resumeContent(resumePrefix(w.reason, how), w.held, text);
	}

	async function waitTick(): Promise<void> {
		const w = fl.state.waiting;
		const ctx = fl.lastCtx;
		if (!w || !ctx || fl.wait.waitChecking || fl.state.phase !== "execute") return;
		const elapsedMs = Date.now() - fl.wait.waitTimerStart;
		const limit = fl.cfg.wait.maxMs;
		const idle = ctx.isIdle() && (!ctx.hasUI || ctx.ui.getEditorText().trim() === "");
		const d = pollDecision({ waiting: true, hasCheck: !!w.check && !w.checkPassed, idle, elapsedMs, maxMs: limit });
		if (d === "hold") return;
		if (d === "stop") {
			stopWaitTimer();
			if (w.check && elapsedMs >= limit) {
				ctx.ui.notify(`workflow: stopped polling "${w.check}" after ${Math.round(elapsedMs / 60_000)} min; your next message checks again`, "warning");
				notifyUser(fl, ctx, `stopped waiting for "${w.check}" after ${Math.round(elapsedMs / 60_000)} min`);
			}
			return;
		}
		fl.wait.waitChecking = true;
		try {
			const verdict = await runWaitCheck(w.check as string);
			if (fl.state.waiting !== w) return;
			if (verdict.status === "broken") {
				stopWaitTimer();
				ctx.ui.notify(`workflow: wait check can't run (${verdict.detail}): ${w.check}; fix it or send a message to continue`, "warning");
				notifyUser(fl, ctx, `wait check can't run: ${verdict.detail}`);
				return;
			}
			if (verdict.status !== "pass") return;
			stopWaitTimer();
			if (fl.cfg.wait.autoResume) {
				clearWait(ctx);
				const body = w.held ?? "Continue with the open steps of the plan.";
				pi.sendMessage({ customType: "workflow-wait", content: `${resumePrefix(w.reason, "passed")} ${body}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
			} else {
				w.checkPassed = true;
				persist();
				ctx.ui.notify(`workflow: "${w.check}" passed; send any message to continue`, "info");
				notifyUser(fl, ctx, `"${w.check}" passed; send any message to continue`);
			}
		} finally {
			fl.wait.waitChecking = false;
		}
	}

	pi.registerTool({
		name: "wait_for_user",
		label: "Wait for user",
		description:
			"Pause the flow until a person has done something a later step needs (open the Unity Editor so the unity CLI can run). For a check only a person can do (play it in the Editor, look at visuals) use kind \"verify\": nothing pauses, the check is listed for the user after the flow. Optional `check` is a read-only command that exits 0 once it is done; the workflow runs it once at once, then every few minutes, and resumes you by itself. Then end your turn. With autopilot on, the tool tells you what to do instead of pausing, unless `manual: true`. Name the plan step as `step` when the plan has a `Wait:` step; otherwise the wait is added to the plan as an amendment.",
		promptSnippet: "wait_for_user: pause the flow until a person did something; resumes by check or by their reply",
		parameters: Type.Object({
			reason: Type.String({ description: "What the person must do, in one line" }),
			check: Type.Optional(Type.String({ description: "A read-only command that exits 0 once it is done, e.g. git ls-remote --exit-code --tags origin <tag>. It runs once at once, then every few minutes" })),
			step: Type.Optional(Type.String({ description: "The plan's Wait step, e.g. S7" })),
			kind: Type.Optional(Type.Union([Type.Literal("approve"), Type.Literal("act"), Type.Literal("verify"), Type.Literal("external")], { description: "approve: a person only reviews and agrees; act (default): a person must do something; verify: a person must test or look at the result; nothing waits, it is listed for them after the flow; external: nothing for a person; another package's PR, CI or a release; the check resumes it; needs a check" })),
			manual: Type.Optional(Type.Boolean({ description: "Pause even when autopilot is on" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			const plan = fl.state.approvedPlan;
			if (fl.state.phase !== "execute" || !plan) return reply("wait_for_user works only while executing an approved plan. Nothing changed.");
			const reason = params.reason.trim();
			if (!reason) return reply("Give a reason: what the person must do. Nothing changed.");
			if (params.kind === "verify") {
				const vstep = params.step?.trim().toUpperCase() || undefined;
				if (!(vstep && parseVerifyStep(plan, vstep))) {
					fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${verifyAmendment(nextAmendmentNumber(fl), { steps: reason, step: vstep })}\n`;
					const item = vstep ? fl.state.checklist?.find((i) => i.id === vstep) : undefined;
					if (item && !isHuman(item)) item.done = true;
					refreshChecklist();
				}
				persist();
				updateStatus(ctx);
				planMilestone(ctx);
				return reply(`Recorded as a human check for after the flow: ${reason}. Don't wait; continue in this turn.`);
			}
			const check = cleanCheck(params.check);
			const kindProblem = waitKindProblem(params.kind, check);
			if (kindProblem) return reply(`${kindProblem}. Nothing changed.`);
			if (check) {
				const shape = waitCheckProblem(check);
				if (shape) return reply(`The check ${shape}. Nothing changed.`);
				const problem = readOnlyProblem(check);
				if (problem) return reply(`The check must be read-only (${problem}). Nothing changed.`);
			}
			if (check) {
				const first = await runWaitCheck(check);
				if (first.status === "pass") return reply(`The check passes already: "${reason}" is done. Tick the step with plan_check and continue in this turn. Nothing to wait for.`);
				if (first.status === "broken") return reply(`The check can't run (${first.detail}). Fix the check (it runs in bash from ${ctx.cwd}) and call wait_for_user again. Nothing changed.`);
			}
			const step = params.step?.trim().toUpperCase() || undefined;
			const planned = !!step && !!parseWaitStep(plan, step);
			if (autopilotSkipsWait(autopilotOn(), params.manual, params.kind)) {
				const kind = params.kind === "approve" ? "approve" : "act";
				noteAuto(`wait skipped: ${reason}`);
				fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${autopilotAmendment(nextAmendmentNumber(fl), { reason, step, kind })}\n`;
				refreshChecklist();
				persist();
				planMilestone(ctx);
				return reply(autopilotReply(kind, reason, check));
			}
			if (!planned) {
				fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${waitAmendment(nextAmendmentNumber(fl), { reason, step, check })}\n`;
				refreshChecklist();
			}
			setWaiting({ reason, ...(check ? { check } : {}), ...(params.kind === "external" ? { waitKind: "external" as const } : {}), ...(step ? { step } : {}), stage: fl.state.stage, since: new Date().toISOString(), planned });
			persist();
			updateStatus(ctx);
			planMilestone(ctx);
			startWaitTimer();
			return reply(`Waiting for: ${reason}. End your turn now; the workflow resumes you when ${check ? "the check passes" : "the user replies"}.`);
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "wait_for_user", "execute")}${theme.fg("accent", ` ${String(args.reason ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	/** Runs `node scripts/<script> <args>` in a repo with stdin closed; resolves with the exit code and the output. */
	function runNodeScript(root: string, script: string, args: string[], timeoutMs = 30 * 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
		return new Promise((resolve) => {
			const child = spawn("node", [path.join(root, "scripts", script), ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => child.kill(), timeoutMs);
			child.stdout.on("data", (d) => (stdout += d));
			child.stderr.on("data", (d) => (stderr += d));
			child.on("error", (e) => {
				clearTimeout(timer);
				resolve({ code: 1, stdout, stderr: `${stderr}${e.message}` });
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ code: code ?? 1, stdout, stderr });
			});
		});
	}

	const lastLines = (text: string, n = 40) => text.trim().split(/\r?\n/).slice(-n).join("\n");

	/** The clone's publish lock file (shared by every session and worktree of the clone). */
	async function publishLockFile(root: string): Promise<string> {
		const common = (await git(fl, root, "rev-parse", "--git-common-dir")).stdout.trim() || ".git";
		return path.resolve(root, common, "iec-publish.lock");
	}

	/** Takes the clone's publish lock: a release function, or "held" while another session publishes. */
	async function takePublishLock(file: string): Promise<{ release: () => void } | "held"> {
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				fs.writeFileSync(file, JSON.stringify({ session: fl.state.planDoc?.flowId ?? "session", pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
				return { release: () => fs.rmSync(file, { force: true }) };
			} catch {
				let lock: { pid: number; startedAt: string } | null = null;
				try {
					lock = JSON.parse(fs.readFileSync(file, "utf8"));
				} catch {
					// A half-written file is a lock being taken: judge it by its age.
					try {
						lock = { pid: 0, startedAt: fs.statSync(file).mtime.toISOString() };
					} catch {
						lock = null;
					}
				}
				if (lockDecision(lock, Date.now(), pidAlive) === "held") return "held";
				fs.rmSync(file, { force: true });
			}
		}
		return "held";
	}

	pi.registerTool({
		name: "publish_packages",
		label: "Publish packages",
		description:
			"Run a plan's `Publish:` or `Mirror:` step: publishes the unity-packages versions this flow merged (with the person's registry token, on this computer) or mirrors vendor packages. Pass the plan step ID. If an earlier version or a pinned package is not published yet, the flow waits and resumes by itself; then call this again with the same step. Never run updates.bat, update-packages.mjs publish, maintenance.mjs mirror --confirm, publish-package.mjs or npm publish yourself.",
		promptSnippet: "publish_packages: run the plan's Publish:/Mirror: step S<n>",
		parameters: Type.Object({ step: Type.String({ description: "The plan's Publish: or Mirror: step, e.g. S9" }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string): ToolReply => ({ content: [{ type: "text" as const, text }], details: {} });
			const plan = fl.state.approvedPlan;
			if (fl.state.phase !== "execute" || !plan) return reply("publish_packages works only while executing an approved plan. Nothing published.");
			const step = params.step.trim().toUpperCase();
			const pub = parsePublishStep(plan, step);
			const mir = pub ? null : parseMirrorStep(plan, step);
			if (!pub && !mir) return reply(`Step ${step} is not a \`Publish: <package>\` or \`Mirror: <folder>|all\` step of the approved plan (packages only, no versions). Nothing published.`);
			if (fl.state.checklist?.find((i) => i.id === step)?.done) return reply(`Step ${step} is already ticked. Nothing published.`);
			const repo = (await flowRepos(fl, ctx)).find((r) => fs.existsSync(path.join(r.root, "scripts", "update-packages.mjs")));
			if (!repo) return reply("No repo of this flow has scripts/update-packages.mjs (add the unity-packages folder to the flow). Nothing published.");
			const root = repo.root;
			const wait = (why: string, check: string): ToolReply => {
				const since = waitSince(fl.wait.publishWaitSince.get(step), new Date().toISOString());
				fl.wait.publishWaitSince.set(step, since);
				setWaiting({ reason: why, check, step, stage: fl.state.stage, since, planned: true, held: `Call publish_packages again with step ${step}.` });
				persist();
				updateStatus(ctx);
				planMilestone(ctx);
				startWaitTimer(Date.parse(since));
				return reply(`Waiting: ${why}. End your turn now; the workflow resumes you when the check passes. Then call publish_packages again with step ${step}.`);
			};
			const lockFile = await publishLockFile(root);
			const lock = await takePublishLock(lockFile);
			if (lock === "held") return wait("another session is publishing", lockWaitCheck(lockFile));
			try {
				if (mir) {
					const r = await runNodeScript(root, "maintenance.mjs", mirrorArgs(mir));
					if (r.code === 0) fl.wait.publishWaitSince.delete(step);
					return reply(`mirror ${mir.target} exit ${r.code}:\n${lastLines(`${r.stdout}\n${r.stderr}`)}\n${r.code === 0 ? `Tick ${step} with plan_check.` : "Nothing more was done; report the failure."}`);
				}
				return await runPublish(root, step, pub!.packages, reply, wait);
			} finally {
				lock.release();
			}
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "publish_packages", "execute")}${theme.fg("accent", ` ${String(args.step ?? "")}`)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "git_task",
		label: "Git task",
		description:
			"Delegate messy git work (merge conflicts, rebases, a long sequence of split commits) to a cheaper model and get its report back in the same turn. Plain commits, pushes and pull requests are faster in bash with git and gh. It runs under the same guard as you: a merge or a push to a protected branch is refused until the exact tree has passed judge in a flow; in normal mode (no flow) there is no judge gate. Give the exact task (repo, branch, commit messages, base). If it fails, do the work yourself.",
		promptSnippet: "git_task: delegate messy git work (conflicts, rebases, long split-commit sequences) to a cheap model; plain commit/push/PR go through bash",
		parameters: Type.Object({
			task: Type.String({ description: "What to do, e.g. 'commit the staged changes as \"feat: x\", push the branch, open a PR against main'" }),
			repo: Type.Optional(Type.String({ description: "Folder of the repo to work in; default the working folder" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const reply = (text: string, details: object = {}) => ({ content: [{ type: "text" as const, text }], details });
			const allowed = gitTaskAllowed(fl.state.phase, !!fl.state.approvedPlan);
			if (!allowed.ok) return reply("git_task works only in normal mode or while executing an approved plan. Nothing changed.");
			if (!fs.existsSync(GIT_GUARD_EXTENSION)) return reply(`git_task failed: git guard extension not found at ${GIT_GUARD_EXTENSION}`);
			const repos = await flowRepos(fl, ctx);
			const cwd = params.repo ? path.resolve(ctx.cwd, params.repo) : ctx.cwd;
			if (!fs.existsSync(cwd)) return reply(`git_task failed: ${cwd} does not exist.`);
			const multi = (fl.state.folders?.length ?? 0) > 0 || (fl.state.touchedRepos?.length ?? 0) > 0;
			const spec: GitGuardSpec = {
				roots: multi ? repos.map((r) => r.root) : [],
				protectedBranches: fl.cfg.protectedBranches,
				passedTrees: fl.state.passedTrees ?? {},
				noMerge: noMerge(fl.state.approvedPlan ?? ""),
				...(allowed.ungated ? { ungated: true } : (() => { const mf = midFlowMergeRefusal(); return mf ? { midFlow: mf } : {}; })()),
			};
			const task = [
				params.task.trim(),
				"",
				"Rules:",
				`- Work only in ${multi ? repos.map((r) => r.root).join(", ") : cwd}.`,
				"- Never force-push, use --no-verify, --admin or --auto.",
				"- Chain dependent steps with &&.",
				"- Stop at the first failure and report the command and its error.",
				"- Report each commit subject, branch and pull request URL.",
			].join("\n");
			const repoList = repos.length ? repos : [{ root: cwd, dir: cwd, changed: false }];
			// A merge with --delete-branch leaves the checkout on the default branch, so the branch is read first.
			const branchBefore = new Map<string, string>();
			const headBefore = new Map<string, string>();
			const remoteBefore = new Map<string, boolean>();
			for (const r of repoList) {
				branchBefore.set(r.root, (await git(fl, r.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim());
				headBefore.set(r.root, (await git(fl, r.dir, "rev-parse", "HEAD")).stdout.trim());
				remoteBefore.set(r.root, !!(await git(fl, r.dir, "branch", "-r", "--contains", "HEAD")).stdout.trim());
			}
			const progress = toolProgress(onUpdate);
			const prevStage = fl.view.stage;
			fl.view.stage = "commit";
			let text: string;
			try {
				ctx.ui.setWorkingMessage("git_task running…");
				const ran = await runRole(fl,
					"commit",
					"git task",
					{ systemPrompts: [prompts.COMMIT], tools: ["bash", "read"], task, cwd, signal, env: { [GIT_GUARD_ENV]: JSON.stringify(spec) }, extensions: [GIT_GUARD_EXTENSION] },
					progress.track,
				);
				if (ran.result.ok) fl.view.finish(ran.run, true, "report ready");
				text = ran.result.ok ? ran.result.text : `git_task failed: ${ran.result.error}`;
			} catch (e) {
				text = `git_task failed: ${e instanceof Error ? e.message : String(e)}`;
			} finally {
				fl.view.stage = prevStage;
				ctx.ui.setWorkingMessage();
			}
			const lines: string[] = [];
			for (const r of repoList) {
				const key = repoKey(r.root);
				const branch = (await git(fl, r.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
				const base = fl.state.reviewBase?.[key];
				const n = base ? (await git(fl, r.dir, "rev-list", "--count", `${base}..HEAD`)).stdout.trim() : "?";
				const rec = await recordJudged(defaultRunner, r.dir, { startBranch: branchBefore.get(r.root) ?? "", headBefore: headBefore.get(r.root), remoteBefore: remoteBefore.get(r.root), report: text, passed: fl.state.passedTrees?.[key] ?? [], protectedBranches: fl.cfg.protectedBranches });
				const pr = rec.pr;
				const existing = fl.state.judgedMerges?.[key];
				if (rec.entry && !(rec.entry.commit && existing?.pr && existing.stage === fl.state.stage)) {
					fl.state.judgedMerges = { ...(fl.state.judgedMerges ?? {}), [key]: { ...rec.entry, ...(fl.state.stage ? { stage: fl.state.stage } : {}) } };
					persist();
				}
				lines.push(`${path.basename(r.root)}: branch ${branch}, ${n} commits since review base, ${pr}`);
			}
			return reply(`${text}\n\n${lines.join("\n")}`, { runs: progress.snapshot() });
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "git_task", "commit")}${theme.fg("accent", ` ${String(args.task ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	/** The commit a judged merge landed in this repo (a merged pull request's merge commit, or a pushed commit that origin has), or the reason there is none. */
	async function judgedMergeHead(root: string): Promise<{ head: string } | { error: string }> {
		const jm = fl.state.judgedMerges?.[repoKey(root)];
		if (!jm) return { error: NO_JUDGED_MERGE };
		await git(fl, root, "fetch", "--quiet", "origin");
		if (jm.pr) {
			const slug = await originRepo(defaultRunner, root);
			const view = await defaultRunner("gh", ["pr", "view", jm.pr, ...(slug ? ["-R", slug] : []), "--json", "state,mergeCommit"], root);
			if (view.code !== 0) return { error: `Cannot read pull request ${jm.pr} (${view.stderr.trim().split(/\r?\n/)[0] || "gh failed"}). Nothing published.` };
			try {
				const j = JSON.parse(view.stdout) as { state?: unknown; mergeCommit?: { oid?: unknown } | null };
				if (j.state !== "MERGED") return { error: `Pull request ${jm.pr} is ${String(j.state)}, not MERGED: merge the judged pull request first. Nothing published.` };
				const oid = typeof j.mergeCommit?.oid === "string" ? j.mergeCommit.oid : "";
				if (!oid) return { error: `Pull request ${jm.pr} has no merge commit to read. Nothing published.` };
				return { head: oid };
			} catch {
				return { error: `Cannot read pull request ${jm.pr} (gh printed no JSON). Nothing published.` };
			}
		}
		if (jm.commit) {
			const onRemote = await git(fl, root, "branch", "-r", "--contains", jm.commit);
			if (onRemote.code !== 0 || !onRemote.stdout.trim()) return { error: `The judged commit ${jm.commit.slice(0, 9)} is not on origin yet: push it first. Nothing published.` };
			return { head: jm.commit };
		}
		return { error: NO_JUDGED_MERGE };
	}

	/** The versions the merged head holds for these packages, or the reason it can't be read. */
	async function readMergedItems(root: string, head: string, packages: string[]): Promise<{ items: { name: string; version: string }[] } | { error: string }> {
		const items: { name: string; version: string }[] = [];
		for (const name of packages) {
			const show = await git(fl, root, "show", `${head}:${name}/package.json`);
			let version = "";
			try {
				version = String(JSON.parse(show.stdout).version ?? "");
			} catch {
				version = "";
			}
			if (show.code !== 0 || !version) return { error: `${name} has no package.json at the merged head ${head.slice(0, 8)}. Nothing published.` };
			items.push({ name, version });
		}
		return { items };
	}

	/** The script's dry run for these versions: its JSON, or the reason it failed. */
	async function dryRunPublish(root: string, items: { name: string; version: string }[]) {
		const dry = await runNodeScript(root, "update-packages.mjs", publishArgs(items, true));
		let result: { items?: { name: string; version: string }[]; blockedBy?: { tag: string }[]; notCandidates?: string[]; error?: string } | undefined;
		try {
			result = JSON.parse(dry.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "");
		} catch {
			result = undefined;
		}
		if (dry.code !== 0 || !result || result.error) return { error: `exit ${dry.code}${result?.error ? ` (${result.error})` : ""}:\n${lastLines(`${dry.stderr}\n${dry.stdout}`, 20)}` };
		return { result };
	}

	/** The tags (name/vversion) of these versions that origin has. */
	async function taggedOnOrigin(root: string, items: { name: string; version: string }[]): Promise<Set<string>> {
		const tagged = new Set<string>();
		for (const i of items) {
			const remote = await git(fl, root, "ls-remote", "--tags", "origin", `${i.name}/v${i.version}`);
			if (remote.code === 0 && remote.stdout.trim()) tagged.add(`${i.name}/v${i.version}`);
		}
		return tagged;
	}

	/** The Publish step: versions come from the head this flow merged; the script's dry run decides what is published, already on the registry or not publishable; blockers start a wait. */
	async function runPublish(root: string, step: string, packages: string[], reply: (t: string) => ToolReply, wait: (why: string, check: string) => ToolReply): Promise<ToolReply> {
		if (noMerge(fl.state.approvedPlan ?? "")) return reply("this plan says Delivery: no merge; publishing is not allowed. Nothing published.");
		const merged = await judgedMergeHead(root);
		if ("error" in merged) return reply(merged.error);
		const read = await readMergedItems(root, merged.head, packages);
		if ("error" in read) return reply(read.error);
		const names = (list: { name: string; version: string }[]) => list.map((i) => `${i.name}@${i.version}`).join(", ");
		const dry = await dryRunPublish(root, read.items);
		if ("error" in dry) return reply(`Checking ${names(read.items)} failed (${dry.error})\nNothing published.`);
		const split = classifyPublish(read.items, dry.result, await taggedOnOrigin(root, read.items));
		if (split.notPublishable.length) return reply(`${split.notPublishable.join(", ")}: superseded or not on origin/main; nothing published. Stop and explain to the user.`);
		if (!split.publish.length) {
			fl.wait.publishWaitSince.delete(step);
			return reply(`${names(read.items)} already on the registry. Tick ${step} with plan_check.`);
		}
		if (dry.result.blockedBy?.length) return wait(`waiting for ${dry.result.blockedBy.map((b) => b.tag).join(", ")} to be published`, blockedWaitCheck(root, split.publish));
		const run = await runNodeScript(root, "update-packages.mjs", publishArgs(split.publish, false));
		if (run.code === 0) fl.wait.publishWaitSince.delete(step);
		const skipped = split.alreadyPublished.length ? `Skipped, the registry already has: ${names(split.alreadyPublished)}.\n` : "";
		const next = run.code === 0 ? `Tick ${step} with plan_check.` : run.code === 3 ? "Blocked meanwhile; call publish_packages again." : "Nothing more was done; report the failure.";
		return reply(`${skipped}publish ${names(split.publish)} exit ${run.code}:\n${lastLines(`${run.stdout}\n${run.stderr}`)}\n${next}`);
	}

	pi.registerTool({
		name: "plan_check",
		label: "Plan check",
		description: "Tick the plan's steps you finished (their IDs, e.g. S3), or untick ones with `undone`. Keeps the checklist in step with your work; the judge still checks the diff.",
		promptSnippet: "plan_check: tick finished plan steps by ID (S1, S2, ...)",
		parameters: Type.Object({
			done: Type.Array(Type.String({ description: "Step ID, e.g. S3" }), { description: "Steps you finished" }),
			undone: Type.Optional(Type.Array(Type.String({ description: "Step ID, e.g. S3" }), { description: "Steps to untick again" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const list = fl.state.checklist;
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (fl.state.phase !== "execute" || !list?.length) return reply("No plan checklist is active (it exists only while executing a plan whose steps are numbered S1, S2, ...). Nothing changed.");
			const norm = (ids: string[] | undefined) => (ids ?? []).map((s) => s.trim().toUpperCase());
			const unknown: string[] = [];
			for (const [ids, value] of [[norm(params.done), true], [norm(params.undone), false]] as const) {
				for (const id of ids) {
					const item = list.find((i) => i.id === id);
					if (item) item.done = value;
					else unknown.push(id);
				}
			}
			persist();
			updateStatus(ctx);
			rewritePlanFile();
			const staged = currentStages();
			const open = list.filter((i) => !isHuman(i) && !i.done && (!staged || i.stage === undefined || i.stage === staged.current));
			const done = list.filter((i) => !isHuman(i) && i.done).length;
			const head = `${done} of ${list.filter((i) => !isHuman(i)).length} steps done${unknown.length ? `; unknown IDs: ${unknown.join(", ")}` : ""}.`;
			const rest = open.length ? `Open${staged ? ` in stage ${staged.current}` : ""}:\n${open.map((i) => `- ${i.id} ${i.text}${deliverLine(i.id, staged?.current)}`).join("\n")}` : `No open steps${staged ? " in this stage" : ""}.`;
			return reply(`${head}\n${rest}`);
		},
		renderCall(args, theme) {
			const ids = [...((args.done ?? []) as string[]), ...((args.undone ?? []) as string[]).map((s) => `-${s}`)];
			return new Text(`${title(theme, "plan_check", "execute")}${theme.fg("accent", ` ${ids.join(", ")}`)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "request_merge",
		label: "Request merge",
		description:
			"Ask to merge the pull request before the end of the flow, only when a later step cannot run until the change is on the default branch. An arbiter decides; when it cannot, the user is asked. A merge that is not planned (a `Deliver: merge` step) or approved this way is refused by the merge gate.",
		promptSnippet: "request_merge: ask to merge before the end of the flow (arbiter, then the user)",
		parameters: Type.Object({
			reason: Type.String({ description: "Which later step needs the change on the default branch, and why" }),
			repos: Type.Optional(Type.Array(Type.String(), { description: "The repos concerned, by folder" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (fl.state.phase !== "execute") return reply("request_merge works only while a plan executes. Nothing changed.");
			if (noMerge(fl.state.approvedPlan ?? "")) return reply("No merge: this plan says Delivery: no merge.");
			const reason = String(params.reason ?? "").replace(/\s+/g, " ").trim();
			if (!reason) return reply("Give the reason: which later step needs the change merged now.");
			const allowedText = (why: string) => `Merge allowed: ${why}. Run judge if the tree changed since the last pass, merge with gh pr merge as its own command, then continue on a new branch from the updated default branch.`;
			const refusedText = (why: string) => `No merge: ${why}. Keep committing and pushing to the branch and continue the plan.`;
			if (midFlowMergeRefusal() === null) return reply(allowedText("the gate already allows a merge here (the end of the flow, a planned Deliver: merge step or an earlier approval)"));
			const staged = currentStages();
			const stage = staged?.current ?? 0;
			const mine = mergeDecisions(fl.state.approvedPlan).filter((d) => d.stage === 0 || d.stage === stage);
			const userNo = mine.find((d) => !d.allowed && d.by === "user");
			if (userNo) return reply(refusedText(`the user refused a merge here: ${userNo.reason}`));
			const arbiterNo = mine.some((d) => !d.allowed && d.by === "arbiter");
			let decided: ReturnType<typeof parseMergeArbiter> = null;
			if (!arbiterNo) {
				ctx.ui.setWorkingMessage("arbiter checking the merge request…");
				try {
					const repoLines: string[] = [];
					for (const r of await flowRepos(fl, ctx)) {
						const status = (await git(fl, r.dir, "status", "--short")).stdout.trim();
						const log = (await git(fl, r.dir, "log", "--oneline", "-20")).stdout.trim();
						repoLines.push(`### ${r.root}\n${status || "(clean)"}\n${log}`);
					}
					const openIds = gateOpenSteps(fl.state.approvedPlan ?? "", fl.state.checklist, staged ? { current: staged.current, total: staged.stages.length } : undefined);
					const open = (fl.state.checklist ?? []).filter((i) => openIds.includes(i.id));
					const position = staged ? `Stage ${staged.current} of ${staged.stages.length}: ${staged.stages[staged.current - 1].title}` : "No stages";
					const { result, run } = await runRole(fl, "arbiter", "merge", {
						systemPrompts: [
							prompts.MERGE_ARBITER,
							`## Approved plan\n\n${planForJudge(fl)}`,
							`## Position\n\n${position}\nOpen steps: ${open.map((i) => `${i.id} ${i.text}`).join("; ") || "none"}`,
							`## Repos\n\n${repoLines.join("\n\n") || "(none)"}`,
							`## Executor's reason\n\n${reason}`,
						],
						tools: fl.cfg.arbiter.tools,
						task: "Decide on the merge request in your system prompt.",
						cwd: ctx.cwd,
					});
					if (!result.ok) ctx.ui.notify(`workflow: merge arbiter failed: ${result.error}`, "error");
					else {
						decided = parseMergeArbiter(result.text);
						fl.view.finish(run, true, decided?.decision ?? "no decision");
					}
				} catch (e) {
					ctx.ui.notify(`workflow: merge arbiter failed: ${String(e)}`, "error");
				} finally {
					ctx.ui.setWorkingMessage();
				}
			}
			if (decided && decided.decision !== "ASK_USER") {
				const allowed = decided.decision === "MERGE";
				const why = decided.reason || reason;
				recordMergeDecision(ctx, "arbiter", allowed, why);
				return reply(allowed ? allowedText(why) : refusedText(why));
			}
			if (!ctx.hasUI) return reply("No merge: nobody to ask. Continue without merging; the pull request is merged at the end of the flow.");
			const seen = decided ? decided.reason : arbiterNo ? "The arbiter already refused a merge in this stage." : "The arbiter gave no decision.";
			pi.sendMessage({ customType: "workflow-judge", content: `**Merge request before the end of the flow**\n\nThe executor's reason: ${reason}\n\nThe arbiter's view: ${seen || "it hands the decision to you"}`, display: true }, { triggerTurn: false });
			let answer: string | undefined;
			try {
				answer = await askUser(fl, ctx, `Merge before the end of the flow? ${reason}`, ["Allow the merge", "Don't merge"]);
			} catch {}
			const allowed = answer === "Allow the merge";
			recordMergeDecision(ctx, "user", allowed, reason);
			return reply(allowed ? allowedText(`you allowed it: ${reason}`) : refusedText("the user did not allow it"));
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "request_merge", "execute")}${theme.fg("accent", ` ${String(args.reason ?? "").slice(0, 80)}`)}`, 0, 0);
		},
	});

	// The judge tool is the agents extension's; while a flow is on the workflow takes its calls over with
	// its own review (review base, rounds, gates). Errors the review throws reject the claim.
	pi.events.on("agents:judge-call", (payload) =>
		claimJudgeCall(fl.state.phase, payload, async (params: JudgeParams, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) => {
			const baseNote = params.base ? undefined : await refreshReviewBase(fl, ctx);
			const diff = await collectFlowDiff(fl, ctx, params.base || undefined);
			if (!diff) throw new Error("no git work tree in this flow (working folder, /folders, or repos edited this flow); the judge reviews git diffs");
			if (fl.state.phase === "execute" && currentStages()) {
				fl.state.stageJudged = true;
				persist();
			}
			if (!diff.text) return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
			const progress = toolProgress(onUpdate);
			const r = await judge(fl, ctx, diff, [params.focus, baseNote].filter(Boolean).join("\n") || undefined, signal, progress.track, params.full === true, params.disputes);
			if (r.verdict === "ERROR") throw new Error(r.text);
			if (r.verdict === "FAIL") fl.state.judgeRounds++;
			let text = r.text;
			const flawed = planFlaws(r.findings).length > 0;
			if (r.verdict === "PASS" && fl.state.phase === "execute" && !flawed && !noMerge(fl.state.approvedPlan ?? "") && (await flowHasRemote(ctx))) {
				text += mergeDue()
					? "\n\nTick any finished steps not ticked yet with plan_check. Now deliver this exact tree: commit, push, open or update the pull request and merge it with gh pr merge (as its own command), then end your turn."
					: "\n\nNow commit and push this exact tree to the flow branch (no merge: the pull request is merged at the end of the flow), tick any finished steps not ticked yet with plan_check, then end your turn.";
			}
			if (r.verdict === "PASS") {
				const knowledge = fl.state.lastKnowledge?.hash === diff.hash ? fl.state.lastKnowledge : undefined;
				const block = knowledge ? deviationBlock(knowledge.deviations) : "";
				if (block) text += `\n\nEnd the pull request body (or the last commit message if there is no pull request) with this block, unchanged:\n\n${block}`;
				if (fl.state.lateFindings?.length) text += `\n\nAdd a "Late findings (not fixed)" section to the pull request body (or the last commit message) listing:\n${fl.state.lateFindings.map((l) => `- ${l}`).join("\n")}`;
			}
			const reminder = fl.state.phase === "execute" ? openStepsReminder(fl.state.checklist, currentStages()?.current) : undefined;
			if (reminder) text += `\n\n${reminder}${fl.state.phase === "execute" ? deliverHintsText(currentStages()?.current) : ""}`;
			// Every call replaces the pending report, so a stale one never outlives a clean review.
			fl.state.pendingPlanFlaw = flawed ? r.text : undefined;
			if (fl.state.pendingPlanFlaw) {
				text += "\n\nThis review questions the plan. Do not change the plan's design yourself: end your turn now; the workflow resolves it.";
			}
			persist();
			return { content: [{ type: "text", text }], details: { runs: progress.snapshot(), verdict: r.verdict }, usage: r.usage };
		}),
	);

	/** The tag part of `deliver`: creates or moves a tag on the remote default branch, safely. A wait is returned for the caller to set. */
	async function deliverTag(ctx: ExtensionContext, t: { name: string; commit?: string; move: boolean; repo?: string }, planned: boolean): Promise<{ text: string; ok: boolean; wait?: string }> {
		const fail = (text: string) => ({ text: `tag ${t.name}: ${text}`, ok: false });
		const refs = await flowRepos(fl, ctx);
		const want = t.repo?.trim();
		const ref = want ? refs.find((r) => r.root === want || path.basename(r.root) === want || repoKey(r.root) === repoKey(want)) : undefined;
		if (want && !ref) return fail(`no repo of this flow matches "${want}"`);
		const dir = ref?.dir ?? ctx.cwd;
		const remotes = (await git(fl, dir, "remote")).stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		const remote = remotes.includes("origin") ? "origin" : remotes[0];
		if (!remote) return fail("the repo has no remote");
		const sym = await git(fl, dir, "ls-remote", "--symref", remote, "HEAD");
		const head = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(sym.stdout);
		if (sym.code !== 0 || !head) return fail(`cannot read the default branch of ${remote}`);
		const branch = head[1];
		const fetched = await git(fl, dir, "fetch", remote, branch);
		if (fetched.code !== 0) return fail(`cannot fetch ${remote} ${branch}`);
		const remoteRef = `${remote}/${branch}`;
		const resolved = await git(fl, dir, "rev-parse", "--verify", "--quiet", `${t.commit?.trim() || remoteRef}^{commit}`);
		const target = resolved.stdout.trim();
		if (resolved.code !== 0 || !target) return fail(`cannot resolve ${t.commit?.trim() || remoteRef}`);
		const onDefault = (await git(fl, dir, "merge-base", "--is-ancestor", target, remoteRef)).code === 0;

		const listed = await git(fl, dir, "ls-remote", "--tags", remote, `refs/tags/${t.name}`, `refs/tags/${t.name}^{}`);
		if (listed.code !== 0) return fail(`cannot read the tags of ${remote}`);
		let tagObject: string | undefined;
		let peeled: string | undefined;
		for (const line of listed.stdout.split(/\r?\n/)) {
			const [sha, ref2] = line.trim().split(/\s+/);
			if (ref2 === `refs/tags/${t.name}`) tagObject = sha;
			else if (ref2 === `refs/tags/${t.name}^{}`) peeled = sha;
		}
		const remoteSha = peeled ?? tagObject;
		let oldIsAncestor: boolean | undefined;
		if (remoteSha && t.move) {
			if ((await git(fl, dir, "cat-file", "-e", `${remoteSha}^{commit}`)).code !== 0) {
				// A tag ref is always fetchable; a raw SHA only where the server allows it.
				const viaRef = await git(fl, dir, "fetch", remote, `+refs/tags/${t.name}:refs/tmp-deliver/${t.name}`);
				if (viaRef.code !== 0) await git(fl, dir, "fetch", remote, remoteSha);
				await git(fl, dir, "update-ref", "-d", `refs/tmp-deliver/${t.name}`);
			}
			oldIsAncestor = (await git(fl, dir, "merge-base", "--is-ancestor", remoteSha, target)).code === 0;
		}
		const d = tagDecision({ name: t.name, planned, move: t.move, remoteSha, target, onDefault, oldIsAncestor });
		if (d.action === "refuse") return { text: `tag ${t.name}: ${d.text}`, ok: d.ok === true };
		if (d.action === "wait") return { text: `tag ${t.name}: ${d.reason}`, ok: false, wait: d.reason };
		const lease = d.action === "move" ? (tagObject ?? d.lease) : undefined;
		const pushed = await pi.exec("git", ["-C", dir, ...pushArgs(remote, t.name, target, lease)], { timeout: 120_000 });
		if (pushed.code !== 0) {
			const why = `tag ${t.name} was not pushed: ${(pushed.stderr || pushed.stdout).split(/\r?\n/).find((l) => l.trim())?.trim() ?? "git push failed"}`;
			return { text: why, ok: false, wait: why };
		}
		const synced = await git(fl, dir, "fetch", remote, `+refs/tags/${t.name}:refs/tags/${t.name}`);
		const note = synced.code === 0 ? "" : " (the local tag was not updated)";
		return { text: d.action === "move" ? `moved ${t.name} from ${(remoteSha as string).slice(0, 9)} to ${target.slice(0, 9)}${note}` : `tag ${t.name} created at ${target.slice(0, 9)}${note}`, ok: true };
	}

	pi.registerTool({
		name: "deliver",
		label: "Deliver",
		description:
			"Create or move a tag on the remote default branch (`tag`), inside the plan, then carry on in the same turn. Commit, push, pull requests and merges are done with git and gh directly, not with this tool. Name the plan's `Deliver:` step as `step`; a call without one is added to the plan as an amendment. Tags are created or moved only for a named plan step or when you need them to continue; a move needs a plan step that names the tag and the word move.",
		promptSnippet: "deliver: create or move a tag inside the plan, then continue",
		parameters: Type.Object({
			tag: Type.Optional(
				Type.Object({
					name: Type.String({ description: "Tag name, e.g. unity-build/v1.0.8" }),
					commit: Type.Optional(Type.String({ description: "Commit to tag. Default: the tip of the remote default branch" })),
					move: Type.Optional(Type.Boolean({ description: "Move an existing tag forward (needs a plan step that names it)" })),
					repo: Type.Optional(Type.String({ description: "Repo root or folder name. Default: the working folder's repo" })),
				}),
			),
			step: Type.Optional(Type.String({ description: "The plan's Deliver step, e.g. S4" })),
			reason: Type.Optional(Type.String({ description: "Why, for an unplanned checkpoint (goes into the plan's amendment)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string, details?: unknown) => ({ content: [{ type: "text" as const, text }], details });
			const plan = fl.state.approvedPlan;
			if (fl.state.phase !== "execute" || !plan) return reply("deliver works only while executing an approved plan. Nothing changed.");
			const tag = params.tag && params.tag.name?.trim() ? { ...params.tag, name: params.tag.name.trim(), move: params.tag.move === true } : undefined;
			if (!tag) return reply("Give a tag: deliver only creates or moves tags. Commit, push, pull requests and merges are done with git and gh. Nothing changed.");

			const step = params.step?.trim().toUpperCase() || undefined;
			const stepText = step ? parseDeliverStep(plan, step) : null;
			const planned = stepText !== null;
			if (!planned) {
				const reason = params.reason?.trim() || "needed to continue";
				const amend = { tag: tag.name, reason };
				if (!hasCheckpointAmendment(plan, amend)) {
					fl.state.approvedPlan = `${plan.replace(/\s+$/, "")}\n\n${checkpointAmendment(nextAmendmentNumber(fl), amend)}\n`;
					refreshChecklist();
					planMilestone(ctx);
					persist();
				}
			}

			const t = await deliverTag(ctx, tag, isPlannedTag(stepText, tag.name, tag.move));
			if (t.wait) {
				setWaiting({ reason: t.wait, ...(planned && step ? { step } : {}), stage: fl.state.stage, since: new Date().toISOString(), planned });
			}
			fl.state.checkpoints = [...(fl.state.checkpoints ?? []), { ...(planned && step ? { step } : {}), stage: fl.state.stage, text: checkpointText(planned ? step : undefined, t.text), ok: t.ok }];
			persist();
			updateStatus(ctx);
			planMilestone(ctx);
			if (t.wait) return reply(`${t.text}\n\nWaiting for: ${t.wait}. End your turn now; the workflow resumes you when the user replies.`);
			const branches: string[] = [];
			for (const ref of await flowRepos(fl, ctx)) {
				const b = (await git(fl, ref.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
				if (b) branches.push(`${path.basename(ref.root)}: ${b}`);
			}
			return reply(`${t.text}${branches.length ? `\n\nCurrent branch: ${branches.join(", ")}` : ""}\n\nContinue with the next steps in this turn.`);
		},
		renderCall(args, theme) {
			return new Text(`${title(theme, "deliver", "execute")}${theme.fg("accent", args.tag?.name ? ` tag ${args.tag.name}` : "")}`, 0, 0);
		},
		renderResult: (result, opts, theme) => renderRuns(result, opts, theme, 40),
	});

	// ----------------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------------

	pi.on("turn_start", async () => {
		refilterTools();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refilterTools();
		const folders = existingFolders(fl);
		const touched = fl.state.touchedRepos ?? [];
		const opts = event.systemPromptOptions;
		const listed: { path: string; size: number }[] = [];
		if (folders.length || touched.length) {
			const have = new Set(opts.contextFiles.map((f) => repoKey(f.path)));
			for (const folder of folders) {
				try {
					for (const f of loadProjectContextFiles({ cwd: folder, agentDir: getAgentDir() })) {
						if (have.has(repoKey(f.path))) continue;
						have.add(repoKey(f.path));
						if (fl.cfg.addedFolderRules === "full") opts.contextFiles.push(f);
						else listed.push({ path: f.path, size: f.content.length });
					}
				} catch {
					// an unreadable folder just adds no context files
				}
			}
		}
		// A section deleted and re-added moves to the end in pi's patch replay, which then no longer matches the prompt
		// pi-claude-bridge saved (prompt_capture_unresolved). So both sections are always set, in this order.
		opts.sections.workspace = prompts.workspaceSection(ctx.cwd, folders, touched, listed);
		const staged = fl.state.phase === "execute" ? currentStages() : undefined;
		const publishKey = [ctx.cwd, ...existingFolders(fl), ...(fl.state.touchedRepos ?? [])].join("|");
		if (fl.publishCache?.key !== publishKey) fl.publishCache = { key: publishKey, value: (await flowRepos(fl, ctx)).some((r) => fs.existsSync(path.join(r.root, "scripts", "update-packages.mjs"))) };
		const canPublish = (fl.state.phase === "plan" || fl.state.phase === "execute") && fl.publishCache.value;
		const phaseText = prompts.phaseSection(fl.state.phase, {
			publish: canPublish,
			stage: staged ? stageLine(staged.stages, staged.current) : undefined,
			delivery: fl.state.phase === "execute" ? prompts.deliveryGuidance(fl.cfg.delivery) + (noMerge(fl.state.approvedPlan ?? "") ? "\n- This plan says Delivery: no merge: do not merge, push to a protected branch or publish; commit, push your branch and open the pull request, then stop there." : "") : undefined,
		});
		opts.sections.workflow = phaseText;
	});

	// Plan phase is read-only: the planner settles the approach, the execute model changes things.
	// Nested calls (codemode's tools.bash) pass through here too.
	pi.on("tool_call", async (event, ctx) => {
		if (fl.state.phase === "execute") {
			// Commits, pushes and pull requests are the executor's; a merge, a push to a protected branch and a publish need a judge pass on their tree; hooks are never skipped.
			const input = (event.input ?? {}) as Record<string, unknown>;
			const texts: { text: string; powershell: boolean }[] = [];
			if (/(^|__)bash$/.test(event.toolName)) texts.push({ text: String(input.command ?? ""), powershell: false });
			else if (/(^|__)run_code$/.test(event.toolName)) {
				const reason = codePublishProblem(String(input.code ?? ""));
				if (reason) return { block: true, reason: publishRefuse(reason) };
				const registry = registryPublishCodeProblem(String(input.code ?? ""));
				if (registry) return { block: true, reason: registry };
			}
			if (texts.length) {
				const registry = registryPublishProblem(texts[0].text);
				if (registry) return { block: true, reason: registry };
			}
			const gitTexts = texts.filter((t) => /\bgit\b|\bgh\b/i.test(t.text));
			if (gitTexts.length === 0) return;
			// Several repos: a command is checked against the repo it points at (git -C, cd), else the working folder's.
			const multi = (fl.state.folders?.length ?? 0) > 0 || (fl.state.touchedRepos?.length ?? 0) > 0;
			const roots = multi ? (await flowRepos(fl, ctx)).map((r) => r.root) : [];
			const branches = new Map<string, string>();
			const branchOf = async (dir: string) => {
				if (!branches.has(dir)) branches.set(dir, (await git(fl, dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim());
				return branches.get(dir) as string;
			};
			const gate = async (kind: "merge" | "protected-push", root: string | undefined, target: string | undefined, repo?: string): Promise<string | null> => {
				const dir = root ?? ctx.cwd;
				const key = repoKey(root ?? (await gitRoot(fl, ctx.cwd)) ?? ctx.cwd);
				if (kind === "merge") await ensureGh(ctx).catch(() => false);
				const early = noMerge(fl.state.approvedPlan ?? "") ? null : midFlowMergeRefusal();
				if (early) return early;
				const res = await gateCheck(defaultRunner, kind, dir, target, { passedTrees: fl.state.passedTrees?.[key] ?? [], noMerge: noMerge(fl.state.approvedPlan ?? ""), repo: repo ?? (await originRepo(defaultRunner, dir)) });
				if (res.problem) return res.problem;
				if (res.tree) {
					const stage = fl.state.stage;
					const record = kind === "merge" ? { pr: target ?? (await branchOf(dir)), tree: res.tree, ...(stage ? { stage } : {}) } : res.commit ? { commit: res.commit, tree: res.tree, ...(stage ? { stage } : {}) } : undefined;
					if (record) {
						fl.state.judgedMerges = { ...(fl.state.judgedMerges ?? {}), [key]: record };
						persist();
					}
				}
				return null;
			};
			const isTag = async (root: string | undefined, name: string) => (await git(fl, root ?? ctx.cwd, "show-ref", "--verify", "--quiet", `refs/tags/${name}`)).code === 0;
			for (const { text, powershell } of gitTexts) {
				const problem = await shellProblem(text, powershell, { roots: multi ? roots : undefined, cwd: ctx.cwd, protectedBranches: fl.cfg.protectedBranches, branchOf, gate, isTag });
				if (problem) return { block: true, reason: publishRefuse(problem) };
			}
			return;
		}
		if (fl.state.phase !== "plan" && fl.state.phase !== "discuss") return;
		const refused = phaseToolRefusal(fl.state.phase, event.toolName, planAllowedTools(), fl.cfg.planBlockedTools);
		if (refused) return { block: true, reason: planBlocked(refused) };
		if (!fl.cfg.planReadOnlyBash) return;
		if (event.toolName === "powershell") return { block: true, reason: planBlocked("PowerShell commands are not checked, so they are off while planning") };
		const problem = planToolProblem(event.toolName, (event.input ?? {}) as Record<string, unknown>, planAllow());
		if (problem) return { block: true, reason: planBlocked(problem) };
	});

	/** The valid regexes among `patterns`. */
	function regexes(patterns: string[]): RegExp[] {
		return patterns.flatMap((p) => {
			try {
				return [new RegExp(p)];
			} catch {
				return [];
			}
		});
	}

	function planAllowedTools(): RegExp[] {
		return regexes(fl.cfg.planAllowedTools);
	}
	function planAllow(): RegExp[] {
		return fl.cfg.planBashAllow.flatMap((p) => {
			try {
				return [new RegExp(p)];
			} catch {
				return [];
			}
		});
	}

	function planBlocked(problem: string): string {
		return [
			`Plan phase is read-only: ${problem}.`,
			"Do not work around this (no other tool, no script). Put the step in the plan instead: it runs after the user approves, on the execute model.",
			"Reading is fine: ls, cat, grep, find, git status/log/diff/show, gh ... view/list/checks, gh api GET, unity cmd *_status/get_*/find_*/list_*/search/console/captures/editor_play|stop|pause, video_frames.",
		].join(" ");
	}

	// A repo edited with edit/write joins the flow, so the judge and the delivery cover it.
	pi.on("tool_result", async (event, ctx) => {
		if (!/(^|__)(edit|write)$/.test(event.toolName) || event.isError) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		const raw = String(input.path ?? input.file_path ?? "").replace(/^@/, "");
		if (!raw) return;
		let dir = path.dirname(path.resolve(ctx.cwd, raw));
		while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
		const root = await gitRoot(fl, dir);
		if (!root) return;
		const known = new Set((await flowRepos(fl, ctx)).map((r) => repoKey(r.root)));
		if (known.has(repoKey(root)) || (fl.state.touchedRepos ?? []).some((t) => repoKey(t) === repoKey(root))) return;
		fl.state.touchedRepos = [...(fl.state.touchedRepos ?? []), root];
		await joinReviewBase(fl, root);
		persist();
		updateStatus(ctx);
		ctx.ui.notify(`workflow: ${root} joins this flow (edited ${raw})`, "info");
	});

	// Skills and prompts of the added folders.
	pi.on("resources_discover", async () => {
		const skillPaths: string[] = [];
		const promptPaths: string[] = [];
		for (const f of existingFolders(fl)) {
			for (const d of [path.join(f, ".pi", "skills"), path.join(f, ".agents", "skills")]) if (fs.existsSync(d)) skillPaths.push(d);
			const dir = path.join(f, ".pi", "prompts");
			if (fs.existsSync(dir)) promptPaths.push(dir);
		}
		return { skillPaths, promptPaths };
	});

	// "repeated error" decision point
	pi.on("tool_result", async (event) => {
		if (fl.state.phase !== "execute" || fl.cfg.repeatedErrorThreshold <= 0 || OWN_TOOLS.has(event.toolName)) return;
		fl.consecutiveErrors = event.isError ? fl.consecutiveErrors + 1 : 0;
		if (fl.consecutiveErrors < fl.cfg.repeatedErrorThreshold) return;
		fl.consecutiveErrors = 0;
		pi.sendMessage(
			{
				customType: "workflow-nudge",
				content: `${fl.cfg.repeatedErrorThreshold} tool calls in a row have failed. Stop retrying: call the advisor tool with situation "error" before the next attempt.`,
				display: true,
			},
			{ deliverAs: "steer" },
		);
	});

	// Context guard: compact at a fixed size on every model, whatever its window.
	// turn_end only notes the crossing: ctx.compact() aborts the running turn first,
	// so calling it mid-run killed the agent's next step ("This operation was
	// aborted"). The compaction runs in agent_settled, when nothing is left to abort;
	// pi's own auto-compaction still covers a run that nears the model's window.
	pi.on("turn_end", async (_event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		if (tokens === null || fl.cfg.contextGuardTokens <= 0) return;
		const crossed = fl.guardTokens !== null && fl.guardTokens <= fl.cfg.contextGuardTokens && tokens > fl.cfg.contextGuardTokens;
		fl.guardTokens = tokens;
		if (crossed) fl.compactPending = true;
	});

	// Live token count per stage: usage is cumulative while a message streams.
	pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) fl.view.mainUsage(countTokens(event.message.usage, fl.cfg.tokenWeights), false, event.message.model, event.message.usage);
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) fl.view.mainUsage(countTokens(event.message.usage, fl.cfg.tokenWeights), true, event.message.model, event.message.usage);
	});

	pi.registerEntryRenderer<FlowSummary>(SUMMARY_ENTRY, (entry, _opts, theme) => (entry.data ? new Text(summaryLines(entry.data, theme).join("\n"), 1, 0) : undefined));

	pi.on("agent_settled", async (event, ctx) => {
		fl.view.settleMain();
		const tracked = fl.state.phase !== "off" || fl.state.tokens !== undefined;
		if (tracked && STAGES.some((s) => fl.view.used[s].raw !== (fl.state.tokens?.[s]?.raw ?? 0) || fl.view.used[s].cost !== (fl.state.tokens?.[s]?.cost ?? 0))) persist();
		if (fl.pendingHandover) {
			const msg = fl.pendingHandover;
			fl.pendingHandover = undefined;
			deliverHandover(ctx, msg, event.aborted);
			return;
		}
		if (!fl.compactPending || fl.compacting || event.aborted || !ctx.isIdle()) return;
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		fl.compactPending = false;
		if (tokens === null || tokens <= fl.cfg.contextGuardTokens) return;
		fl.compacting = true;
		ctx.ui.notify(`workflow: context at ${Math.round(tokens / 1000)}k, compacting`, "info");
		const compactStart = Date.now();
		ctx.compact({
			onComplete: () => {
				recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "guard", tokensBefore: tokens, ms: Date.now() - compactStart, ok: true });
				fl.compacting = false;
				fl.guardTokens = null;
				if (fl.state.phase === "execute" && fl.state.approvedPlan) void planCardReady(fl).then((card) => fl.state.phase === "execute" && fl.state.approvedPlan && pi.sendMessage({ customType: "workflow-plan-card", content: card, display: true }, { triggerTurn: false }));
			},
			onError: (e) => {
				recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "guard", tokensBefore: tokens, ms: Date.now() - compactStart, ok: false, error: e.message });
				fl.compacting = false;
				ctx.ui.notify(`workflow: compaction failed: ${e.message}`, "error");
			},
		});
	});

	// Rows from the previous run stay visible a little while, then make room.
	pi.on("agent_start", async () => {
		if (fl.notify.idleTimer) clearTimeout(fl.notify.idleTimer);
		fl.notify.idleTimer = undefined;
		fl.notify.notifiedSinceStart = false;
		fl.view.clearFinished(15_000);
	});

	function approveRe(): RegExp {
		try {
			return new RegExp(fl.cfg.approvePattern, "i");
		} catch {
			return new RegExp(DEFAULTS.approvePattern, "i");
		}
	}

	// Saying "go" in plan phase approves the plan: switch to execute and send the message on as the start signal.
	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") fl.resumes = 0;
		// A typed message ends a wait (after the check, if it has one).
		const typed = event.text.trim();
		if (fl.state.phase === "execute" && fl.state.waiting && event.source !== "extension" && !event.streamingBehavior && typed && !typed.startsWith("/")) {
			const w = fl.state.waiting;
			let how: "passed" | "forced" | "plain" = w.check ? "passed" : "plain";
			// The poll timer must not end this wait while the check or the question is open.
			stopWaitTimer();
			fl.wait.waitChecking = true;
			try {
				const verdict = w.check && !w.checkPassed ? await runWaitCheck(w.check) : undefined;
				if (w.check && verdict && verdict.status !== "pass") {
					if (fl.state.waiting !== w) return { action: "continue" };
					if (!ctx.hasUI) {
						startWaitTimer();
						return { action: "handled" };
					}
					const choice = await ctx.ui.select(checkTitle(verdict, w.check), ["Continue anyway", "Keep waiting"]);
					if (fl.state.waiting !== w) return { action: "continue" };
					if (choice !== "Continue anyway") {
						ctx.ui.notify(`workflow: still waiting for "${w.reason}"`, "info");
						startWaitTimer();
						return { action: "handled" };
					}
					how = "forced";
				}
			} finally {
				fl.wait.waitChecking = false;
			}
			if (fl.state.waiting !== w) return { action: "continue" };
			return { action: "transform", text: finishWait(ctx, w, how, typed) };
		}
		// The discussion judge is running: a second "go" only shows a notice, other text cancels it.
		if (fl.state.phase === "discuss" && event.source !== "extension" && typed && !typed.startsWith("/") && fl.gateRun?.kind === "discussion") {
			if (discussionGateOnInput({ running: true, isGo: approveRe().test(typed) }) === "notice") {
				ctx.ui.notify("workflow: discussion critic running (Esc or any other message cancels it)", "info");
				return { action: "handled" };
			}
			abortGate(fl, "message");
			return { action: "continue" };
		}
		// In discuss, a typed "go" only moves to planning: it never approves or executes.
		if (fl.state.phase === "discuss" && event.source !== "extension" && !event.streamingBehavior && approveRe().test(event.text.trim())) {
			if (await startDiscussionGate(ctx)) return { action: "handled" };
			await setPhase(ctx, "plan");
			ctx.ui.notify(`workflow: planning on ${describeRole(fl.cfg.roles.plan)}`, "info");
			return { action: "transform", text: `${event.text.trim()}\n\n${prompts.PLAN_KICKOFF}` };
		}
		// The plan judge is running (or the planner is fixing its findings): "go" waits for a clean PASS, other text cancels the judge.
		if (fl.state.phase === "plan" && event.source !== "extension" && typed && !typed.startsWith("/") && (fl.gateRun?.kind === "plan" || fl.planFixing)) {
			if (approveRe().test(typed)) {
				fl.planApproveQueued = true;
				ctx.ui.notify(fl.gateRun ? `workflow: approval queued: plan critic running (run ${(fl.state.planGate?.rounds ?? 0) + 1}/${fl.cfg.maxPlanJudgeRounds})` : "workflow: approval queued: the planner is fixing the critic's findings", "info");
				return { action: "handled" };
			}
			abortGate(fl, "message");
			fl.planApproveQueued = false;
			fl.planFixing = false;
			return { action: "continue" };
		}
		if (fl.state.phase !== "plan" || event.source === "extension" || event.streamingBehavior) return { action: "continue" };
		// Without a plan on screen, "yes, do that" answers a question; it doesn't approve anything.
		if (!fl.planReady || !approveRe().test(event.text.trim())) return { action: "continue" };
		ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(fl.cfg.roles.execute)}`, "info");
		await approve(ctx);
		return { action: "handled" };
	});

	pi.on("session_compact", async (event, ctx) => {
		if (event.reason === "overflow" && event.willRetry) fl.overflowRetry = true;
		try {
			const entries = ctx.sessionManager.getEntries();
			const c = entries.findIndex((e) => e.id === event.compactionEntry.id);
			const k = entries.findIndex((e) => e.id === event.compactionEntry.firstKeptEntryId);
			let p = -1;
			let s = -1;
			for (let i = 0; i < c; i++) {
				const e = entries[i] as { type: string; customType?: string; data?: { title?: string; reposted?: boolean } };
				if (e.type === "compaction") p = i;
				if (e.type === "custom" && e.customType === SUMMARY_ENTRY && e.data && e.data.title === undefined && !e.data.reposted) s = i;
			}
			if (s > p && (k === -1 || s < k)) pi.appendEntry(SUMMARY_ENTRY, { ...(entries[s] as { data: object }).data, reposted: true });
		} catch {
			// the card is a convenience; never break compaction
		}
	});

	/** Sends a handover now, after compacting the session first when it starts execute or a stage and the context is over the threshold. */
	function deliverHandover(ctx: ExtensionContext, msg: { customType: string; content: string }, aborted: boolean): void {
		const send = (content: string) => {
			pi.sendMessage({ customType: msg.customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		};
		const held = ctx.getContextUsage()?.tokens ?? null;
		const plan = fl.state.approvedPlan;
		const action = handoverAction({ aborted: aborted, kind: handoverKind(msg.customType), idle: ctx.isIdle(), compacting: fl.compacting, hasPlan: !!plan, tokens: held, threshold: fl.cfg.handoverCompactTokens });
		if (action === "hold") {
			ctx.ui.notify("workflow: handover held: the run was aborted. Send a message or use /flow to continue.", "warning");
			return;
		}
		if (action !== "compact" || !plan) {
			send(msg.content);
			return;
		}
		fl.compactPending = false;
		fl.compacting = true;
		const compactStart = Date.now();
		ctx.ui.notify(`workflow: handing over at ${Math.round((held ?? 0) / 1000)}k tokens, compacting first`, "info");
		ctx.compact({
			customInstructions: prompts.HANDOVER_COMPACT,
			onComplete: () => {
				recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "handover", tokensBefore: held ?? null, ms: Date.now() - compactStart, ok: true });
				fl.compacting = false;
				fl.guardTokens = null;
				void planCardReady(fl).then((card) => send(`${msg.content}\n\n${card}`));
			},
			onError: (e) => {
				recordMetric({ kind: "compaction", at: new Date().toISOString(), reason: "handover", tokensBefore: held ?? null, ms: Date.now() - compactStart, ok: false, error: e.message });
				fl.compacting = false;
				ctx.ui.notify(`workflow: compaction failed: ${e.message}`, "error");
				send(msg.content);
			},
		});
		return;
	}

	/** Sends a workflow message that starts the next executor turn. From agent_end it waits for the run to settle, so the session can be compacted first. */
	function handover(customType: string, content: string, ctx?: ExtensionContext): void {
		if (!fl.inAgentEnd && ctx) {
			deliverHandover(ctx, { customType, content }, false);
			return;
		}
		if (fl.inAgentEnd) {
			fl.pendingHandover = { customType, content };
			return;
		}
		pi.sendMessage({ customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	}

	pi.on("agent_end", async (event, ctx) => {
		fl.inAgentEnd++;
		const prevAborted = fl.turnAborted;
		const lastMsg = [...event.messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		fl.turnAborted = !!event.aborted || lastMsg?.stopReason === "aborted";
		try {
			await onAgentEnd(event, ctx);
		} finally {
			fl.turnAborted = prevAborted;
			fl.inAgentEnd--;
			if (fl.inAgentEnd === 0) scheduleIdleNotice(fl, ctx);
		}
	});

	async function onAgentEnd(event: { messages: AgentMessage[] }, ctx: ExtensionContext): Promise<void> {
		const last = [...event.messages].reverse().find((m) => m.role === "assistant");

		// "Prompt is too long": pi compacts and retries, but the retry ends on a tool result and the
		// bridge answers it with an empty reply, so the run stops. Ask the model to carry on.
		if (fl.overflowRetry) {
			fl.overflowRetry = false;
			if (shouldResume(true, last, fl.resumes)) {
				fl.resumes++;
				pi.sendMessage(
					{
						customType: "workflow-resume",
						content: "The conversation got too long for the model and was compacted. Continue the task from where you stopped, using the summary, without redoing finished steps.",
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				return;
			}
		}

		if (!ctx.hasUI) return;
		const stoppedNormally = last?.role === "assistant" && last.stopReason === "stop" && assistantText(last).trim().length > 0;

		if (fl.state.phase === "discuss" && fl.state.discussionReview?.status === "awaiting-fix" && !fl.gateRun) {
			const dr = fl.state.discussionReview;
			const reply = assistantText(last).trim();
			const list = stoppedNormally ? lastAgreedList([reply]) : undefined;
			const act = stoppedNormally ? discussionGateAfterFixReply({ prevListHash: dr.listHash, replyListHash: list ? textHash(list) : undefined, reply }) : "pause";
			if (act === "recheck") {
				fl.state.discussionReview = { ...dr, status: "idle" };
				persist();
				void runDiscussionGate(ctx, "recheck", dr.restateLoop ?? true, false);
			}
			else {
				fl.state.discussionReview = { ...dr, status: "paused" };
				persist();
				ctx.ui.notify("workflow: discussion critic paused: answer its findings, then say go again", "info");
			}
		}

		if (fl.state.phase === "plan") {
			const wasFixing = fl.planFixing;
			fl.planFixing = false;
			// Every finished reply offers the choice; aborted or errored ones do not.
			// A typed "go" approves only a finished plan that is not waiting on an answer.
			const text = assistantText(last).trim();
			if (stoppedNormally) {
				fl.planDraft = addPlanReply(fl.planDraft, text);
				fl.planProposed = !!fl.planDraft.full;
			}
			fl.planReady = canApprove(text, stoppedNormally, fl.planProposed);
			if (!stoppedNormally) return;
			fl.planWaitNow = fl.planDraft.full ? planWaitProblems(composePlan(fl.planDraft), (c) => readOnlyProblem(c)) : [];
			if (!fl.planWaitNow.length) fl.planWaitRetried = false;
			if (fl.planWaitNow.length && /^##\s*Plan(?::| changes)/m.test(text)) {
				if (!fl.planWaitRetried) {
					fl.planWaitRetried = true;
					fl.planReady = false;
					pi.sendMessage({ customType: "workflow-plan-waits", content: `The plan has wait checks that can't run:\n${fl.planWaitNow.map((p) => `- ${p}`).join("\n")}\nFix them: reply with the whole plan again as a new \`## Plan:\`, the fixed wait checks included. A check is one plain read-only command: no backticks around it, no placeholders like <version>, no command substitution. If a value is only known after an earlier stage (a version a script picks), drop that check or the wait itself.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
					return;
				}
				ctx.ui.notify(`workflow: the plan still has wait checks that can't run (${fl.planWaitNow[0]}). Fix them with the planner before approving.`, "warning");
			}
			const blocked = approvalBlock(fl.planDraft, fl.planWaitNow);
			if (blocked) fl.planReady = false;
			if (!fl.planReady || blocked) fl.planApproveQueued = false;
			if (fl.planReady && !blocked) {
				const emitted = composePlan(fl.planDraft);
				const decision = planGateDecide({ mode: fl.cfg.autoJudgePlan, plan: emitted, planHash: textHash(emitted), gate: fl.state.planGate, hasDisputes: wasFixing && planDisputes(text) !== undefined });
				if (decision !== "off" && decision !== "reuse") {
					void runPlanGate(ctx, emitted, text, decision);
					return;
				}
				const reused = decision === "reuse" ? fl.state.planGate : undefined;
				const queued = fl.planApproveQueued;
				fl.planApproveQueued = false;
				if (reused && planOfferAction({ clean: isClean(reused.verdict, [...reused.autoFindings, ...reused.userFindings]), queuedGo: queued }) === "approve") {
					ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(fl.cfg.roles.execute)}`, "info");
					await approve(fl.lastCtx ?? ctx);
					return;
				}
				await offerPlan(ctx, blocked);
				return;
			}
			await offerPlan(ctx, blocked);
			return;
		}

		if (fl.state.phase !== "execute") return;
		// Waiting for a person: no judge, no delivery, no stage advance until the wait is over.
		if (fl.state.waiting) return;
		if (!skipJudge(last)) fl.state.autoRetries = 0;
		if (skipJudge(last)) {
			const autoRetry = autopilotOn() && !(fl.state.autoRetries ?? 0);
			if (autoRetry) {
				fl.state.autoRetries = 1;
				noteAuto("executor error: retried automatically");
				ctx.ui.notify("workflow: autopilot: the executor's reply failed; retrying once", "info");
			}
			const choice = autoRetry ? "Retry" : await askUser(fl, ctx, "The executor's last reply ended in an error", ["Retry", "Back to planning", "Stop"]);
			if (choice === "Retry") {
				pi.sendMessage(
					{ customType: "workflow-retry", content: "Your last reply ended in an error. Continue with the open steps of the approved plan.", display: true },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} else if (choice === "Back to planning") {
				await setPhase(ctx, "plan");
			} else {
				ctx.ui.notify("workflow: stopped: the executor's reply failed", "warning");
				summarizeFlow(stoppedSummary("stopped: the executor's reply failed"), false);
				await endFlow(ctx);
			}
			return;
		}
		let rejudge = false;
		if (fl.state.pendingPlanFlaw) {
			// The executor's own judge call questioned the plan; it was told to stop, so the workflow decides.
			const report = fl.state.pendingPlanFlaw;
			fl.state.pendingPlanFlaw = undefined;
			persist();
			const flawed = await collectFlowDiff(fl, ctx);
			if (flawed) {
				if (fl.state.lastJudge?.hash === flawed.hash) {
					const route = planFlawOnPass(parseFindings(report), fl.state.lastJudge.verdict === "PASS" ? "PASS" : "FAIL");
					const outcome = route === "stop" ? await resolvePlanFlaw(ctx, report, flawed) : await settlePlanFlawOnPass(ctx, report, flawed, route);
					if (outcome !== "continue") return;
					if (fl.state.lastJudge.verdict === "PASS") markPassed(fl, flawed.hash);
					else {
						await fixOrAsk(ctx, undefined);
						return;
					}
				} else {
					// The diff changed since that review: drop the stale report and let reviewDiff judge this diff again.
					fl.seenDiffs.delete(flawed.hash);
					rejudge = true;
				}
			}
		}
		await reviewDiff(ctx, rejudge);
	}

	/** A stage that declares `(after: …)` waits before it starts: keeps its start text until the wait is over. True when it now waits. */
	function holdForStageWait(ctx: ExtensionContext, stage: ReturnType<typeof parseStages>[number], held: string): boolean {
		if (!stage.after) return false;
		setWaiting({ reason: stage.after.reason, ...(stage.after.check ? { check: stage.after.check } : {}), stage: stage.n, since: new Date().toISOString(), planned: true, atStageStart: true, held });
		persist();
		updateStatus(ctx);
		planMilestone(ctx);
		ctx.ui.notify(`workflow: stage ${stage.n} waits for: ${stage.after.reason}`, "info");
		startWaitTimer();
		return true;
	}

	/** Staged plan: moves on to the next stage and sends its start message. */
	function startNextStage(ctx: ExtensionContext, stages: ReturnType<typeof parseStages>, outcome: string): void {
		const next = (fl.state.stage ?? 0) + 1;
		fl.state.stage = next;
		fl.state.judgeRounds = 0;
		fl.state.minorRounds = 0;
		fl.state.minorSentFor = undefined;
		fl.state.minorFix = undefined;
		fl.state.stageJudged = undefined;
		if (fl.state.passedDiff) markPassSummarized(fl.state.passedDiff); // a leftover diff from the stage before is not this stage's
		fl.state.lastJudge = undefined; // a new stage gets a full review, not a re-review of the last one
		fl.state.lastFullPass = undefined;
		fl.view.stage = "execute";
		fl.view.changed();
		planMilestone(ctx);
		persist();
		ctx.ui.notify(`workflow: stage ${next} of ${stages.length}: ${stages[next - 1].title}`, "info");
		const text = nextStage(stages, next, outcome) + deliverHintsText(next);
		if (holdForStageWait(ctx, stages[next - 1], text)) return;
		handover("workflow-stage", text);
	}

	/** A staged plan's turn ended with nothing new to review: it ends the stage only if the executor handed it over (judge called) or the user confirms. */
	async function noChangeTurn(ctx: ExtensionContext, staged: { stages: ReturnType<typeof parseStages>; current: number }): Promise<void> {
		const auto = (fl.cfg.stageAdvance === "auto" || autopilotOn()) && !fl.turnAborted;
		const open = (fl.state.checklist ?? []).filter((i) => !isHuman(i) && !i.done && (i.stage === undefined || i.stage === staged.current)).length;
		const what = noChangeStage(!!fl.state.stageJudged, ctx.hasUI, auto, open);
		if (what === "wait") return;
		if (what === "advance" && auto && !fl.state.stageJudged) ctx.ui.notify(`workflow: stage ${staged.current} ended with no changes; continuing (${fl.cfg.stageAdvance === "auto" ? "stageAdvance: auto" : "autopilot"})`, "info");
		if (what === "ask") {
			const yes = "Mark done and continue";
			if ((await askUser(fl, ctx, `Stage ${staged.current} ended with no changes`, [yes, "Wait"])) !== yes) return;
		}
		await stageWithoutChanges(ctx, staged);
	}

	/** An unstaged flow whose remaining changes were all delivered by checkpoints: ends it with their outcome. Open steps ask first (and do nothing without a UI). */
	async function flowWithoutChanges(ctx: ExtensionContext): Promise<void> {
		const outcome = checkpointOutcome(fl.state.checkpoints ?? []) ?? (fl.state.lastJudge?.verdict === "PASS" ? { text: "judge passed, nothing left to review", ok: true } : null);
		if (!outcome || fl.state.phase !== "execute" || fl.turnAborted) return;
		if ((fl.state.checklist ?? []).some((i) => !isHuman(i) && !i.done)) {
			if (!ctx.hasUI) return;
			const yes = "Mark done and finish";
			if ((await askUser(fl, ctx, "All changes were delivered at checkpoints, but plan steps are still open", [yes, "Wait"])) !== yes) return;
		}
		fl.state.minorRounds = 0;
		fl.state.minorSentFor = undefined;
		fl.state.minorFix = undefined;
		fl.state.planFlaw = undefined;
		fl.view.stage = "execute";
		const decided = mergeDecisionsText(fl.state.approvedPlan);
		if (!summarizeFlow(decided ? `${outcome.text}; ${decided}` : outcome.text, outcome.ok)) persist();
		await endFlow(ctx);
	}

	/** A staged plan's stage ended with nothing to review: records it and starts the next stage, or ends the flow after the last one. */
	async function stageWithoutChanges(ctx: ExtensionContext, staged: { stages: ReturnType<typeof parseStages>; current: number }): Promise<void> {
		const outcome = checkpointOutcome(stageCheckpoints(fl)) ?? { text: "no changes", ok: true };
		fl.state.stageOutcomes = [...(fl.state.stageOutcomes ?? []), outcome];
		if (staged.current < staged.stages.length) {
			startNextStage(ctx, staged.stages, outcome.text);
			return;
		}
		const final = stagesOutcome(fl.state.stageOutcomes, staged.stages.length);
		fl.state.minorRounds = 0;
		fl.state.minorSentFor = undefined;
		fl.state.minorFix = undefined;
		const decided = mergeDecisionsText(fl.state.approvedPlan);
		const finalText = decided ? `${final.text}; ${decided}` : final.text;
		fl.state.planFlaw = undefined;
		fl.state.stage = undefined;
		fl.state.stageOutcomes = undefined;
		fl.view.stage = "execute";
		if (!summarizeFlow(finalText, final.ok)) persist();
		await endFlow(ctx);
	}

	/** The summary text for a flow that stops early: the stages already delivered, then `text`. Clears the stage state. */
	function stoppedSummary(text: string): string {
		const staged = currentStages();
		const done = fl.state.stageOutcomes ?? [];
		fl.state.stage = undefined;
		fl.state.stageOutcomes = undefined;
		if (!staged || done.length === 0) return text;
		return `${done.map((p, i) => `stage ${i + 1}: ${p.text}`).join("; ")}; ${text}`;
	}

	/** Makes `gh` runnable: when it is not on PATH, adds a standard GitHub CLI install folder to this process's PATH. */
	async function ensureGh(ctx: ExtensionContext): Promise<boolean> {
		const works = async () => {
			try {
				return (await pi.exec("gh", ["--version"], { timeout: 10_000 })).code === 0;
			} catch {
				return false;
			}
		};
		if (await works()) return true;
		const found = ghCandidates(process.env, process.platform).find((c) => fs.existsSync(c));
		if (!found) return false;
		const dir = path.dirname(found);
		const { key, value } = withPathDir(process.env, dir, path.delimiter);
		process.env[key] = value;
		if (!(await works())) return false;
		if (!fl.ghNoticed) {
			fl.ghNoticed = true;
			ctx.ui.notify(`workflow: gh was not on PATH; added ${dir}`, "info");
		}
		return true;
	}

	/** The plan is complete and judged (or the judge is off): the approval menu. */
	async function offerPlan(ctx: ExtensionContext, blocked: string | undefined): Promise<void> {
		const approveLabel = PLAN_APPROVE;
		const arbiterLabel = PLAN_ARBITER;
		const menu = planMenuRequest({ blocked: !!blocked, planFlawAsk: fl.cfg.planFlaw === "ask", planPrompt: fl.cfg.planPrompt });
		const choice = await askUser(fl, ctx, `Plan phase · execute on ${describeRole(fl.cfg.roles.execute)}`, menu.options, {
			skipLocal: menu.skipLocal,
			localNotice: () => {
				if (!fl.cfg.planPrompt) ctx.ui.notify(`workflow: say "go" to execute on ${describeRole(fl.cfg.roles.execute)}, or keep discussing.`, "info");
				else if (blocked) ctx.ui.notify(`workflow: can't approve: ${blocked}.`, "warning");
			},
		});
		if (choice === PLAN_BACK) {
			await setPhase(ctx, "discuss");
			ctx.ui.notify(`workflow: back to discussion on ${describeRole(fl.cfg.roles.discuss)}`, "info");
			return;
		}
		if (choice === arbiterLabel && fl.cfg.planFlaw === "ask") {
			await approve(ctx, true);
			return;
		}
		if (choice === approveLabel) await approve(ctx);
	}

	/** The plan judge: one run on a complete plan, then fix (auto findings go to the planner), offer, or approve a queued "go". Runs detached from agent_end and the input hook. */
	async function runPlanGate(ctx: ExtensionContext, plan: string, text: string, decision: "confirm" | "recheck" | "full"): Promise<void> {
		abortGate(fl, "restart");
		const gate0 = fl.state.planGate;
		const run = { kind: "plan" as const, controller: new AbortController(), judgedHash: textHash(plan) } as NonNullable<typeof fl.gateRun>;
		fl.gateRun = run;
		if (ctx.hasUI) {
			try {
				run.offEsc = ctx.ui.onTerminalInput((d) => (isEscKey(d) ? (abortGate(fl, "esc"), { consume: true }) : undefined));
			} catch {}
		}
		updateStatus(ctx);
		let specKind: SpecKind = "none";
		let outcome: { text: string; findings: Finding[]; review: ReviewResult; ext?: RunView } | { error: string; review?: ReviewResult; ext?: RunView } | undefined;
		const started = Date.now();
		try {
			const branch = ctx.sessionManager.getBranch();
			const assistantTexts: string[] = [];
			for (const entry of branch) {
				const m = entry.type === "message" ? (entry as { message?: { role?: string; content?: unknown } }).message : undefined;
				if (m?.role !== "assistant") continue;
				const t = Array.isArray(m.content)
					? m.content.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: string }) => p.text ?? "").join("\n")
					: typeof m.content === "string" ? m.content : "";
				if (t.trim()) assistantTexts.push(t);
			}
			const agreed = lastAgreedList(assistantTexts);
			const spec = agreed ? { kind: "agreed" as const, text: agreed } : undefined;
			specKind = spec ? spec.kind : "none";
			const recheck = decision !== "full" && gate0?.judgedPlan !== undefined ? { findings: [...gate0.autoFindings, ...gate0.userFindings], disputes: planDisputes(lastAssistantText(ctx)) } : undefined;
			if (ctx.hasUI) ctx.ui.setWorkingMessage("critic reviewing the plan…");
			let ext: RunView | undefined;
			const review = await runCritic({
				...planCriticRequest({ plan, spec, folders: fl.state.folders ?? [], recheck }),
				cwd: ctx.cwd,
				signal: run.controller.signal,
				mcpServers: pi.getMcpServers(),
				onRun: (r) => {
					ext = r;
					fl.view.mirror("critic", r);
				},
			});
			outcome = review.ok ? { text: review.text, findings: review.findings, review, ext } : { error: review.error ?? "failed", review, ext };
		} catch (e) {
			outcome = { error: (e as Error).message };
		} finally {
			try {
				run.offEsc?.();
			} catch {}
			if (fl.gateRun === run) fl.gateRun = undefined;
			if (ctx.hasUI) ctx.ui.setWorkingMessage();
			updateStatus(ctx);
			try {
				if (ctx.isIdle()) scheduleIdleNotice(fl, ctx);
			} catch {}
		}
		const blank: PlanGate = gate0 ?? { planHash: run.judgedHash, rounds: 0, autoFindings: [], userFindings: [], spec: specKind };
		const stale = fl.state.phase !== "plan" || !fl.planReady || textHash(composePlan(fl.planDraft)) !== run.judgedHash;
		if ((run.reason || stale || (outcome && "error" in outcome)) && outcome?.review) endReview("critic", outcome.ext, outcome.review, started, false, run.reason ? "cancelled · plan" : stale ? "discarded · plan changed" : `failed · ${outcome.review.error ?? "no result"}`);
		if (run.reason) {
			if (run.reason === "restart") return;
			fl.planApproveQueued = false;
			if ((run.reason === "esc" || run.reason === "command") && !stale) {
				const g: PlanGate = { ...blank, planHash: run.judgedHash, verdict: "cancelled", spec: specKind };
				fl.state.planGate = g;
				persist();
				ctx.ui.notify("workflow: plan critic cancelled", "info");
				await offerPlan(ctx, undefined);
			}
			return;
		}
		if (stale) return;
		if (!outcome || "error" in outcome) {
			const error = outcome && "error" in outcome ? outcome.error : "no result";
			const g: PlanGate = { ...blank, planHash: run.judgedHash, verdict: "error", spec: specKind };
			fl.state.planGate = g;
			persist();
			fl.planApproveQueued = false;
			ctx.ui.notify(`workflow: plan critic did not run: ${error}`, "warning");
			await offerPlan(ctx, undefined);
			return;
		}
		const findings = outcome.findings;
		const verdict = discussionVerdict(outcome.text);
		const confirm = decision === "confirm";
		const rounds = (gate0?.rounds ?? 0) + (confirm ? 0 : 1);
		const after = planGateAfterVerdict({ verdict, findings, rounds, max: fl.cfg.maxPlanJudgeRounds, confirm });
		const clean = isClean(verdict, findings);
		endReview("critic", outcome.ext, outcome.review, started, verdict === "PASS", `${verdict} · plan`);
		recordMetric(judgeMetric("plan", rounds, verdict, findings));
		const g: PlanGate = {
			planHash: run.judgedHash,
			rounds,
			verdict,
			autoFindings: after.auto,
			userFindings: after.user,
			notes: after.notes,
			judgedPlan: plan,
			cappedHash: after.action === "offer" && !clean && (after.capped || confirm) ? run.judgedHash : undefined,
			spec: specKind,
		};
		fl.state.planGate = g;
		persist();
		pi.sendMessage({ customType: "workflow-plan-judge", content: `**Plan critic: ${verdict}** (run ${rounds}/${fl.cfg.maxPlanJudgeRounds})\n\n${outcome.text}`, display: true }, { triggerTurn: false });
		const assume = autopilotOn() && !confirm && !after.capped && !clean && after.user.length > 0;
		if (assume) noteAuto(`plan critic: ${after.user.length} finding(s) that needed a decision were settled by the planner as assumptions`);
		if (after.action === "fix" || assume) {
			fl.planFixing = true;
			const listed = [...after.auto, ...after.user].map((f) => `- ${findingText(f).replace(/\n/g, "\n  ")}`).join("\n");
			pi.sendMessage({ customType: "workflow-plan-fix", content: `${prompts.PLAN_FIX}${assume ? ` ${prompts.PLAN_ASSUME}` : ""}\n\n${listed}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		const queued = fl.planApproveQueued;
		fl.planApproveQueued = false;
		if (planOfferAction({ clean, queuedGo: queued }) === "approve") {
			ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(fl.cfg.roles.execute)}`, "info");
			await approve(fl.lastCtx ?? ctx);
			return;
		}
		await offerPlan(ctx, undefined);
	}

	/** `/flow critic` in plan: the critic reviews the plan on screen now, whatever the gate remembers. */
	function criticPlanNow(ctx: ExtensionContext): void {
		if (!fl.planReady || !fl.planDraft.full) {
			ctx.ui.notify("workflow: no complete plan to review yet", "info");
			return;
		}
		const plan = composePlan(fl.planDraft);
		const hash = textHash(plan);
		const decision = planGateDecide({ mode: "auto", plan, planHash: hash, gate: fl.state.planGate });
		// The same plan again gets a full pass, not a recheck with an empty diff.
		void runPlanGate(ctx, plan, lastAssistantText(ctx), fl.state.planGate?.planHash === hash || decision === "reuse" || decision === "off" ? "full" : decision);
	}

	function branchAssistantTexts(branch: readonly unknown[]): string[] {
		const out: string[] = [];
		for (const entry of branch) {
			const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
			const m = e.type === "message" ? e.message : undefined;
			if (m?.role !== "assistant") continue;
			const t = Array.isArray(m.content)
				? m.content.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: string }) => p.text ?? "").join("\n")
				: typeof m.content === "string" ? m.content : "";
			if (t.trim()) out.push(t);
		}
		return out;
	}

	/** The transcript of the branch entries after `id`; undefined when that entry is not on the branch. */
	function transcriptAfter(branch: readonly { id?: string }[], id: string, max: number): string | undefined {
		const i = branch.findIndex((e) => e.id === id);
		return i < 0 ? undefined : branchTranscript(branch.slice(i + 1), max);
	}

	/** Leaves discuss for plan after the discussion gate; `open` findings go into the kickoff. */
	async function moveToPlan(ctx: ExtensionContext, open?: Finding[], notes?: Finding[]): Promise<void> {
		if (fl.state.discussionReview) fl.state.discussionReview = { ...fl.state.discussionReview, status: "idle" };
		await setPhase(ctx, "plan");
		ctx.ui.notify(`workflow: planning on ${describeRole(fl.cfg.roles.plan)}`, "info");
		sendPlanKickoff(open, notes);
	}

	/** A review already ran on this list and the list was not rewritten since: the judge would read the same text again, so the discuss model restates the conclusion first. True when it asked. */
	function askRestate(ctx: ExtensionContext, loop: boolean): boolean {
		const last = fl.state.discussionReview;
		const list = lastAgreedList(branchAssistantTexts(ctx.sessionManager.getBranch()));
		if (!last || !list || last.listHash !== textHash(list) || isClean(last.verdict, last.findings) || fl.restateAskedFor === last.listHash) return false;
		fl.restateAskedFor = last.listHash;
		fl.state.discussionReview = { ...last, status: "awaiting-fix", restateLoop: loop };
		persist();
		ctx.ui.notify("workflow: the agreed list was not rewritten since the last review; asking for a restated conclusion first", "info");
		pi.sendMessage({ customType: "workflow-discussion-restate", content: prompts.DISCUSSION_RESTATE, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		return true;
	}

	/** The move from discuss to plan. Returns true when the discussion judge started (the move happens after it); false when the caller moves now. */
	async function startDiscussionGate(ctx: ExtensionContext): Promise<boolean> {
		if (!ctx.hasUI) return false;
		if (fl.gateRun?.kind === "discussion") {
			ctx.ui.notify("workflow: discussion critic running (Esc or any other message cancels it)", "info");
			return true;
		}
		const branch = ctx.sessionManager.getBranch();
		const list = lastAgreedList(branchAssistantTexts(branch));
		const last = fl.state.discussionReview;
		let sinceChars = Number.POSITIVE_INFINITY;
		if (last?.afterEntryId) {
			const t = transcriptAfter(branch, last.afterEntryId, 10_000_000);
			if (t !== undefined) sinceChars = t.length;
		}
		const d = discussionGateStart({ mode: fl.cfg.autoJudgeDiscussion, listHash: list ? textHash(list) : undefined, last, sinceChars, cap: 30_000 });
		if (d === "warn-move") ctx.ui.notify("workflow: no Agreed so far: list: discussion critic skipped", "warning");
		if (d === "move" || d === "warn-move") return false;
		if (askRestate(ctx, true)) return true;
		void runDiscussionGate(ctx, d, true);
		return true;
	}

	/** The discussion critic: one run on the last agreed list. `loop` false is the manual `/flow critic`: it reports and stores the review but starts no fix loop. */
	async function runDiscussionGate(ctx: ExtensionContext, decision: "full" | "recheck", loop: boolean, resetRounds = true): Promise<void> {
		abortGate(fl, "restart");
		const prev = fl.state.discussionReview;
		const branch = ctx.sessionManager.getBranch();
		const list = lastAgreedList(branchAssistantTexts(branch));
		const listHash = list ? textHash(list) : "";
		const sinceAll = decision === "recheck" && prev?.afterEntryId && list ? transcriptAfter(branch, prev.afterEntryId, 10_000_000) : undefined;
		// Over the cap the recheck becomes a full pass.
		const since = sinceAll !== undefined && sinceAll.length <= 30_000 ? sinceAll : undefined;
		const transcript = since === undefined ? branchTranscript(branch, fl.cfg.judge.maxDiscussionChars) : "";
		if (since === undefined && !transcript.trim()) {
			ctx.ui.notify("workflow: nothing to review yet", "info");
			if (loop) await moveToPlan(ctx);
			return;
		}
		const run = { kind: "discussion" as const, controller: new AbortController(), judgedHash: listHash } as NonNullable<typeof fl.gateRun>;
		fl.gateRun = run;
		if (ctx.hasUI) {
			try {
				run.offEsc = ctx.ui.onTerminalInput((d) => (isEscKey(d) ? (abortGate(fl, "esc"), { consume: true }) : undefined));
			} catch {}
		}
		updateStatus(ctx);
		let outcome: { text: string; findings: Finding[]; review: ReviewResult; ext?: RunView } | { error: string; review?: ReviewResult; ext?: RunView } | undefined;
		const started = Date.now();
		try {
			ctx.ui.setWorkingMessage("critic reviewing the discussion…");
			const recheck = since !== undefined && !!prev && !!list;
			let ext: RunView | undefined;
			const review = await runCritic({
				...discussionCriticRequest({
					list,
					transcript: recheck ? since! : since === undefined ? transcript : branchTranscript(branch, fl.cfg.judge.maxDiscussionChars),
					folders: fl.state.folders ?? [],
					recheck: recheck ? { findings: prev!.findings } : undefined,
					disputes: recheck ? planDisputes(lastAssistantText(ctx)) : undefined,
				}),
				cwd: ctx.cwd,
				signal: run.controller.signal,
				mcpServers: pi.getMcpServers(),
				onRun: (r) => {
					ext = r;
					fl.view.mirror("critic", r);
				},
			});
			outcome = review.ok ? { text: review.text, findings: review.findings, review, ext } : { error: review.error ?? "failed", review, ext };
		} catch (e) {
			outcome = { error: (e as Error).message };
		} finally {
			try {
				run.offEsc?.();
			} catch {}
			if (fl.gateRun === run) fl.gateRun = undefined;
			ctx.ui.setWorkingMessage();
			updateStatus(ctx);
			try {
				if (ctx.isIdle()) scheduleIdleNotice(fl, ctx);
			} catch {}
		}
		const nowList = lastAgreedList(branchAssistantTexts(ctx.sessionManager.getBranch()));
		const stale = fl.state.phase !== "discuss" || (nowList ? textHash(nowList) : "") !== listHash;
		if ((run.reason || stale || (outcome && "error" in outcome)) && outcome?.review) endReview("critic", outcome.ext, outcome.review, started, false, run.reason ? "cancelled · discussion" : stale ? "discarded · list changed" : `failed · ${outcome.review.error ?? "no result"}`);
		if (run.reason) {
			if (run.reason === "restart" || run.reason === "phase") return;
			if (fl.state.discussionReview) {
				fl.state.discussionReview = { ...fl.state.discussionReview, status: "idle" };
				persist();
			}
			if (run.reason === "esc" || run.reason === "command") ctx.ui.notify("workflow: discussion critic cancelled; still in discuss", "info");
			return;
		}
		if (stale) return;
		if (!outcome || "error" in outcome) {
			const error = outcome && "error" in outcome ? outcome.error : "no result";
			if (!loop) {
				ctx.ui.notify(`workflow: discussion review failed: ${error}`, "error");
				return;
			}
			ctx.ui.notify(`workflow: discussion critic did not run: ${error}`, "warning");
			await moveToPlan(ctx);
			return;
		}
		const findings = outcome.findings;
		const verdict = discussionVerdict(outcome.text);
		const rounds = (resetRounds ? 0 : prev?.rounds ?? 0) + (loop ? 1 : 0);
		endReview("critic", outcome.ext, outcome.review, started, verdict === "PASS", `${verdict} · discussion`);
		recordMetric(judgeMetric("discussion", rounds, verdict, findings));
		pi.sendMessage({ customType: "workflow-discussion-review", content: `**Discussion review: ${verdict}**\n\n${outcome.text}`, display: true }, { triggerTurn: false });
		const after = ctx.sessionManager.getBranch();
		fl.state.discussionReview = { listHash, verdict, findings, afterEntryId: (after[after.length - 1] as { id?: string } | undefined)?.id, rounds, status: "idle" };
		persist();
		if (!loop) {
			ctx.ui.notify(`workflow: discussion review ${verdict}${list ? "" : " (no Agreed so far: list found)"}`, verdict === "PASS" ? "info" : "warning");
			return;
		}
		const action = discussionGateAfterVerdict({ verdict, findings, rounds, max: fl.cfg.maxDiscussionJudgeRounds });
		if (action === "move") await moveToPlan(ctx, undefined, minorFindings(findings));
		else if (action === "move-open") {
			ctx.ui.notify(`workflow: discussion critic: ${blockingFindings(findings).length} finding(s) still open after ${rounds} runs; planning with them noted`, "warning");
			await moveToPlan(ctx, blockingFindings(findings), minorFindings(findings));
		} else if (action === "fix") {
			fl.state.discussionReview = { ...fl.state.discussionReview, status: "awaiting-fix" };
			persist();
			ctx.ui.notify(`workflow: discussion critic: fixing ${blockingFindings(findings).length} finding(s) (run ${rounds}/${fl.cfg.maxDiscussionJudgeRounds})`, "info");
			const listed = blockingFindings(findings).map((f) => `- ${findingText(f).replace(/\n/g, "\n  ")}`).join("\n");
			pi.sendMessage({ customType: "workflow-discussion-fix", content: `${prompts.DISCUSSION_FIX}\n\n${listed}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		} else {
			fl.state.discussionReview = { ...fl.state.discussionReview, status: "paused" };
			persist();
			ctx.ui.notify(`workflow: discussion critic: ${blockingFindings(findings).filter((f) => f.route === "user").length} finding(s) need your decision; answer them, then say go again`, "warning");
		}
	}

	/** diff ready -> judge -> fix loop, or commit (and push) once it passes. */
	async function reviewDiff(ctx: ExtensionContext, manual: boolean): Promise<void> {
		const baseNote = await refreshReviewBase(fl, ctx);
		const diff = await collectFlowDiff(fl, ctx);
		if (!diff?.text) {
			if (manual) ctx.ui.notify("workflow: no changes to review", "info");
			else if (diff && fl.state.passedDiff && passPending({ passedDiff: fl.state.passedDiff, judged: fl.state.lastJudge, summarized: fl.state.summarizedPasses })) {
				// The executor delivered the passed change and the base moved up with it: nothing is left to review, but the pass is still open.
				await stageDone(ctx, { ...diff, hash: fl.state.passedDiff });
			} else {
				const staged = currentStages();
				if (staged) await noChangeTurn(ctx, staged);
				else await flowWithoutChanges(ctx);
			}
			return;
		}
		// Already passed, e.g. the executor called judge itself: straight to commit.
		if (!manual && diff.hash === fl.state.passedDiff) {
			const prior = fl.state.lastJudge?.hash === diff.hash ? fl.state.lastJudge.text : "";
			const open = minorFixOpen({ summarized: !!fl.state.summarizedPasses?.includes(diff.hash), sentFor: fl.state.minorSentFor, hash: diff.hash });
			if (open && fixMinorFindings(prior, diff.hash)) return;
			await stageDone(ctx, diff);
			return;
		}
		if (!manual && (fl.cfg.autoJudge === "off" || fl.seenDiffs.has(diff.hash))) return;
		if (!manual && fl.cfg.autoJudge === "ask" && !autopilotOn()) {
			const run = (await askUser(fl, ctx, `Diff ready: run the judge (${describeRole(modelOf(fl, "judge"))}) on ${diff.files} changed file(s)?`, ["Run the judge", "Skip"])) === "Run the judge";
			if (!run) {
				fl.seenDiffs.add(diff.hash);
				return;
			}
		}

		ctx.ui.setWorkingMessage(`judge reviewing ${diff.files} file(s)…`);
		let r: JudgeResult;
		try {
			r = await judge(fl, ctx, diff, baseNote);
		} finally {
			ctx.ui.setWorkingMessage();
		}
		if (r.verdict === "ERROR") {
			ctx.ui.notify(r.text, "error");
			if (!ctx.hasUI || fl.state.phase !== "execute") return;
			const autoRetry = autopilotOn() && !(fl.state.autoRetries ?? 0);
			if (autoRetry) {
				fl.state.autoRetries = 1;
				noteAuto("judge error: retried automatically");
				ctx.ui.notify("workflow: autopilot: the judge failed to run; retrying once", "info");
			}
			const choice = autoRetry ? "Retry the judge" : await askUser(fl, ctx, "The judge failed to run", ["Retry the judge", "Back to planning", "Stop"]);
			if (choice === "Retry the judge") {
				await reviewDiff(ctx, true);
			} else if (choice === "Back to planning") {
				await setPhase(ctx, "plan");
			} else {
				ctx.ui.notify("workflow: stopped: the judge failed to run", "warning");
				summarizeFlow(stoppedSummary("stopped: the judge failed to run"), false);
				await endFlow(ctx);
			}
			return;
		}
		fl.state.autoRetries = 0;
		// The verdict travels with the next instruction, so they reach the transcript in order.
		const report = `**Judge: ${r.verdict}**\n\n${r.text}`;
		if (planFlaws(r.findings).length) {
			const route = planFlawOnPass(r.findings, r.verdict);
			const outcome = route === "stop" ? await resolvePlanFlaw(ctx, report, diff) : await settlePlanFlawOnPass(ctx, report, diff, route);
			if (outcome !== "continue") return;
			if (r.verdict === "PASS") markPassed(fl, diff.hash);
		}
		if (r.verdict === "FAIL") {
			fl.state.judgeRounds++;
			persist();
			await fixOrAsk(ctx, report);
			return;
		}

		if (fixMinorFindings(r.text, diff.hash, report)) return;
		await stageDone(ctx, diff, report);
	}

	/** After a failed judge round: send the executor back to fix, or ask what to do once the round cap is hit. */
	async function fixOrAsk(ctx: ExtensionContext, report: string | undefined): Promise<void> {
		if (judgeCapReached(fl.state.judgeRounds, fl.cfg.maxJudgeRounds)) {
			if (report) pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			const autoCap = autopilotOn() ? ((fl.state.autoCaps ?? 0) === 0 ? "Escalate and keep fixing" : "Stop") : undefined;
			if (autoCap) {
				fl.state.autoCaps = (fl.state.autoCaps ?? 0) + 1;
				noteAuto(`judge cap (${fl.state.judgeRounds} failed rounds): ${autoCap === "Stop" ? "stopped (second cap)" : "escalated and kept fixing (advisor asked once)"}`);
				ctx.ui.notify(`workflow: autopilot: judge cap reached; ${autoCap === "Stop" ? "stopping" : "escalating and fixing on"}`, "warning");
			}
			const choice = autoCap ?? await askUser(fl, ctx, `Judge failed ${fl.state.judgeRounds} rounds in a row`, ["Keep fixing", "Escalate and keep fixing", "Stop"]);
			if (choice === "Keep fixing" || choice === "Escalate and keep fixing") {
				if (choice !== "Keep fixing") await escalate(ctx);
				fl.state.judgeRounds = 0;
				persist();
				pi.sendMessage({ customType: "workflow-fix", content: autoCap ? `${prompts.FIX_MESSAGE} Before you change code, ask the advisor about the open findings above.` : prompts.FIX_MESSAGE, display: true }, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}
			ctx.ui.notify(`workflow: stopped after ${fl.state.judgeRounds} failed judge rounds`, "warning");
			summarizeFlow(stoppedSummary(`stopped: judge failed ${fl.state.judgeRounds} rounds`), false);
			await endFlow(ctx);
			return;
		}
		pi.sendMessage(
			{ customType: "workflow-fix", content: report ? `${report}\n\n${prompts.FIX_MESSAGE}` : prompts.FIX_MESSAGE, display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	/**
	 * The judge says the approved plan itself is flawed. In "ask" mode the user decides; in "auto" mode
	 * (or on request, or when chosen at approval) the arbiter does, and asks the user only when it cannot decide.
	 * "continue": carry on with the verdict. "amended": the plan was changed and the executor is on it.
	 * "stop": back to planning, or the flow ended.
	 */
	async function resolvePlanFlaw(ctx: ExtensionContext, report: string, diff: Diff): Promise<"continue" | "amended" | "stop"> {
		let arbiter = arbiterFirst(autopilotOn() ? "auto" : fl.state.planFlaw, fl.cfg.planFlaw);
		let canAsk = true;
		for (;;) {
			if (arbiter) {
				arbiter = false;
				const outcome = await runArbiter(ctx, report, diff);
				if (outcome !== "ask") return outcome;
				canAsk = false; // the arbiter had its say; offer the rest
			}
			if (!ctx.hasUI) {
				pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
				summarizeFlow(stoppedSummary("stopped: judge questions the plan"), false);
				await endFlow(ctx);
				return "stop";
			}
			const options = ["Back to planning", ...(canAsk ? ["Let the arbiter decide"] : []), "Ignore and continue", "Stop"];
			const choice = await askUser(fl, ctx, "Judge questions the plan", options);
			if (choice === "Back to planning") {
				await setPhase(ctx, "plan");
				pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
				return "stop";
			}
			if (choice === "Let the arbiter decide") {
				arbiter = true;
				continue;
			}
			if (choice === "Ignore and continue") {
				// Recorded, so the next review does not raise the same flaw and ask again.
				notePlanFlaws(ctx, report, "Plan choices upheld by the user");
				return "continue";
			}
			pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			summarizeFlow(stoppedSummary("stopped: judge questions the plan"), false);
			await endFlow(ctx);
			return "stop";
		}
	}

	/** Appends the report's plan-flaw lines to the approved plan under the heading; returns how many. */
	function notePlanFlaws(ctx: ExtensionContext, report: string, heading: string): number {
		const lines = planFlaws(parseFindings(report)).map((f) => `- ${f.head}`).filter((l) => !(fl.state.approvedPlan ?? "").includes(l));
		if (!lines.length) return 0;
		fl.state.approvedPlan = `${fl.state.approvedPlan ?? ""}\n\n## ${heading}\n${lines.join("\n")}`;
		refreshChecklist();
		planMilestone(ctx);
		persist();
		return lines.length;
	}

	/** A pass that questions the plan, without a blocker: minor flaws are noted, major ones go to the arbiter. Never asks the user. */
	async function settlePlanFlawOnPass(ctx: ExtensionContext, report: string, diff: Diff, route: "arbiter" | "note"): Promise<"continue" | "amended"> {
		const heading = "Plan choices upheld at a pass";
		if (route === "arbiter") {
			const outcome = await runArbiter(ctx, report, diff, false);
			if (outcome !== "ask") return outcome;
			const n = notePlanFlaws(ctx, report, heading);
			fl.state.unresolvedPlanFlaws = (fl.state.unresolvedPlanFlaws ?? 0) + n;
			persist();
			if (n > 0) ctx.ui.notify(`workflow: the arbiter did not settle ${n} plan flaw(s); noted in the plan, continuing`, "warning");
			return "continue";
		}
		const n = notePlanFlaws(ctx, report, heading);
		if (n > 0) ctx.ui.notify(`workflow: the judge passed but questions the plan (${n} plan flaw(s)); noted in the plan, continuing`, "info");
		return "continue";
	}

	/** Runs the arbiter on the judge's plan-flaw report. "ask" means it could not or may not decide. */
	async function runArbiter(ctx: ExtensionContext, report: string, diff: Diff, canAsk = true): Promise<"continue" | "amended" | "ask"> {
		ctx.ui.setWorkingMessage("arbiter checking the plan…");
		let text: string;
		try {
			const { result, run } = await runRole(fl, "arbiter", "plan-flaw", {
				systemPrompts: [...(diff.multi ? [prompts.repoNote(repoRoots(diff))] : []), prompts.ARBITER, `## Approved plan\n\n${planForJudge(fl)}`, `## Judge report\n\n${report}`, `## Diff\n\n${fitDiffs(diff.parts, loadAgentsConfig().config.judge.maxDiffChars)}`],
				tools: fl.cfg.arbiter.tools,
				task: "Decide on the [plan] findings of the judge report in your system prompt.",
				cwd: ctx.cwd,
			});
			if (!result.ok) {
				ctx.ui.notify(`workflow: arbiter failed: ${result.error}`, "error");
				return "ask";
			}
			text = result.text;
			fl.view.finish(run, true, parseArbiter(text)?.decision ?? "no decision");
		} finally {
			ctx.ui.setWorkingMessage();
		}
		const d = parseArbiter(text);
		if (!d) {
			ctx.ui.notify("workflow: the arbiter gave no decision", "warning");
			return "ask";
		}
		if (d.decision === "KEEP") {
			fl.state.approvedPlan = `${fl.state.approvedPlan ?? ""}\n\n## Plan choices upheld by the arbiter\n${d.reason}`;
			refreshChecklist();
			planMilestone(ctx);
			persist();
			pi.sendMessage({ customType: "workflow-judge", content: `**Arbiter: the plan stands.**\n\n${d.reason}`, display: true }, { triggerTurn: false });
			return "continue";
		}
		if (d.decision === "REVISE") {
			const done = fl.state.planRevisions ?? 0;
			if (done >= fl.cfg.maxPlanRevisions) {
				ctx.ui.notify(`workflow: the plan was already amended ${done} time(s); ${canAsk ? "asking you" : "noting the flaws"} instead`, "warning");
				return "ask";
			}
			fl.state.planRevisions = done + 1;
			fl.state.approvedPlan = `${fl.state.approvedPlan ?? ""}\n\n## Amendment ${nextAmendmentNumber(fl)} (arbiter)\n${d.amendment}`;
			refreshChecklist();
			planMilestone(ctx);
			persist();
			pi.sendMessage(
				{
					customType: "workflow-amend",
					content: `${report}\n\n**Arbiter: the plan is amended.**\n\n${d.reason}\n\n${d.amendment}\n\nImplement this amendment exactly, fix the other blocker and major findings above, then call judge again.`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return "amended";
		}
		ctx.ui.notify(`workflow: the arbiter hands this to you: ${d.reason.split("\n")[0]}`, "info");
		return "ask";
	}

	/** A pass with findings goes back for a fix round, up to maxMinorRounds. True if it sent the fix message. */
	function fixMinorFindings(text: string, hash: string, report?: string): boolean {
		const parsed = parseFindings(text);
		const findings = fixableFindings(parsed);
		// Same diff as the last fix message: the executor skipped the findings, so don't ask again.
		if (fl.state.minorSentFor === hash) return false;
		if (afterPass(findings, fl.state.minorRounds ?? 0, fl.cfg.maxMinorRounds) !== "fix") return false;
		fl.state.minorRounds = (fl.state.minorRounds ?? 0) + 1;
		fl.state.minorSentFor = hash;
		// Remember the passed tree: a fix that touches only the cited files passes without another review.
		const passedRepos = fl.state.lastJudge?.hash === hash ? fl.state.lastJudge.repos : undefined;
		fl.state.minorFix = passedRepos ? { trees: Object.fromEntries(Object.entries(passedRepos).map(([k, v]) => [k, v.tree])), cited: citedPaths(parsed), text } : undefined;
		persist();
		const shown = report ?? `**Judge: PASS**\n\n${text}`;
		handover(
			"workflow-fix",
			prompts.minorFixMessage(shown, findings),
		);
		return true;
	}

	/** Remembers a passed diff's flow as ended, so later runs on the same diff don't end another one. */
	function markPassSummarized(hash: string): void {
		fl.state.summarizedPasses = [...(fl.state.summarizedPasses ?? []).filter((h) => h !== hash), hash].slice(-20);
	}

	/** What the stage delivered in each changed repo, read from git and gh: the branch, the commits since the review base, and the pull request if there is one. */
	async function stageOutcomeText(ctx: ExtensionContext, diff: Diff): Promise<string> {
		const changed = diff.repos.filter((r) => r.changed);
		const repos = changed.length ? changed : diff.repos;
		await ensureGh(ctx).catch(() => false);
		const parts = await Promise.all(
			repos.map(async (ref) => {
				const branch = (await git(fl, ref.dir, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || "HEAD";
				const base = fl.state.reviewBase?.[repoKey(ref.root)];
				const counted = base ? await git(fl, ref.dir, "rev-list", "--count", `${base}..HEAD`) : undefined;
				const n = counted?.code === 0 ? Number(counted.stdout.trim()) : undefined;
				let text = `${branch}${n === undefined ? "" : `, ${n} commit${n === 1 ? "" : "s"} since the review base`}`;
				const jm = fl.state.judgedMerges?.[repoKey(ref.root)];
				const merged = mergedInStage(jm, fl.state.stage) ? jm?.pr : undefined;
				const slug = await originRepo(defaultRunner, ref.dir);
				const pr = await defaultRunner("gh", ["pr", "view", ...(merged ? [merged] : []), ...(slug ? ["-R", slug] : []), "--json", "number,state,url"], ref.dir);
				if (pr.code === 0) {
					try {
						const j = JSON.parse(pr.stdout) as { number?: unknown; state?: unknown; url?: unknown };
						if (typeof j.number === "number") text += `, PR #${j.number} ${String(j.state ?? "")} ${String(j.url ?? "")}`.trimEnd();
					} catch {}
				}
				return diff.multi ? `${path.basename(ref.root)}: ${text}` : text;
			}),
		);
		return parts.join("; ");
	}

	/** Whether a merge is due at this point of the flow: the plan is not staged or this is its last stage, or a merge was planned or approved for this stage. */
	function mergeDue(): boolean {
		const staged = currentStages();
		return !staged || staged.current >= staged.stages.length || deliverMergeOpen(fl.state.approvedPlan ?? "", fl.state.checklist, staged.current) || mergeApproved();
	}

	/** Whether the latest merge decision that covers this stage (or the whole flow) allows a merge. */
	function mergeApproved(): boolean {
		const stage = currentStages()?.current ?? 0;
		const mine = mergeDecisions(fl.state.approvedPlan).filter((d) => d.stage === 0 || d.stage === stage);
		return mine.length > 0 && mine[mine.length - 1].allowed;
	}

	/** The refusal of a merge or protected push before the end of the flow (the gate's rules), or null when it is allowed. */
	function midFlowMergeRefusal(): string | null {
		const staged = currentStages();
		const open = gateOpenSteps(fl.state.approvedPlan ?? "", fl.state.checklist, staged ? { current: staged.current, total: staged.stages.length } : undefined);
		return midFlowMergeProblem({
			staged: !!staged,
			current: staged?.current,
			total: staged?.stages.length,
			openSteps: open,
			deliverMergeOpen: deliverMergeOpen(fl.state.approvedPlan ?? "", fl.state.checklist, staged?.current),
			approved: mergeApproved(),
		});
	}

	/** Records a merge decision in the approved plan, tells the user in chat and with a notification. */
	function recordMergeDecision(ctx: ExtensionContext, by: "arbiter" | "user", allowed: boolean, reason: string, shown?: string): void {
		const stage = currentStages()?.current ?? 0;
		fl.state.approvedPlan = `${fl.state.approvedPlan ?? ""}\n\n${mergeAmendment(nextAmendmentNumber(fl), { by, allowed, stage, reason })}`;
		refreshChecklist();
		planMilestone(ctx);
		persist();
		const head = by === "arbiter" ? `Arbiter: merge ${allowed ? "allowed" : "refused"} before the end of the flow` : `You ${allowed ? "allowed" : "refused"} a merge before the end of the flow`;
		pi.sendMessage({ customType: "workflow-judge", content: `**${head}**\n\n${shown ?? reason}`, display: true }, { triggerTurn: false });
		ctx.ui.notify(`workflow: ${head}: ${reason.split("\n")[0]}`, "info");
	}

	/** The changed repos of a passed diff with a remote whose work is not pushed yet, by folder name, with the reason. */
	async function unpushedRepos(diff: Diff): Promise<string[]> {
		const out: string[] = [];
		for (const ref of diff.repos.filter((r) => r.changed)) {
			if (!(await git(fl, ref.dir, "remote")).stdout.trim()) continue;
			const dirty = (await git(fl, ref.dir, "status", "--porcelain")).stdout.trim() !== "";
			const up = await git(fl, ref.dir, "rev-parse", "--abbrev-ref", "@{u}");
			const hasUpstream = up.code === 0;
			const ahead = hasUpstream ? Number((await git(fl, ref.dir, "rev-list", "--count", "@{u}..HEAD")).stdout.trim()) || 0 : 0;
			const why = unpushedReason({ dirty, hasUpstream, ahead });
			if (why) out.push(`${path.basename(ref.root)} (${why})`);
		}
		return out;
	}

	/** Whether some repo of the flow has a remote, so a pull request can be merged. */
	async function flowHasRemote(ctx: ExtensionContext): Promise<boolean> {
		const remotes = await Promise.all((await flowRepos(fl, ctx)).map((r) => git(fl, r.dir, "remote")));
		return remotes.some((r) => r.stdout.trim() !== "");
	}

	/** The changed repos of a passed diff that have a remote but no judged merge yet, by folder name: the executor still has to merge. Empty when the plan says no merge. */
	async function unmergedRepos(diff: Diff): Promise<string[]> {
		if (noMerge(fl.state.approvedPlan ?? "")) return [];
		const out: string[] = [];
		for (const ref of diff.repos.filter((r) => r.changed)) {
			const jm = fl.state.judgedMerges?.[repoKey(ref.root)];
			if (mergedInStage(jm, fl.state.stage)) {
				// The gate records a merge before the command runs; it counts only once the pull request is MERGED (gh unreadable: believe it).
				if (!jm?.pr) continue;
				const slug = await originRepo(defaultRunner, ref.dir);
				const view = await defaultRunner("gh", ["pr", "view", jm.pr, ...(slug ? ["-R", slug] : []), "--json", "state"], ref.dir);
				let state2 = "MERGED";
				try {
					if (view.code === 0) state2 = String(JSON.parse(view.stdout).state);
				} catch {}
				if (state2 === "MERGED") continue;
			}
			if (!(await git(fl, ref.dir, "remote")).stdout.trim()) continue;
			out.push(path.basename(ref.root));
		}
		return out;
	}

	/**
	 * The judge passed and nothing is left to fix. A stage with steps still open gets one reminder per pass; then the stage ends: the review base
	 * moves up to the passed tree, and the next stage starts, or the flow ends. `report` is a verdict the executor has not seen yet.
	 */
	async function stageDone(ctx: ExtensionContext, diff: Diff, report?: string): Promise<void> {
		const hash = diff.hash;
		if (report) pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
		const staged = currentStages();
		if (fl.state.summarizedPasses?.includes(hash)) {
			// A staged plan's stage added nothing to the diff that was already passed.
			if (staged) await noChangeTurn(ctx, staged);
			return;
		}
		const open = (fl.state.checklist ?? []).filter((i) => !isHuman(i) && !i.done && (!staged || i.stage === undefined || i.stage === staged.current));
		const due = mergeDue();
		const unmerged = due ? await unmergedRepos(diff) : [];
		const unpushed = due || noMerge(fl.state.approvedPlan ?? "") ? [] : await unpushedRepos(diff);
		if (stageEndAction({ openSteps: open.length + (unmerged.length || unpushed.length ? 1 : 0), nudgedFor: fl.state.stageNudgedFor, hash }) === "nudge") {
			fl.state.stageNudgedFor = hash;
			persist();
			const lines: string[] = [];
			const afterOnly = open.length > 0 && open.every((i) => afterMergeStep(fl.state.approvedPlan ?? "", i.id));
			const openLine = open.length ? `Open steps ${open.map((i) => i.id).join(", ")}: finish them (merge, publish), tick them with plan_check, then end your turn.` : "";
			if (openLine && !afterOnly) lines.push(openLine);
			if (unpushed.length) lines.push(`The judge passed: commit and push ${unpushed.join(", ")}, then end your turn.`);
			if (unmerged.length) lines.push(`The judge passed: merge the pull request (gh pr merge, as its own command)${unmerged.length > 1 || diff.multi ? ` in ${unmerged.join(", ")}` : ""}, then end your turn.`);
			if (openLine && afterOnly) lines.push(openLine);
			handover("workflow-open-steps", lines.join("\n"));
			return;
		}
		const knowledge = fl.state.lastKnowledge?.hash === hash ? fl.state.lastKnowledge : undefined;
		if (knowledge && knowledge.status !== "checked") ctx.ui.notify(`workflow: judge passed without the knowledge check: ${knowledge.reason}`, "warning");
		let outcome = { text: await stageOutcomeText(ctx, diff), ok: true };
		const cps = stageCheckpoints(fl);
		if (cps.length) outcome = { text: withCheckpoints(cps.map((c) => c.text), outcome.text), ok: cps.every((c) => c.ok) };
		markPassSummarized(hash);
		await advanceReviewBase(fl, ctx);
		fl.state.minorRounds = 0;
		fl.state.minorSentFor = undefined;
		fl.state.minorFix = undefined;
		fl.state.stageNudgedFor = undefined;
		if (staged) {
			fl.state.stageOutcomes = [...(fl.state.stageOutcomes ?? []), outcome];
			if (staged.current < staged.stages.length) {
				startNextStage(ctx, staged.stages, outcome.text);
				return;
			}
			outcome = stagesOutcome(fl.state.stageOutcomes, staged.stages.length);
		}
		const decided = mergeDecisionsText(fl.state.approvedPlan);
		if (decided) outcome = { ...outcome, text: `${outcome.text}; ${decided}` };
		fl.state.planFlaw = undefined;
		fl.state.stage = undefined;
		fl.state.stageOutcomes = undefined;
		fl.view.stage = "execute";
		if (!summarizeFlow(outcome.text, outcome.ok)) persist();
		await endFlow(ctx);
	}

	/** Folders from --add-dir join the session's list (existing folders only, no repeats, not the working folder). */
	function applyAddDir(ctx: ExtensionContext): void {
		const wanted = parseAddDir(pi.getFlag("add-dir"));
		if (wanted.length === 0) return;
		const folders = [...(fl.state.folders ?? [])];
		let changed = false;
		for (const w of wanted) {
			const abs = path.resolve(ctx.cwd, w).replace(/\\/g, "/");
			const key = repoKey(abs);
			let ok = false;
			try {
				ok = fs.statSync(abs).isDirectory();
			} catch {
				// not there
			}
			if (!ok) ctx.ui.notify(`workflow: --add-dir ${w}: not a folder, skipped`, "warning");
			else if (key === repoKey(ctx.cwd)) ctx.ui.notify(`workflow: --add-dir ${w}: that is the working folder, skipped`, "warning");
			else if (!folders.some((f) => repoKey(f) === key)) {
				folders.push(abs);
				changed = true;
			}
		}
		if (!changed) return;
		fl.state.folders = folders;
		persist();
		publishFolders(ctx);
	}

	/** K1b: after the session moved to another checkout of the same projects, added folders move to the matching checkouts next to the working folder. */
	async function followWorkingFolder(ctx: ExtensionContext): Promise<void> {
		const folders = fl.state.folders ?? [];
		if (!folders.length) return;
		const newest = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === FOLDERS_ENTRY)
			.pop() as { data?: { cwd?: unknown } } | undefined;
		const prev = newest?.data?.cwd;
		if (typeof prev !== "string" || repoKey(prev) === repoKey(ctx.cwd)) return;
		const top = await gitRoot(fl, ctx.cwd);
		if (!top) return;
		const infos = new Map<string, { top: string; worktrees: string[] }>();
		for (const f of folders) {
			const t = await gitRoot(fl, f);
			if (!t) continue;
			const r = await git(fl, t, "worktree", "list", "--porcelain");
			if (r.code === 0) infos.set(repoKey(f), { top: t, worktrees: parseWorktreeList(r.stdout) });
		}
		const res = followFolders(folders, ctx.cwd.replace(/\\/g, "/"), top, (f) => infos.get(repoKey(f)) ?? null, (p) => fs.existsSync(p));
		if (!res.changes.length && res.folders.length === folders.length) return;
		fl.state.folders = res.folders;
		persist();
		for (const c of res.changes) ctx.ui.notify(`workflow: added folders follow the working folder: ${c.from} \u2192 ${c.to}`, "info");
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload") fl.metrics.clear();
		const loaded = loadConfig();
		fl.cfg = loaded.config;
		fl.configError = loaded.error;
		if (fl.configError) ctx.ui.notify(`workflow: bad config, using defaults: ${fl.configError}`, "error");
		// One warning per session for old keys (the removed judge role and quick flow); a /flow reload shows it again.
		if (loaded.warning && loaded.warning !== fl.configWarning) ctx.ui.notify(`workflow: ${loaded.warning}`, "warning");
		fl.configWarning = loaded.warning;
		void ensureGh(ctx).catch(() => false);

		const saved = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === STATE_ENTRY)
			.pop() as { data?: FlowState } | undefined;

		if (saved?.data) {
			// Pi restores the session's model itself; only the tool set needs re-applying.
			fl.state = migrateSavedState({ ...saved.data }) as FlowState;
			if (fl.state.tokenUnit !== "both") {
				// Saved before counts carried both raw and cost-weighted totals; the old ones would mislead.
				fl.state.tokens = undefined;
				fl.state.flow = undefined;
				fl.state.flowStarted = undefined;
			}
			fl.view.used = { ...emptyStageTokens(), ...fl.state.tokens };
			fl.view.flow = { ...emptyFlowUsage(), ...structuredClone(fl.state.flow) };
			fl.view.flowStarted = fl.state.flowStarted;
			if (fl.state.phase === "discuss" || fl.state.phase === "plan") blockPlanTools();
			else syncFlowOnlyTools(pi, fl.state.phase);
			if (event.reason !== "reload") {
				await followWorkingFolder(ctx);
				// --add-dir is a launch flag: only the first session of the process applies it, not a later switch or resume.
				if (event.reason === "startup") applyAddDir(ctx);
				publishFolders(ctx);
			}
			updateStatus(ctx);
			if (fl.state.phase === "execute" && fl.state.waiting) startWaitTimer();
			if (event.reason !== "reload") void planHousekeeping(ctx);
			// Rewrites the plan file, which also (re)starts this session's claim on an unfinished flow.
			if (fl.state.planDoc && !fl.state.planDoc.finished && fl.state.approvedPlan) planMilestone(ctx, undefined, false);
			return;
		}
		if (event.reason === "reload") return;

		const flag = pi.getFlag("flow");
		const start = (typeof flag === "string" && ["discuss", "plan", "execute", "off"].includes(flag) ? flag : fl.cfg.startPhase) as Phase;
		fl.state = { phase: "off", escalated: false, judgeRounds: 0 };
		fl.view.used = emptyStageTokens();
		fl.view.flow = emptyFlowUsage();
		fl.view.flowStarted = undefined;
		applyAddDir(ctx);
		publishFolders(ctx);
		if (start === "off" || !(await setPhase(ctx, start))) updateStatus(ctx);
		void planHousekeeping(ctx);
	});

	// K2: a session that is executing an approved plan is not switched away from.
	pi.on("session_before_switch", async (_event, ctx) => {
		if (!(fl.state.phase === "execute" && fl.state.approvedPlan)) return;
		ctx.ui.notify("workflow: a flow is executing; finish it or leave it with /flow off before switching sessions", "warning");
		return { cancel: true };
	});

	// Explore, advisor and test_run run in the agents extension; a flow counts their usage and metrics.
	pi.events.on("agents:subagent-finished", (data: unknown) => {
		const c = countSubagent(data, fl.state.phase, fl.view.stage);
		if (!c) return;
		fl.view.addFinished(c.event.role as SubRole, c.event.model, c.event.usage);
		recordMetric(c.metric);
		if (c.resetErrors) fl.consecutiveErrors = 0;
	});

	pi.on("session_shutdown", async () => {
		if (fl.notify.idleTimer) clearTimeout(fl.notify.idleTimer);
		fl.notify.idleTimer = undefined;
		stopWaitTimer();
		const dir = fl.claim.claimedFlow ? fl.plan.planDirs.get(fl.claim.claimedFlow) : undefined;
		if (dir && fl.claim.claimedFlow) dropClaim(dir, fl.claim.claimedFlow);
		stopClaimTimer();
		stopLiveTimer();
	});

	// ----------------------------------------------------------------------
	// /flow
	// ----------------------------------------------------------------------

	function statusText(): string {
		const lines = [
			`phase      ${fl.state.phase}${fl.state.escalated ? " (escalated)" : ""}`,
			`judge     ${fl.state.judgeRounds} failed round(s); auto=${fl.cfg.autoJudge}; ${noMerge(fl.state.approvedPlan ?? "") ? "no merge (the plan says so)" : "merge and publish after a judge pass"}`,
			...(currentStages() ? [`stage     ${currentStages()!.current} of ${currentStages()!.stages.length}: ${currentStages()!.stages[currentStages()!.current - 1].title}`] : []),
			fl.state.planFlaw === "auto" ? "flaws     arbiter (this flow)" : `flaws     ${fl.cfg.planFlaw === "auto" ? "arbiter" : "ask"} (config)`,
			`autopilot ${autopilotOn() ? "on" : "off"} (${fl.autopilotOverride === undefined ? "config" : "session"})`,
			`guard     compact at ${fl.cfg.contextGuardTokens || "off"} tokens`,
			`tokens    ${STAGES.filter((s) => !["discuss", "commit"].includes(s) || fl.view.sessionTokens(s).raw + fl.view.sessionTokens(s).cost > 0).map((s) => `${s} ${fmtTok(fl.view.sessionTokens(s))}`).join(" · ")} · session total ${fmtTok(STAGES.reduce((n, s) => ({ raw: n.raw + fl.view.sessionTokens(s).raw, cost: n.cost + fl.view.sessionTokens(s).cost }), { raw: 0, cost: 0 }))}`,
			"",
			...MODEL_ROLES.map((r) => `${r.padEnd(9)} ${describeRole(roleSpecOf(fl, r))}`),
			`${AGENT_ROLES.join(", ")}: /agents model (judge ${describeRole(modelOf(fl, "judge"))}, critic ${describeRole(modelOf(fl, "critic"))})`,
			"",
			`config    ${CONFIG_PATH}${fs.existsSync(CONFIG_PATH) ? "" : " (not created, using defaults)"}`,
		];
		if (fl.configError) lines.push(`error     ${fl.configError}`);
		return lines.join("\n");
	}

	pi.registerCommand("folders", {
		description: foldersDescription(),
		getArgumentCompletions: (prefix) =>
			foldersCompletions(prefix, {
				cwd: fl.lastCtx?.cwd ?? process.cwd(),
				home: os.homedir(),
				readDirs: (dir) => {
					try {
						return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
					} catch {
						return null;
					}
				},
				folders: fl.state.folders ?? [],
			}),
		handler: async (args, ctx) => {
			const m = args.trim().match(/^(\S+)\s*([\s\S]*)$/);
			const sub = (m?.[1] ?? "list").toLowerCase();
			const arg = (m?.[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
			const folders = fl.state.folders ?? [];
			if (sub === "list") {
				const lines = [`working folder  ${ctx.cwd}`];
				for (const [i, f] of folders.entries()) {
					const note = !fs.existsSync(f) ? " (missing)" : (await gitRoot(fl, f)) ? "" : " (not a git repo)";
					lines.push(`${i + 1}. ${f}${note}`);
				}
				for (const t of fl.state.touchedRepos ?? []) lines.push(`   ${t} (edited in this flow)`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (!isKnown(FOLDERS_SUBS, sub)) {
				ctx.ui.notify(foldersUsage(), "warning");
				return;
			}
			if (!arg) {
				ctx.ui.notify(`Usage: /folders ${sub} ${sub === "remove" ? "PATH or N" : "PATH"}`, "warning");
				return;
			}
			if (sub === "add") {
				const abs = path.resolve(ctx.cwd, arg).replace(/\\/g, "/");
				let isDir = false;
				try {
					isDir = fs.statSync(abs).isDirectory();
				} catch {
					// not there
				}
				if (!isDir) {
					ctx.ui.notify(`workflow: ${abs} is not a folder`, "warning");
					return;
				}
				if (repoKey(abs) === repoKey(ctx.cwd)) {
					ctx.ui.notify("workflow: that is already the working folder", "warning");
					return;
				}
				if (folders.some((f) => repoKey(f) === repoKey(abs))) {
					ctx.ui.notify(`workflow: ${abs} is already added`, "warning");
					return;
				}
				const answer = await askFolderAdd((d) => pi.events.emit("workflow:folder-add", d), ctx.cwd.replace(/\\/g, "/"), abs);
				if ("error" in answer) {
					ctx.ui.notify(`workflow: ${abs} not added: ${answer.error}`, "error");
					return;
				}
				let final = abs;
				if (repoKey(answer.folder) !== repoKey(abs)) {
					final = path.resolve(ctx.cwd, answer.folder).replace(/\\/g, "/");
					let finalIsDir = false;
					try {
						finalIsDir = fs.statSync(final).isDirectory();
					} catch {
						// not there
					}
					if (!finalIsDir) {
						ctx.ui.notify(`workflow: ${final} is not a folder`, "warning");
						return;
					}
					if (repoKey(final) === repoKey(ctx.cwd)) {
						ctx.ui.notify("workflow: that is already the working folder", "warning");
						return;
					}
				}
				const current = fl.state.folders ?? [];
				if (current.some((f) => repoKey(f) === repoKey(final))) {
					ctx.ui.notify(`workflow: ${final} is already added`, "warning");
					return;
				}
				fl.state.folders = [...current, final];
				const addedRoot = await gitRoot(fl, final);
				if (addedRoot) await joinReviewBase(fl, addedRoot);
				persist();
				publishFolders(ctx);
				updateStatus(ctx);
				ctx.ui.notify(final === abs ? `workflow: added ${abs}; reloading` : `workflow: added ${final} (for ${abs}); reloading`, "info");
			} else {
				const n = /^\d+$/.test(arg) ? Number(arg) - 1 : -1;
				const i = n >= 0 ? n : folders.findIndex((f) => repoKey(f) === repoKey(path.resolve(ctx.cwd, arg)));
				if (i < 0 || i >= folders.length) {
					const touched = (fl.state.touchedRepos ?? []).some((t) => repoKey(t) === repoKey(path.resolve(ctx.cwd, arg)));
					ctx.ui.notify(touched ? "workflow: that repo was edited in this flow; it leaves when the flow ends" : `workflow: ${arg} is not in the folder list`, "warning");
					return;
				}
				const [gone] = folders.splice(i, 1);
				fl.state.folders = folders;
				persist();
				publishFolders(ctx);
				updateStatus(ctx);
				ctx.ui.notify(`workflow: removed ${gone}; reloading`, "info");
			}
			await ctx.waitForIdle();
			await ctx.reload();
		},
	});

	pi.registerCommand("flow", {
		description: "Plan -> execute -> judge workflow with a model per role",
		getArgumentCompletions: (prefix) => flowCompletions(prefix, { roles: MODEL_ROLES, specOf: (r) => roleSpecOf(fl, r), models: () => fl.lastCtx?.modelRegistry.getAvailable() ?? [] }),
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (sub.toLowerCase()) {
				case "status":
					ctx.ui.notify(statusText(), "info");
					return;
				case "discuss":
				case "plan":
				case "execute":
				case "off": {
					if (sub.toLowerCase() === "plan" && rest[0]?.toLowerCase() === "force") {
						if (fl.state.phase !== "discuss") {
							ctx.ui.notify("workflow: /flow plan force works only in discuss", "warning");
							return;
						}
						const list = lastAgreedList(branchAssistantTexts(ctx.sessionManager.getBranch()));
						const hash = list ? textHash(list) : "";
						await moveToPlan(ctx, forcedOpenFindings(fl.state.discussionReview, hash));
						return;
					}
					if (sub.toLowerCase() === "plan" && fl.state.phase === "discuss" && (await startDiscussionGate(ctx))) return;
					const from = fl.state.phase;
					if (!(await setPhase(ctx, sub.toLowerCase() as Phase))) return;
					ctx.ui.notify(`workflow: ${fl.state.phase}`, "info");
					if (from === "discuss" && fl.state.phase === "plan") sendPlanKickoff();
					return;
				}
				case "approve":
					if (fl.state.phase === "discuss") {
						if (await startDiscussionGate(ctx)) return;
						ctx.ui.notify("workflow: discuss phase; moving to planning first", "info");
						await setPhase(ctx, "plan");
						sendPlanKickoff();
						return;
					}
					await approve(ctx);
					return;
				case "resume":
					await resumeFlow(ctx, rest[0]);
					return;
				case "board": {
					let rows = await collectBoard(fl, ctx);
					if ((ctx as { mode?: string }).mode !== "tui" || !ctx.hasUI) {
						ctx.ui.notify(boardLines(rows, -1, 200, Date.now()).join("\n"), "info");
						return;
					}
					let stop = () => {};
					try {
					await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
						let selected = 0;
						let detail = false;
						let busy = false;
						let closed = false;
						const timer = setInterval(() => {
							if (busy || closed) return;
							busy = true;
							collectBoard(fl, ctx)
								.then((r) => {
									if (closed) return;
									rows = r;
									selected = Math.min(selected, Math.max(0, rows.length - 1));
									tui.requestRender();
								})
								.catch(() => {})
								.finally(() => {
									busy = false;
								});
						}, 2_000);
						timer.unref?.();
						stop = () => {
							closed = true;
							clearInterval(timer);
						};
						const close = () => {
							stop();
							done(undefined);
						};
						return {
							render(width: number): string[] {
								const now = Date.now();
								const body = detail && rows[selected] ? detailLines(rows[selected], width, now) : boardLines(rows, selected, width, now);
								return [theme.fg("accent", `flow board · ${rows.length} flows`), ...body, theme.fg("dim", "↑↓ select · enter details · esc back/close · refreshes every 2s")].map((l) => truncateToWidth(l, width));
							},
							handleInput(data: string): void {
								if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
								else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(Math.max(0, rows.length - 1), selected + 1);
								else if (keybindings.matches(data, "tui.select.confirm")) {
									if (rows.length) detail = true;
								} else if (keybindings.matches(data, "tui.select.cancel")) {
									if (detail) detail = false;
									else {
										close();
										return;
									}
								} else return;
								tui.requestRender();
							},
							invalidate() {},
						};
					}, { overlay: true });
					} finally {
						stop();
					}
					return;
				}
				case "autopilot": {
					const arg = rest[0]?.toLowerCase();
					if (arg !== undefined && arg !== "on" && arg !== "off") {
						ctx.ui.notify("usage: /flow autopilot [on|off]", "warning");
						return;
					}
					fl.autopilotOverride = arg === undefined ? !autopilotOn() : arg === "on";
					updateStatus(ctx);
					ctx.ui.notify(`workflow: autopilot ${autopilotOn() ? "on" : "off"} (session)`, "info");
					return;
				}
				case "escalate":
				case "fable":
					await escalate(ctx);
					return;
				case "back":
				case "opusplan":
					await deescalate(ctx);
					return;
				case "critic":
					if (rest[0]?.toLowerCase() === "cancel") {
						if (fl.gateRun) abortGate(fl, "command");
						else ctx.ui.notify("workflow: no critic review running", "info");
						return;
					}
					if (fl.state.phase === "discuss") {
						if (askRestate(ctx, false)) return;
						await runDiscussionGate(ctx, "full", false);
					} else if (fl.state.phase === "plan") criticPlanNow(ctx);
					else ctx.ui.notify("workflow: /flow critic reviews the discussion (discuss) or the plan (plan); to review code, use the judge tool", "info");
					return;
				case "tokens":
					if (!fl.view.hasFlowUsage()) {
						ctx.ui.notify("workflow: no tokens spent in this flow yet", "info");
						return;
					}
					pi.appendEntry(SUMMARY_ENTRY, { ...fl.view.peekFlow(`stage ${fl.view.stage}`, true), title: "flow so far" });
					return;
				case "reload": {
					const loaded = loadConfig();
					fl.cfg = loaded.config;
					fl.configError = loaded.error;
					fl.configWarning = loaded.warning;
					if (fl.configWarning) ctx.ui.notify(`workflow: ${fl.configWarning}`, "warning");
					updateStatus(ctx);
					ctx.ui.notify(fl.configError ? `workflow: ${fl.configError}` : statusText(), fl.configError ? "error" : "info");
					return;
				}
				case "model": {
					let [role, spec] = rest;
					const usage = () => ctx.ui.notify(`Usage: /flow model <${MODEL_ROLES.join("|")}> <provider/id[:thinking]>`, "warning");
					if (role && (AGENT_ROLES as readonly string[]).includes(role)) {
						ctx.ui.notify(`workflow: ${role} belongs to the agents extension; use /agents model ${role}`, "warning");
						return;
					}
					if (!role && ctx.hasUI) {
						const pick = await ctx.ui.select("Role", MODEL_ROLES.map((r) => `${r} (${describeRole(roleSpecOf(fl, r))})`));
						if (!pick) return;
						role = pick.split(" ")[0];
					}
					if (!role || !MODEL_ROLES.includes(role)) {
						usage();
						return;
					}
					if (!spec && !ctx.hasUI) {
						usage();
						return;
					}
					const parsed = spec ? parseRoleSpec(spec) : await pickRoleSpec(ctx.ui, role, roleSpecOf(fl, role), () => ctx.modelRegistry.getAvailable());
					if (!parsed) return;
					if (typeof parsed === "string") {
						ctx.ui.notify(`workflow: ${parsed}`, "error");
						return;
					}
					saveRole(role as Role, parsed);
					fl.cfg = loadConfig().config;
					const live = fl.state.escalated ? role === "escalate" : fl.state.phase !== "off" && role === fl.state.phase;
					if (live) await applyRole(ctx, role as Role);
					updateStatus(ctx);
					ctx.ui.notify(`workflow: ${role} -> ${describeRole(parsed)} (saved to workflow.json)`, "info");
					return;
				}
				default:
					ctx.ui.notify(FLOW_UNKNOWN(sub), "warning");
			}
		},
	});

	Object.assign(fl.legacy, { currentStages, gitEnv, judgeOnce, persist, planDirFor, planFilePath, recordMetric, trimPlan });
}
