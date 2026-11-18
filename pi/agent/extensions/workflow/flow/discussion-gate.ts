/** The discussion gate: the critic's review of the agreed list before the plan phase. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as prompts from "../prompts.ts";
import { lastAgreedList, discussionCriticRequest, discussionVerdict } from "../discussion-review.ts";
import { branchTranscript } from "../../shared/transcript.ts";
import { textHash, isClean, discussionGateStart, isEscKey, type Finding, planDisputes, discussionGateAfterVerdict, minorFindings, blockingFindings, findingText } from "../gates.ts";
import { judgeMetric } from "../metrics.ts";
import { type ReviewResult, runCritic } from "../../agents/api.ts";
import type { RunView } from "../../shared/runs.ts";
import { type Flow } from "./context.ts";
import { existingFolders } from "./diff.ts";
import { endReview } from "./judge.ts";
import { abortGate, lastAssistantText, scheduleIdleNotice } from "./notify.ts";
import { persist, updateStatus } from "./phase.ts";
import { recordMetric } from "./plan-files.ts";
import { branchAssistantTexts, moveToPlan, transcriptAfter } from "./plan-gate.ts";

/** A review already ran on this list and the list was not rewritten since: the judge would read the same text again, so the discuss model restates the conclusion first. True when it asked. */
export function askRestate(fl: Flow, ctx: ExtensionContext, loop: boolean): boolean {
	const last = fl.state.discussionReview;
	const list = lastAgreedList(branchAssistantTexts(ctx.sessionManager.getBranch()));
	if (!last || !list || last.listHash !== textHash(list) || isClean(last.verdict, last.findings) || fl.restateAskedFor === last.listHash) return false;
	fl.restateAskedFor = last.listHash;
	fl.state.discussionReview = { ...last, status: "awaiting-fix", restateLoop: loop };
	persist(fl);
	ctx.ui.notify("workflow: the agreed list was not rewritten since the last review; asking for a restated conclusion first", "info");
	fl.pi.sendMessage({ customType: "workflow-discussion-restate", content: prompts.DISCUSSION_RESTATE, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	return true;
}

/** The move from discuss to plan. Returns true when the discussion judge started (the move happens after it); false when the caller moves now. */
export async function startDiscussionGate(fl: Flow, ctx: ExtensionContext): Promise<boolean> {
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
	if (askRestate(fl, ctx, true)) return true;
	void runDiscussionGate(fl, ctx, d, true);
	return true;
}

/** The discussion critic: one run on the last agreed list. `loop` false is the manual `/flow critic`: it reports and stores the review but starts no fix loop. */
export async function runDiscussionGate(fl: Flow, ctx: ExtensionContext, decision: "full" | "recheck", loop: boolean, resetRounds = true): Promise<void> {
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
		if (loop) await moveToPlan(fl, ctx);
		return;
	}
	const run = { kind: "discussion" as const, controller: new AbortController(), judgedHash: listHash } as NonNullable<typeof fl.gateRun>;
	fl.gateRun = run;
	if (ctx.hasUI) {
		try {
			run.offEsc = ctx.ui.onTerminalInput((d) => (isEscKey(d) ? (abortGate(fl, "esc"), { consume: true }) : undefined));
		} catch {}
	}
	updateStatus(fl, ctx);
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
				folders: existingFolders(ctx),
				recheck: recheck ? { findings: prev!.findings } : undefined,
				disputes: recheck ? planDisputes(lastAssistantText(ctx)) : undefined,
			}),
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
		ctx.ui.setWorkingMessage();
		updateStatus(fl, ctx);
		try {
			if (ctx.isIdle()) scheduleIdleNotice(fl, ctx);
		} catch {}
	}
	const nowList = lastAgreedList(branchAssistantTexts(ctx.sessionManager.getBranch()));
	const stale = fl.state.phase !== "discuss" || (nowList ? textHash(nowList) : "") !== listHash;
	if ((run.reason || stale || (outcome && "error" in outcome)) && outcome?.review) endReview(fl, "critic", outcome.ext, outcome.review, started, false, run.reason ? "cancelled · discussion" : stale ? "discarded · list changed" : `failed · ${outcome.review.error ?? "no result"}`);
	if (run.reason) {
		if (run.reason === "restart" || run.reason === "phase") return;
		if (fl.state.discussionReview) {
			fl.state.discussionReview = { ...fl.state.discussionReview, status: "idle" };
			persist(fl);
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
		await moveToPlan(fl, ctx);
		return;
	}
	const findings = outcome.findings;
	const verdict = discussionVerdict(outcome.text);
	const rounds = (resetRounds ? 0 : prev?.rounds ?? 0) + (loop ? 1 : 0);
	endReview(fl, "critic", outcome.ext, outcome.review, started, verdict === "PASS", `${verdict} · discussion`);
	recordMetric(fl, judgeMetric("discussion", rounds, verdict, findings));
	fl.pi.sendMessage({ customType: "workflow-discussion-review", content: `**Discussion review: ${verdict}**\n\n${outcome.text}`, display: true }, { triggerTurn: false });
	const after = ctx.sessionManager.getBranch();
	fl.state.discussionReview = { listHash, verdict, findings, afterEntryId: (after[after.length - 1] as { id?: string } | undefined)?.id, rounds, status: "idle" };
	persist(fl);
	if (!loop) {
		ctx.ui.notify(`workflow: discussion review ${verdict}${list ? "" : " (no Agreed so far: list found)"}`, verdict === "PASS" ? "info" : "warning");
		return;
	}
	const action = discussionGateAfterVerdict({ verdict, findings, rounds, max: fl.cfg.maxDiscussionJudgeRounds });
	if (action === "move") await moveToPlan(fl, ctx, undefined, minorFindings(findings));
	else if (action === "move-open") {
		ctx.ui.notify(`workflow: discussion critic: ${blockingFindings(findings).length} finding(s) still open after ${rounds} runs; planning with them noted`, "warning");
		await moveToPlan(fl, ctx, blockingFindings(findings), minorFindings(findings));
	} else if (action === "fix") {
		fl.state.discussionReview = { ...fl.state.discussionReview, status: "awaiting-fix" };
		persist(fl);
		ctx.ui.notify(`workflow: discussion critic: fixing ${blockingFindings(findings).length} finding(s) (run ${rounds}/${fl.cfg.maxDiscussionJudgeRounds})`, "info");
		const listed = blockingFindings(findings).map((f) => `- ${findingText(f).replace(/\n/g, "\n  ")}`).join("\n");
		fl.pi.sendMessage({ customType: "workflow-discussion-fix", content: `${prompts.DISCUSSION_FIX}\n\n${listed}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	} else {
		fl.state.discussionReview = { ...fl.state.discussionReview, status: "paused" };
		persist(fl);
		ctx.ui.notify(`workflow: discussion critic: ${blockingFindings(findings).filter((f) => f.route === "user").length} finding(s) need your decision; answer them, then say go again`, "warning");
	}
}
