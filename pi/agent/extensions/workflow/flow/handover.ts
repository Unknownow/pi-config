/** The end of a run: handover messages, onAgentEnd, stage moves, the no-change turns and the gh lookup (ensureGh). */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeRole } from "../../shared/roles.ts";
import { handoverAction, handoverKind, shouldResume, addPlanReply, canApprove, composePlan, approvalBlock, skipJudge, planFlawOnPass, noChangeStage } from "../agent-end.ts";
import * as prompts from "../prompts.ts";
import { lastAgreedList } from "../discussion-review.ts";
import { discussionGateAfterFixReply, textHash, planGateDecide, planDisputes, planOfferAction, isClean, parseFindings } from "../gates.ts";
import { ghCandidates, withPathDir } from "../gh-path.ts";
import { isHuman } from "../plan-doc.ts";
import { readOnlyProblem } from "../../shared/readonly-bash.ts";
import { checkpointOutcome, mergeDecisionsText } from "../checkpoints.ts";
import { planWaitProblems, parseStages, nextStage, stagesOutcome } from "../stages.ts";
import { assistantText, type Flow } from "./context.ts";
import { collectFlowDiff, markPassed, planCardReady, stageCheckpoints } from "./diff.ts";
import { runDiscussionGate } from "./discussion-gate.ts";
import { fixOrAsk, markPassSummarized, resolvePlanFlaw, reviewDiff, settlePlanFlawOnPass } from "./judge.ts";
import { askUser } from "./notify.ts";
import { approve, autopilotOn, currentStages, deliverHintsText, endFlow, noteAuto, persist, setPhase, summarizeFlow, updateStatus } from "./phase.ts";
import { planMilestone, recordMetric } from "./plan-files.ts";
import { offerPlan, runPlanGate } from "./plan-gate.ts";
import { setWaiting, startWaitTimer } from "./wait-points.ts";

/** Sends a handover now, after compacting the session first when it starts execute or a stage and the context is over the threshold. */
export function deliverHandover(fl: Flow, ctx: ExtensionContext, msg: { customType: string; content: string }, aborted: boolean): void {
	const send = (content: string) => {
		fl.pi.sendMessage({ customType: msg.customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
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
			recordMetric(fl, { kind: "compaction", at: new Date().toISOString(), reason: "handover", tokensBefore: held ?? null, ms: Date.now() - compactStart, ok: true });
			fl.compacting = false;
			fl.guardTokens = null;
			void planCardReady(fl).then((card) => send(`${msg.content}\n\n${card}`));
		},
		onError: (e) => {
			recordMetric(fl, { kind: "compaction", at: new Date().toISOString(), reason: "handover", tokensBefore: held ?? null, ms: Date.now() - compactStart, ok: false, error: e.message });
			fl.compacting = false;
			ctx.ui.notify(`workflow: compaction failed: ${e.message}`, "error");
			send(msg.content);
		},
	});
	return;
}

/** Sends a workflow message that starts the next executor turn. From agent_end it waits for the run to settle, so the session can be compacted first. */
export function handover(fl: Flow, customType: string, content: string, ctx?: ExtensionContext): void {
	if (!fl.inAgentEnd && ctx) {
		deliverHandover(fl, ctx, { customType, content }, false);
		return;
	}
	if (fl.inAgentEnd) {
		fl.pendingHandover = { customType, content };
		return;
	}
	fl.pi.sendMessage({ customType, content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
}

export async function onAgentEnd(fl: Flow, event: { messages: AgentMessage[] }, ctx: ExtensionContext): Promise<void> {
	const last = [...event.messages].reverse().find((m) => m.role === "assistant");

	// "Prompt is too long": pi compacts and retries, but the retry ends on a tool result and the
	// bridge answers it with an empty reply, so the run stops. Ask the model to carry on.
	if (fl.overflowRetry) {
		fl.overflowRetry = false;
		if (shouldResume(true, last, fl.resumes)) {
			fl.resumes++;
			fl.pi.sendMessage(
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
			persist(fl);
			void runDiscussionGate(fl, ctx, "recheck", dr.restateLoop ?? true, false);
		}
		else {
			fl.state.discussionReview = { ...dr, status: "paused" };
			persist(fl);
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
				fl.pi.sendMessage({ customType: "workflow-plan-waits", content: `The plan has wait checks that can't run:\n${fl.planWaitNow.map((p) => `- ${p}`).join("\n")}\nFix them: reply with the whole plan again as a new \`## Plan:\`, the fixed wait checks included. A check is one plain read-only command: no backticks around it, no placeholders like <version>, no command substitution. If a value is only known after an earlier stage (a version a script picks), drop that check or the wait itself.`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
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
				void runPlanGate(fl, ctx, emitted, text, decision);
				return;
			}
			const reused = decision === "reuse" ? fl.state.planGate : undefined;
			const queued = fl.planApproveQueued;
			fl.planApproveQueued = false;
			if (reused && planOfferAction({ clean: isClean(reused.verdict, [...reused.autoFindings, ...reused.userFindings]), queuedGo: queued }) === "approve") {
				ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(fl.cfg.roles.execute)}`, "info");
				await approve(fl, fl.lastCtx ?? ctx);
				return;
			}
			await offerPlan(fl, ctx, blocked);
			return;
		}
		await offerPlan(fl, ctx, blocked);
		return;
	}

	if (fl.state.phase !== "execute") return;
	// Waiting for a person: no judge, no delivery, no stage advance until the wait is over.
	if (fl.state.waiting) return;
	if (!skipJudge(last)) fl.state.autoRetries = 0;
	if (skipJudge(last)) {
		const autoRetry = autopilotOn(fl) && !(fl.state.autoRetries ?? 0);
		if (autoRetry) {
			fl.state.autoRetries = 1;
			noteAuto(fl, "executor error: retried automatically");
			ctx.ui.notify("workflow: autopilot: the executor's reply failed; retrying once", "info");
		}
		const choice = autoRetry ? "Retry" : await askUser(fl, ctx, "The executor's last reply ended in an error", ["Retry", "Back to planning", "Stop"]);
		if (choice === "Retry") {
			fl.pi.sendMessage(
				{ customType: "workflow-retry", content: "Your last reply ended in an error. Continue with the open steps of the approved plan.", display: true },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Back to planning") {
			await setPhase(fl, ctx, "plan");
		} else {
			ctx.ui.notify("workflow: stopped: the executor's reply failed", "warning");
			summarizeFlow(fl, stoppedSummary(fl, "stopped: the executor's reply failed"), false);
			await endFlow(fl, ctx);
		}
		return;
	}
	let rejudge = false;
	if (fl.state.pendingPlanFlaw) {
		// The executor's own judge call questioned the plan; it was told to stop, so the workflow decides.
		const report = fl.state.pendingPlanFlaw;
		fl.state.pendingPlanFlaw = undefined;
		persist(fl);
		const flawed = await collectFlowDiff(fl, ctx);
		if (flawed) {
			if (fl.state.lastJudge?.hash === flawed.hash) {
				const route = planFlawOnPass(parseFindings(report), fl.state.lastJudge.verdict === "PASS" ? "PASS" : "FAIL");
				const outcome = route === "stop" ? await resolvePlanFlaw(fl, ctx, report, flawed) : await settlePlanFlawOnPass(fl, ctx, report, flawed, route);
				if (outcome !== "continue") return;
				if (fl.state.lastJudge.verdict === "PASS") markPassed(fl, flawed.hash);
				else {
					await fixOrAsk(fl, ctx, undefined);
					return;
				}
			} else {
				// The diff changed since that review: drop the stale report and let reviewDiff judge this diff again.
				fl.seenDiffs.delete(flawed.hash);
				rejudge = true;
			}
		}
	}
	await reviewDiff(fl, ctx, rejudge);
}

/** A stage that declares `(after: …)` waits before it starts: keeps its start text until the wait is over. True when it now waits. */
export function holdForStageWait(fl: Flow, ctx: ExtensionContext, stage: ReturnType<typeof parseStages>[number], held: string): boolean {
	if (!stage.after) return false;
	setWaiting(fl, { reason: stage.after.reason, ...(stage.after.check ? { check: stage.after.check } : {}), stage: stage.n, since: new Date().toISOString(), planned: true, atStageStart: true, held });
	persist(fl);
	updateStatus(fl, ctx);
	planMilestone(fl, ctx);
	ctx.ui.notify(`workflow: stage ${stage.n} waits for: ${stage.after.reason}`, "info");
	startWaitTimer(fl);
	return true;
}

/** Staged plan: moves on to the next stage and sends its start message. */
export function startNextStage(fl: Flow, ctx: ExtensionContext, stages: ReturnType<typeof parseStages>, outcome: string): void {
	const next = (fl.state.stage ?? 0) + 1;
	fl.state.stage = next;
	fl.state.judgeRounds = 0;
	fl.state.minorRounds = 0;
	fl.state.minorSentFor = undefined;
	fl.state.minorFix = undefined;
	fl.state.stageJudged = undefined;
	if (fl.state.passedDiff) markPassSummarized(fl, fl.state.passedDiff); // a leftover diff from the stage before is not this stage's
	fl.state.lastJudge = undefined; // a new stage gets a full review, not a re-review of the last one
	fl.state.lastFullPass = undefined;
	fl.view.stage = "execute";
	fl.view.changed();
	planMilestone(fl, ctx);
	persist(fl);
	ctx.ui.notify(`workflow: stage ${next} of ${stages.length}: ${stages[next - 1].title}`, "info");
	const text = nextStage(stages, next, outcome) + deliverHintsText(fl, next);
	if (holdForStageWait(fl, ctx, stages[next - 1], text)) return;
	handover(fl, "workflow-stage", text);
}

/** A staged plan's turn ended with nothing new to review: it ends the stage only if the executor handed it over (judge called) or the user confirms. */
export async function noChangeTurn(fl: Flow, ctx: ExtensionContext, staged: { stages: ReturnType<typeof parseStages>; current: number }): Promise<void> {
	const auto = (fl.cfg.stageAdvance === "auto" || autopilotOn(fl)) && !fl.turnAborted;
	const open = (fl.state.checklist ?? []).filter((i) => !isHuman(i) && !i.done && (i.stage === undefined || i.stage === staged.current)).length;
	const what = noChangeStage(!!fl.state.stageJudged, ctx.hasUI, auto, open);
	if (what === "wait") return;
	if (what === "advance" && auto && !fl.state.stageJudged) ctx.ui.notify(`workflow: stage ${staged.current} ended with no changes; continuing (${fl.cfg.stageAdvance === "auto" ? "stageAdvance: auto" : "autopilot"})`, "info");
	if (what === "ask") {
		const yes = "Mark done and continue";
		if ((await askUser(fl, ctx, `Stage ${staged.current} ended with no changes`, [yes, "Wait"])) !== yes) return;
	}
	await stageWithoutChanges(fl, ctx, staged);
}

/** An unstaged flow whose remaining changes were all delivered by checkpoints: ends it with their outcome. Open steps ask first (and do nothing without a UI). */
export async function flowWithoutChanges(fl: Flow, ctx: ExtensionContext): Promise<void> {
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
	if (!summarizeFlow(fl, decided ? `${outcome.text}; ${decided}` : outcome.text, outcome.ok)) persist(fl);
	await endFlow(fl, ctx);
}

/** A staged plan's stage ended with nothing to review: records it and starts the next stage, or ends the flow after the last one. */
export async function stageWithoutChanges(fl: Flow, ctx: ExtensionContext, staged: { stages: ReturnType<typeof parseStages>; current: number }): Promise<void> {
	const outcome = checkpointOutcome(stageCheckpoints(fl)) ?? { text: "no changes", ok: true };
	fl.state.stageOutcomes = [...(fl.state.stageOutcomes ?? []), outcome];
	if (staged.current < staged.stages.length) {
		startNextStage(fl, ctx, staged.stages, outcome.text);
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
	if (!summarizeFlow(fl, finalText, final.ok)) persist(fl);
	await endFlow(fl, ctx);
}

/** The summary text for a flow that stops early: the stages already delivered, then `text`. Clears the stage state. */
export function stoppedSummary(fl: Flow, text: string): string {
	const staged = currentStages(fl);
	const done = fl.state.stageOutcomes ?? [];
	fl.state.stage = undefined;
	fl.state.stageOutcomes = undefined;
	if (!staged || done.length === 0) return text;
	return `${done.map((p, i) => `stage ${i + 1}: ${p.text}`).join("; ")}; ${text}`;
}

/** Makes `gh` runnable: when it is not on PATH, adds a standard GitHub CLI install folder to this process's PATH. */
export async function ensureGh(fl: Flow, ctx: ExtensionContext): Promise<boolean> {
	const works = async () => {
		try {
			return (await fl.pi.exec("gh", ["--version"], { timeout: 10_000 })).code === 0;
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
