import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describeRole } from "../../shared/roles.ts";
import { judgeAddenda, codeVerdict, lateFindingLines, planFlaws, passPending, minorFixOpen, planFlawOnPass, judgeCapReached, arbiterFirst, parseArbiter, fixableFindings, afterPass } from "../agent-end.ts";
import * as prompts from "../prompts.ts";
import { parseFindings } from "../gates.ts";
import { mergedInStage, originRepo, defaultRunner } from "../../shared/git/merge-gate.ts";
import { repoKey } from "../../shared/repos.ts";
import { recordFindings } from "../flow-report.ts";
import { subagentMetric, judgeMetric } from "../metrics.ts";
import { type ReviewResult, runJudge, fitDiffs, loadConfig as loadAgentsConfig } from "../../agents/api.ts";
import type { RunView } from "../../shared/runs.ts";
import { covers, judgeKnowledge, parseDeviations, knowledgeFooter } from "../knowledge.ts";
import type { FlowRun } from "../view.ts";
import { citedPaths, countFindings, type Diff, type Flow, type JudgeResult, type LastKnowledge, MAX_PLAN_CHARS, type ReviewPlan } from "./context.ts";
import { collectFlowDiff, git, judge, markPassed, nextAmendmentNumber, planForJudge, refreshReviewBase, repoRoots } from "./diff.ts";
import { stageDone } from "./merge.ts";
import { askUser } from "./notify.ts";
import { autopilotOn, currentStages, endFlow, escalate, noteAuto, persist, phaseStage, refreshChecklist, setPhase, summarizeFlow } from "./phase.ts";
import { planMilestone, recordMetric } from "./plan-files.ts";
import { judgeKnowledgeServer, modelOf, runRole } from "./roles.ts";

/** A very long plan loses its middle, never its amendments. */
export function trimPlan(plan: string): string {
	if (plan.length <= MAX_PLAN_CHARS) return plan;
	return `${plan.slice(0, 45_000)}\n\n[... middle of the plan omitted ...]\n\n${plan.slice(-15_000)}`;
}

/**
 * Ends the view row of a review agents ran for flow (runJudge, runCritic) with flow's outcome, and records its
 * usage and metric. A run that never reported a row gets one now, so the stage still counts it.
 */
export function endReview(fl: Flow, role: "judge" | "critic", ext: RunView | undefined, r: ReviewResult, started: number, ok: boolean, outcome: string): FlowRun {
	const row = (ext && fl.view.endMirror(ext, ok, outcome, r.model, r.usage)) ?? (() => {
		const run = fl.view.start(role, role === "judge" ? "review" : "document review", r.model);
		fl.view.finish(run, ok, outcome);
		fl.view.addFinished(role, r.model, r.usage);
		return run;
	})();
	recordMetric(fl, subagentMetric(role, row.label, row.stage, r.model, started, Date.now(), r));
	return row;
}

/**
 * One run of agents' judge with the approved plan as its spec: the whole diff ("full"), or for a re-review the changes
 * since the last round with its findings ("incremental"). Flow recomputes the verdict and checks the knowledge step.
 */
export async function judgeOnce(fl: Flow, 
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
		mcpServers: fl.pi.getMcpServers(),
		onRun: (run) => {
			ext = run;
			onChange?.(fl.view.mirror("judge", run));
		},
	});
	fl.seenDiffs.add(diff.hash);
	if (!r.ok) {
		const run = endReview(fl, "judge", ext, r, started, false, r.error ?? "failed");
		onChange?.(run);
		fl.view.stage = phaseStage(fl);
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
	const run = endReview(fl, "judge", ext, r, started, verdict === "PASS", `${verdict} · ${counted.total} finding${counted.total === 1 ? "" : "s"}${lateNote}${recheck ? " · re-review" : ""}${knowledgeNote}`);
	recordMetric(fl, judgeMetric("code", fl.state.judgeRounds + 1, verdict, findings));
	const late = lateFindingLines(findings);
	if (late.length) fl.state.lateFindings = [...new Set([...(fl.state.lateFindings ?? []), ...late])].slice(-30);
	onChange?.(run);
	// Back to the phase's stage either way.
	fl.view.stage = phaseStage(fl);
	fl.state.lastJudge = plan.snaps ? { hash: diff.hash, repos: plan.snaps, base: diff.base, verdict, text } : undefined;
	if (plan.kind === "full") fl.state.lastFullPass = plan.snaps && verdict === "PASS" && !planFlaws(findings).length ? { repos: plan.snaps, base: diff.base } : undefined;
	if (fl.state.phase === "execute") fl.state.flowFindings = recordFindings(fl.state.flowFindings, fl.state.stage, findings);
	fl.state.lastKnowledge = knowledge;
	persist(fl);
	return { verdict, text, findings, hash: diff.hash, usage: r.usage, run };
}

/** diff ready -> judge -> fix loop, or commit (and push) once it passes. */
export async function reviewDiff(fl: Flow, ctx: ExtensionContext, manual: boolean): Promise<void> {
	const baseNote = await refreshReviewBase(fl, ctx);
	const diff = await collectFlowDiff(fl, ctx);
	if (!diff?.text) {
		if (manual) ctx.ui.notify("workflow: no changes to review", "info");
		else if (diff && fl.state.passedDiff && passPending({ passedDiff: fl.state.passedDiff, judged: fl.state.lastJudge, summarized: fl.state.summarizedPasses })) {
			// The executor delivered the passed change and the base moved up with it: nothing is left to review, but the pass is still open.
			await stageDone(fl, ctx, { ...diff, hash: fl.state.passedDiff });
		} else {
			const staged = currentStages(fl);
			if (staged) await fl.legacy.noChangeTurn(ctx, staged);
			else await fl.legacy.flowWithoutChanges(ctx);
		}
		return;
	}
	// Already passed, e.g. the executor called judge itself: straight to commit.
	if (!manual && diff.hash === fl.state.passedDiff) {
		const prior = fl.state.lastJudge?.hash === diff.hash ? fl.state.lastJudge.text : "";
		const open = minorFixOpen({ summarized: !!fl.state.summarizedPasses?.includes(diff.hash), sentFor: fl.state.minorSentFor, hash: diff.hash });
		if (open && fixMinorFindings(fl, prior, diff.hash)) return;
		await stageDone(fl, ctx, diff);
		return;
	}
	if (!manual && (fl.cfg.autoJudge === "off" || fl.seenDiffs.has(diff.hash))) return;
	if (!manual && fl.cfg.autoJudge === "ask" && !autopilotOn(fl)) {
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
		const autoRetry = autopilotOn(fl) && !(fl.state.autoRetries ?? 0);
		if (autoRetry) {
			fl.state.autoRetries = 1;
			noteAuto(fl, "judge error: retried automatically");
			ctx.ui.notify("workflow: autopilot: the judge failed to run; retrying once", "info");
		}
		const choice = autoRetry ? "Retry the judge" : await askUser(fl, ctx, "The judge failed to run", ["Retry the judge", "Back to planning", "Stop"]);
		if (choice === "Retry the judge") {
			await reviewDiff(fl, ctx, true);
		} else if (choice === "Back to planning") {
			await setPhase(fl, ctx, "plan");
		} else {
			ctx.ui.notify("workflow: stopped: the judge failed to run", "warning");
			summarizeFlow(fl, fl.legacy.stoppedSummary("stopped: the judge failed to run"), false);
			await endFlow(fl, ctx);
		}
		return;
	}
	fl.state.autoRetries = 0;
	// The verdict travels with the next instruction, so they reach the transcript in order.
	const report = `**Judge: ${r.verdict}**\n\n${r.text}`;
	if (planFlaws(r.findings).length) {
		const route = planFlawOnPass(r.findings, r.verdict);
		const outcome = route === "stop" ? await resolvePlanFlaw(fl, ctx, report, diff) : await settlePlanFlawOnPass(fl, ctx, report, diff, route);
		if (outcome !== "continue") return;
		if (r.verdict === "PASS") markPassed(fl, diff.hash);
	}
	if (r.verdict === "FAIL") {
		fl.state.judgeRounds++;
		persist(fl);
		await fixOrAsk(fl, ctx, report);
		return;
	}

	if (fixMinorFindings(fl, r.text, diff.hash, report)) return;
	await stageDone(fl, ctx, diff, report);
}

/** After a failed judge round: send the executor back to fix, or ask what to do once the round cap is hit. */
export async function fixOrAsk(fl: Flow, ctx: ExtensionContext, report: string | undefined): Promise<void> {
	if (judgeCapReached(fl.state.judgeRounds, fl.cfg.maxJudgeRounds)) {
		if (report) fl.pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
		const autoCap = autopilotOn(fl) ? ((fl.state.autoCaps ?? 0) === 0 ? "Escalate and keep fixing" : "Stop") : undefined;
		if (autoCap) {
			fl.state.autoCaps = (fl.state.autoCaps ?? 0) + 1;
			noteAuto(fl, `judge cap (${fl.state.judgeRounds} failed rounds): ${autoCap === "Stop" ? "stopped (second cap)" : "escalated and kept fixing (advisor asked once)"}`);
			ctx.ui.notify(`workflow: autopilot: judge cap reached; ${autoCap === "Stop" ? "stopping" : "escalating and fixing on"}`, "warning");
		}
		const choice = autoCap ?? await askUser(fl, ctx, `Judge failed ${fl.state.judgeRounds} rounds in a row`, ["Keep fixing", "Escalate and keep fixing", "Stop"]);
		if (choice === "Keep fixing" || choice === "Escalate and keep fixing") {
			if (choice !== "Keep fixing") await escalate(fl, ctx);
			fl.state.judgeRounds = 0;
			persist(fl);
			fl.pi.sendMessage({ customType: "workflow-fix", content: autoCap ? `${prompts.FIX_MESSAGE} Before you change code, ask the advisor about the open findings above.` : prompts.FIX_MESSAGE, display: true }, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		ctx.ui.notify(`workflow: stopped after ${fl.state.judgeRounds} failed judge rounds`, "warning");
		summarizeFlow(fl, fl.legacy.stoppedSummary(`stopped: judge failed ${fl.state.judgeRounds} rounds`), false);
		await endFlow(fl, ctx);
		return;
	}
	fl.pi.sendMessage(
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
export async function resolvePlanFlaw(fl: Flow, ctx: ExtensionContext, report: string, diff: Diff): Promise<"continue" | "amended" | "stop"> {
	let arbiter = arbiterFirst(autopilotOn(fl) ? "auto" : fl.state.planFlaw, fl.cfg.planFlaw);
	let canAsk = true;
	for (;;) {
		if (arbiter) {
			arbiter = false;
			const outcome = await runArbiter(fl, ctx, report, diff);
			if (outcome !== "ask") return outcome;
			canAsk = false; // the arbiter had its say; offer the rest
		}
		if (!ctx.hasUI) {
			fl.pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			summarizeFlow(fl, fl.legacy.stoppedSummary("stopped: judge questions the plan"), false);
			await endFlow(fl, ctx);
			return "stop";
		}
		const options = ["Back to planning", ...(canAsk ? ["Let the arbiter decide"] : []), "Ignore and continue", "Stop"];
		const choice = await askUser(fl, ctx, "Judge questions the plan", options);
		if (choice === "Back to planning") {
			await setPhase(fl, ctx, "plan");
			fl.pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
			return "stop";
		}
		if (choice === "Let the arbiter decide") {
			arbiter = true;
			continue;
		}
		if (choice === "Ignore and continue") {
			// Recorded, so the next review does not raise the same flaw and ask again.
			notePlanFlaws(fl, ctx, report, "Plan choices upheld by the user");
			return "continue";
		}
		fl.pi.sendMessage({ customType: "workflow-judge", content: report, display: true }, { triggerTurn: false });
		summarizeFlow(fl, fl.legacy.stoppedSummary("stopped: judge questions the plan"), false);
		await endFlow(fl, ctx);
		return "stop";
	}
}

/** Appends the report's plan-flaw lines to the approved plan under the heading; returns how many. */
export function notePlanFlaws(fl: Flow, ctx: ExtensionContext, report: string, heading: string): number {
	const lines = planFlaws(parseFindings(report)).map((f) => `- ${f.head}`).filter((l) => !(fl.state.approvedPlan ?? "").includes(l));
	if (!lines.length) return 0;
	fl.state.approvedPlan = `${fl.state.approvedPlan ?? ""}\n\n## ${heading}\n${lines.join("\n")}`;
	refreshChecklist(fl);
	planMilestone(fl, ctx);
	persist(fl);
	return lines.length;
}

/** A pass that questions the plan, without a blocker: minor flaws are noted, major ones go to the arbiter. Never asks the user. */
export async function settlePlanFlawOnPass(fl: Flow, ctx: ExtensionContext, report: string, diff: Diff, route: "arbiter" | "note"): Promise<"continue" | "amended"> {
	const heading = "Plan choices upheld at a pass";
	if (route === "arbiter") {
		const outcome = await runArbiter(fl, ctx, report, diff, false);
		if (outcome !== "ask") return outcome;
		const n = notePlanFlaws(fl, ctx, report, heading);
		fl.state.unresolvedPlanFlaws = (fl.state.unresolvedPlanFlaws ?? 0) + n;
		persist(fl);
		if (n > 0) ctx.ui.notify(`workflow: the arbiter did not settle ${n} plan flaw(s); noted in the plan, continuing`, "warning");
		return "continue";
	}
	const n = notePlanFlaws(fl, ctx, report, heading);
	if (n > 0) ctx.ui.notify(`workflow: the judge passed but questions the plan (${n} plan flaw(s)); noted in the plan, continuing`, "info");
	return "continue";
}

/** Runs the arbiter on the judge's plan-flaw report. "ask" means it could not or may not decide. */
export async function runArbiter(fl: Flow, ctx: ExtensionContext, report: string, diff: Diff, canAsk = true): Promise<"continue" | "amended" | "ask"> {
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
		refreshChecklist(fl);
		planMilestone(fl, ctx);
		persist(fl);
		fl.pi.sendMessage({ customType: "workflow-judge", content: `**Arbiter: the plan stands.**\n\n${d.reason}`, display: true }, { triggerTurn: false });
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
		refreshChecklist(fl);
		planMilestone(fl, ctx);
		persist(fl);
		fl.pi.sendMessage(
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
export function fixMinorFindings(fl: Flow, text: string, hash: string, report?: string): boolean {
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
	persist(fl);
	const shown = report ?? `**Judge: PASS**\n\n${text}`;
	fl.legacy.handover(
		"workflow-fix",
		prompts.minorFixMessage(shown, findings),
	);
	return true;
}

/** Remembers a passed diff's flow as ended, so later runs on the same diff don't end another one. */
export function markPassSummarized(fl: Flow, hash: string): void {
	fl.state.summarizedPasses = [...(fl.state.summarizedPasses ?? []).filter((h) => h !== hash), hash].slice(-20);
}

/** What the stage delivered in each changed repo, read from git and gh: the branch, the commits since the review base, and the pull request if there is one. */
export async function stageOutcomeText(fl: Flow, ctx: ExtensionContext, diff: Diff): Promise<string> {
	const changed = diff.repos.filter((r) => r.changed);
	const repos = changed.length ? changed : diff.repos;
	await fl.legacy.ensureGh(ctx).catch(() => false);
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
