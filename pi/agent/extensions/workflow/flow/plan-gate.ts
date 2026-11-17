/** The plan gate: the approval menu and the automatic plan judge. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeRole } from "../../shared/roles.ts";
import { composePlan } from "../agent-end.ts";
import * as prompts from "../prompts.ts";
import { lastAgreedList, discussionVerdict } from "../discussion-review.ts";
import { branchTranscript } from "../../shared/transcript.ts";
import { textHash, isEscKey, type SpecKind, type Finding, planDisputes, planCriticRequest, type PlanGate, planGateAfterVerdict, isClean, findingText, planOfferAction, planGateDecide } from "../gates.ts";
import { PLAN_APPROVE, PLAN_ARBITER, planMenuRequest, PLAN_BACK } from "../asks.ts";
import { judgeMetric } from "../metrics.ts";
import { type ReviewResult, runCritic } from "../../agents/api.ts";
import type { RunView } from "../../shared/runs.ts";
import { type Flow } from "./context.ts";
import { endReview } from "./judge.ts";
import { abortGate, askUser, lastAssistantText, scheduleIdleNotice } from "./notify.ts";
import { approve, autopilotOn, noteAuto, persist, sendPlanKickoff, setPhase, updateStatus } from "./phase.ts";
import { recordMetric } from "./plan-files.ts";

/** The plan is complete and judged (or the judge is off): the approval menu. */
export async function offerPlan(fl: Flow, ctx: ExtensionContext, blocked: string | undefined): Promise<void> {
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
		await setPhase(fl, ctx, "discuss");
		ctx.ui.notify(`workflow: back to discussion on ${describeRole(fl.cfg.roles.discuss)}`, "info");
		return;
	}
	if (choice === arbiterLabel && fl.cfg.planFlaw === "ask") {
		await approve(fl, ctx, true);
		return;
	}
	if (choice === approveLabel) await approve(fl, ctx);
}

/** The plan judge: one run on a complete plan, then fix (auto findings go to the planner), offer, or approve a queued "go". Runs detached from agent_end and the input hook. */
export async function runPlanGate(fl: Flow, ctx: ExtensionContext, plan: string, text: string, decision: "confirm" | "recheck" | "full"): Promise<void> {
	abortGate(fl, "restart");
	const gate0 = fl.state.planGate;
	const run = { kind: "plan" as const, controller: new AbortController(), judgedHash: textHash(plan) } as NonNullable<typeof fl.gateRun>;
	fl.gateRun = run;
	if (ctx.hasUI) {
		try {
			run.offEsc = ctx.ui.onTerminalInput((d) => (isEscKey(d) ? (abortGate(fl, "esc"), { consume: true }) : undefined));
		} catch {}
	}
	updateStatus(fl, ctx);
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
			mcpServers: fl.pi.getMcpServers(),
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
		updateStatus(fl, ctx);
		try {
			if (ctx.isIdle()) scheduleIdleNotice(fl, ctx);
		} catch {}
	}
	const blank: PlanGate = gate0 ?? { planHash: run.judgedHash, rounds: 0, autoFindings: [], userFindings: [], spec: specKind };
	const stale = fl.state.phase !== "plan" || !fl.planReady || textHash(composePlan(fl.planDraft)) !== run.judgedHash;
	if ((run.reason || stale || (outcome && "error" in outcome)) && outcome?.review) endReview(fl, "critic", outcome.ext, outcome.review, started, false, run.reason ? "cancelled · plan" : stale ? "discarded · plan changed" : `failed · ${outcome.review.error ?? "no result"}`);
	if (run.reason) {
		if (run.reason === "restart") return;
		fl.planApproveQueued = false;
		if ((run.reason === "esc" || run.reason === "command") && !stale) {
			const g: PlanGate = { ...blank, planHash: run.judgedHash, verdict: "cancelled", spec: specKind };
			fl.state.planGate = g;
			persist(fl);
			ctx.ui.notify("workflow: plan critic cancelled", "info");
			await offerPlan(fl, ctx, undefined);
		}
		return;
	}
	if (stale) return;
	if (!outcome || "error" in outcome) {
		const error = outcome && "error" in outcome ? outcome.error : "no result";
		const g: PlanGate = { ...blank, planHash: run.judgedHash, verdict: "error", spec: specKind };
		fl.state.planGate = g;
		persist(fl);
		fl.planApproveQueued = false;
		ctx.ui.notify(`workflow: plan critic did not run: ${error}`, "warning");
		await offerPlan(fl, ctx, undefined);
		return;
	}
	const findings = outcome.findings;
	const verdict = discussionVerdict(outcome.text);
	const confirm = decision === "confirm";
	const rounds = (gate0?.rounds ?? 0) + (confirm ? 0 : 1);
	const after = planGateAfterVerdict({ verdict, findings, rounds, max: fl.cfg.maxPlanJudgeRounds, confirm });
	const clean = isClean(verdict, findings);
	endReview(fl, "critic", outcome.ext, outcome.review, started, verdict === "PASS", `${verdict} · plan`);
	recordMetric(fl, judgeMetric("plan", rounds, verdict, findings));
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
	persist(fl);
	fl.pi.sendMessage({ customType: "workflow-plan-judge", content: `**Plan critic: ${verdict}** (run ${rounds}/${fl.cfg.maxPlanJudgeRounds})\n\n${outcome.text}`, display: true }, { triggerTurn: false });
	const assume = autopilotOn(fl) && !confirm && !after.capped && !clean && after.user.length > 0;
	if (assume) noteAuto(fl, `plan critic: ${after.user.length} finding(s) that needed a decision were settled by the planner as assumptions`);
	if (after.action === "fix" || assume) {
		fl.planFixing = true;
		const listed = [...after.auto, ...after.user].map((f) => `- ${findingText(f).replace(/\n/g, "\n  ")}`).join("\n");
		fl.pi.sendMessage({ customType: "workflow-plan-fix", content: `${prompts.PLAN_FIX}${assume ? ` ${prompts.PLAN_ASSUME}` : ""}\n\n${listed}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		return;
	}
	const queued = fl.planApproveQueued;
	fl.planApproveQueued = false;
	if (planOfferAction({ clean, queuedGo: queued }) === "approve") {
		ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(fl.cfg.roles.execute)}`, "info");
		await approve(fl, fl.lastCtx ?? ctx);
		return;
	}
	await offerPlan(fl, ctx, undefined);
}

/** `/flow critic` in plan: the critic reviews the plan on screen now, whatever the gate remembers. */
export function criticPlanNow(fl: Flow, ctx: ExtensionContext): void {
	if (!fl.planReady || !fl.planDraft.full) {
		ctx.ui.notify("workflow: no complete plan to review yet", "info");
		return;
	}
	const plan = composePlan(fl.planDraft);
	const hash = textHash(plan);
	const decision = planGateDecide({ mode: "auto", plan, planHash: hash, gate: fl.state.planGate });
	// The same plan again gets a full pass, not a recheck with an empty diff.
	void runPlanGate(fl, ctx, plan, lastAssistantText(ctx), fl.state.planGate?.planHash === hash || decision === "reuse" || decision === "off" ? "full" : decision);
}

export function branchAssistantTexts(branch: readonly unknown[]): string[] {
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
export function transcriptAfter(branch: readonly { id?: string }[], id: string, max: number): string | undefined {
	const i = branch.findIndex((e) => e.id === id);
	return i < 0 ? undefined : branchTranscript(branch.slice(i + 1), max);
}

/** Leaves discuss for plan after the discussion gate; `open` findings go into the kickoff. */
export async function moveToPlan(fl: Flow, ctx: ExtensionContext, open?: Finding[], notes?: Finding[]): Promise<void> {
	if (fl.state.discussionReview) fl.state.discussionReview = { ...fl.state.discussionReview, status: "idle" };
	await setPhase(fl, ctx, "plan");
	ctx.ui.notify(`workflow: planning on ${describeRole(fl.cfg.roles.plan)}`, "info");
	sendPlanKickoff(fl, open, notes);
}
