import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stageEndAction } from "../agent-end.ts";
import { midFlowMergeProblem, unpushedReason, noMerge, mergedInStage, originRepo, defaultRunner } from "../../shared/git/merge-gate.ts";
import { repoKey } from "../../shared/repos.ts";
import { isHuman } from "../plan-doc.ts";
import { deliverMergeOpen, mergeDecisions, gateOpenSteps, mergeAmendment, afterMergeStep, withCheckpoints, mergeDecisionsText } from "../checkpoints.ts";
import { stagesOutcome } from "../stages.ts";
import { type Diff, type Flow } from "./context.ts";
import { advanceReviewBase, flowRepos, git, nextAmendmentNumber, stageCheckpoints } from "./diff.ts";
import { handover, noChangeTurn, startNextStage } from "./handover.ts";
import { markPassSummarized, stageOutcomeText } from "./judge.ts";
import { currentStages, endFlow, persist, refreshChecklist, summarizeFlow } from "./phase.ts";
import { planMilestone } from "./plan-files.ts";

/** Whether a merge is due at this point of the flow: the plan is not staged or this is its last stage, or a merge was planned or approved for this stage. */
export function mergeDue(fl: Flow): boolean {
	const staged = currentStages(fl);
	return !staged || staged.current >= staged.stages.length || deliverMergeOpen(fl.state.approvedPlan ?? "", fl.state.checklist, staged.current) || mergeApproved(fl);
}

/** Whether the latest merge decision that covers this stage (or the whole flow) allows a merge. */
export function mergeApproved(fl: Flow): boolean {
	const stage = currentStages(fl)?.current ?? 0;
	const mine = mergeDecisions(fl.state.approvedPlan).filter((d) => d.stage === 0 || d.stage === stage);
	return mine.length > 0 && mine[mine.length - 1].allowed;
}

/** The refusal of a merge or protected push before the end of the flow (the gate's rules), or null when it is allowed. */
export function midFlowMergeRefusal(fl: Flow): string | null {
	const staged = currentStages(fl);
	const open = gateOpenSteps(fl.state.approvedPlan ?? "", fl.state.checklist, staged ? { current: staged.current, total: staged.stages.length } : undefined);
	return midFlowMergeProblem({
		staged: !!staged,
		current: staged?.current,
		total: staged?.stages.length,
		openSteps: open,
		deliverMergeOpen: deliverMergeOpen(fl.state.approvedPlan ?? "", fl.state.checklist, staged?.current),
		approved: mergeApproved(fl),
	});
}

/** Records a merge decision in the approved plan, tells the user in chat and with a notification. */
export function recordMergeDecision(fl: Flow, ctx: ExtensionContext, by: "arbiter" | "user", allowed: boolean, reason: string, shown?: string): void {
	const stage = currentStages(fl)?.current ?? 0;
	fl.state.approvedPlan = `${fl.state.approvedPlan ?? ""}\n\n${mergeAmendment(nextAmendmentNumber(fl), { by, allowed, stage, reason })}`;
	refreshChecklist(fl);
	planMilestone(fl, ctx);
	persist(fl);
	const head = by === "arbiter" ? `Arbiter: merge ${allowed ? "allowed" : "refused"} before the end of the flow` : `You ${allowed ? "allowed" : "refused"} a merge before the end of the flow`;
	fl.pi.sendMessage({ customType: "workflow-judge", content: `**${head}**\n\n${shown ?? reason}`, display: true }, { triggerTurn: false });
	ctx.ui.notify(`workflow: ${head}: ${reason.split("\n")[0]}`, "info");
}

/** The changed repos of a passed diff with a remote whose work is not pushed yet, by folder name, with the reason. */
export async function unpushedRepos(fl: Flow, diff: Diff): Promise<string[]> {
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
export async function flowHasRemote(fl: Flow, ctx: ExtensionContext): Promise<boolean> {
	const remotes = await Promise.all((await flowRepos(fl, ctx)).map((r) => git(fl, r.dir, "remote")));
	return remotes.some((r) => r.stdout.trim() !== "");
}

/** The changed repos of a passed diff that have a remote but no judged merge yet, by folder name: the executor still has to merge. Empty when the plan says no merge. */
export async function unmergedRepos(fl: Flow, diff: Diff): Promise<string[]> {
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
export async function stageDone(fl: Flow, ctx: ExtensionContext, diff: Diff, report?: string): Promise<void> {
	const hash = diff.hash;
	if (report) fl.pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
	const staged = currentStages(fl);
	if (fl.state.summarizedPasses?.includes(hash)) {
		// A staged plan's stage added nothing to the diff that was already passed.
		if (staged) await noChangeTurn(fl, ctx, staged);
		return;
	}
	const open = (fl.state.checklist ?? []).filter((i) => !isHuman(i) && !i.done && (!staged || i.stage === undefined || i.stage === staged.current));
	const due = mergeDue(fl);
	const unmerged = due ? await unmergedRepos(fl, diff) : [];
	const unpushed = due || noMerge(fl.state.approvedPlan ?? "") ? [] : await unpushedRepos(fl, diff);
	if (stageEndAction({ openSteps: open.length + (unmerged.length || unpushed.length ? 1 : 0), nudgedFor: fl.state.stageNudgedFor, hash }) === "nudge") {
		fl.state.stageNudgedFor = hash;
		persist(fl);
		const lines: string[] = [];
		const afterOnly = open.length > 0 && open.every((i) => afterMergeStep(fl.state.approvedPlan ?? "", i.id));
		const openLine = open.length ? `Open steps ${open.map((i) => i.id).join(", ")}: finish them (merge, publish), tick them with plan_check, then end your turn.` : "";
		if (openLine && !afterOnly) lines.push(openLine);
		if (unpushed.length) lines.push(`The judge passed: commit and push ${unpushed.join(", ")}, then end your turn.`);
		if (unmerged.length) lines.push(`The judge passed: merge the pull request (gh pr merge, as its own command)${unmerged.length > 1 || diff.multi ? ` in ${unmerged.join(", ")}` : ""}, then end your turn.`);
		if (openLine && afterOnly) lines.push(openLine);
		handover(fl, "workflow-open-steps", lines.join("\n"));
		return;
	}
	const knowledge = fl.state.lastKnowledge?.hash === hash ? fl.state.lastKnowledge : undefined;
	if (knowledge && knowledge.status !== "checked") ctx.ui.notify(`workflow: judge passed without the knowledge check: ${knowledge.reason}`, "warning");
	let outcome = { text: await stageOutcomeText(fl, ctx, diff), ok: true };
	const cps = stageCheckpoints(fl);
	if (cps.length) outcome = { text: withCheckpoints(cps.map((c) => c.text), outcome.text), ok: cps.every((c) => c.ok) };
	markPassSummarized(fl, hash);
	await advanceReviewBase(fl, ctx);
	fl.state.minorRounds = 0;
	fl.state.minorSentFor = undefined;
	fl.state.minorFix = undefined;
	fl.state.stageNudgedFor = undefined;
	if (staged) {
		fl.state.stageOutcomes = [...(fl.state.stageOutcomes ?? []), outcome];
		if (staged.current < staged.stages.length) {
			startNextStage(fl, ctx, staged.stages, outcome.text);
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
	if (!summarizeFlow(fl, outcome.text, outcome.ok)) persist(fl);
	await endFlow(fl, ctx);
}
