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
import { createFlow, MODEL_ROLES, type Phase, SUMMARY_ENTRY } from "./flow/context.ts";
import { collectBoard, gitRoot, joinReviewBase } from "./flow/diff.ts";
import { askRestate, runDiscussionGate, startDiscussionGate } from "./flow/discussion-gate.ts";
import { abortGate } from "./flow/notify.ts";
import { applyRole, approve, autopilotOn, currentStages, deescalate, escalate, persist, publishFolders, sendPlanKickoff, setPhase, updateStatus } from "./flow/phase.ts";
import { branchAssistantTexts, criticPlanNow, moveToPlan } from "./flow/plan-gate.ts";
import { resumeFlow } from "./flow/resume.ts";
import { modelOf, roleSpecOf } from "./flow/roles.ts";
import { registerTools } from "./flow/tools.ts";
import { registerHooks } from "./flow/hooks.ts";

export default function workflow(pi: ExtensionAPI) {
	const fl = createFlow(pi);

	pi.registerFlag("add-dir", {
		description: "Extra folders for this session, separated by ; on Windows and : elsewhere",
		type: "string",
	});

	pi.registerFlag("flow", {
		description: "Workflow phase to start in: discuss, plan, execute, test or off (default from workflow.json)",
		type: "string",
	});

	registerTools(fl);

	registerHooks(fl);

	// ----------------------------------------------------------------------
	// /flow
	// ----------------------------------------------------------------------

	function statusText(): string {
		const lines = [
			`phase      ${fl.state.phase}${fl.state.escalated ? " (escalated)" : ""}`,
			`judge     ${fl.state.judgeRounds} failed round(s); auto=${fl.cfg.autoJudge}; ${noMerge(fl.state.approvedPlan ?? "") ? "no merge (the plan says so)" : "merge and publish after a judge pass"}`,
			...(currentStages(fl) ? [`stage     ${currentStages(fl)!.current} of ${currentStages(fl)!.stages.length}: ${currentStages(fl)!.stages[currentStages(fl)!.current - 1].title}`] : []),
			fl.state.planFlaw === "auto" ? "flaws     arbiter (this flow)" : `flaws     ${fl.cfg.planFlaw === "auto" ? "arbiter" : "ask"} (config)`,
			`autopilot ${autopilotOn(fl) ? "on" : "off"} (${fl.autopilotOverride === undefined ? "config" : "session"})`,
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
				persist(fl);
				publishFolders(fl, ctx);
				updateStatus(fl, ctx);
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
				persist(fl);
				publishFolders(fl, ctx);
				updateStatus(fl, ctx);
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
						await moveToPlan(fl, ctx, forcedOpenFindings(fl.state.discussionReview, hash));
						return;
					}
					if (sub.toLowerCase() === "plan" && fl.state.phase === "discuss" && (await startDiscussionGate(fl, ctx))) return;
					const from = fl.state.phase;
					if (!(await setPhase(fl, ctx, sub.toLowerCase() as Phase))) return;
					ctx.ui.notify(`workflow: ${fl.state.phase}`, "info");
					if (from === "discuss" && fl.state.phase === "plan") sendPlanKickoff(fl);
					return;
				}
				case "approve":
					if (fl.state.phase === "discuss") {
						if (await startDiscussionGate(fl, ctx)) return;
						ctx.ui.notify("workflow: discuss phase; moving to planning first", "info");
						await setPhase(fl, ctx, "plan");
						sendPlanKickoff(fl);
						return;
					}
					await approve(fl, ctx);
					return;
				case "resume":
					await resumeFlow(fl, ctx, rest[0]);
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
					fl.autopilotOverride = arg === undefined ? !autopilotOn(fl) : arg === "on";
					updateStatus(fl, ctx);
					ctx.ui.notify(`workflow: autopilot ${autopilotOn(fl) ? "on" : "off"} (session)`, "info");
					return;
				}
				case "escalate":
				case "fable":
					await escalate(fl, ctx);
					return;
				case "back":
				case "opusplan":
					await deescalate(fl, ctx);
					return;
				case "critic":
					if (rest[0]?.toLowerCase() === "cancel") {
						if (fl.gateRun) abortGate(fl, "command");
						else ctx.ui.notify("workflow: no critic review running", "info");
						return;
					}
					if (fl.state.phase === "discuss") {
						if (askRestate(fl, ctx, false)) return;
						await runDiscussionGate(fl, ctx, "full", false);
					} else if (fl.state.phase === "plan") criticPlanNow(fl, ctx);
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
					updateStatus(fl, ctx);
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
					if (live) await applyRole(fl, ctx, role as Role);
					updateStatus(fl, ctx);
					ctx.ui.notify(`workflow: ${role} -> ${describeRole(parsed)} (saved to workflow.json)`, "info");
					return;
				}
				default:
					ctx.ui.notify(FLOW_UNKNOWN(sub), "warning");
			}
		},
	});
}
