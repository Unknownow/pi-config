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
import { createFlow, type FlowState, MODEL_ROLES, OWN_TOOLS, type Phase, STATE_ENTRY, SUMMARY_ENTRY } from "./flow/context.ts";
import { collectBoard, existingFolders, flowRepos, git, gitRoot, joinReviewBase, planCardReady } from "./flow/diff.ts";
import { askRestate, runDiscussionGate, startDiscussionGate } from "./flow/discussion-gate.ts";
import { applyAddDir, followWorkingFolder } from "./flow/folders.ts";
import { deliverHandover, ensureGh, onAgentEnd } from "./flow/handover.ts";
import { midFlowMergeRefusal } from "./flow/merge.ts";
import { abortGate, scheduleIdleNotice } from "./flow/notify.ts";
import { applyRole, approve, autopilotOn, blockPlanTools, currentStages, deescalate, escalate, persist, publishFolders, publishRefuse, refilterTools, sendPlanKickoff, setPhase, updateStatus } from "./flow/phase.ts";
import { planHousekeeping, planMilestone, recordMetric, stopClaimTimer, stopLiveTimer } from "./flow/plan-files.ts";
import { branchAssistantTexts, criticPlanNow, moveToPlan } from "./flow/plan-gate.ts";
import { resumeFlow } from "./flow/resume.ts";
import { modelOf, roleSpecOf } from "./flow/roles.ts";
import { finishWait, runWaitCheck, startWaitTimer, stopWaitTimer } from "./flow/wait-points.ts";
import { registerTools } from "./flow/tools.ts";

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

	// ----------------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------------

	pi.on("turn_start", async () => {
		refilterTools(fl);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		refilterTools(fl);
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
		const staged = fl.state.phase === "execute" ? currentStages(fl) : undefined;
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
				if (kind === "merge") await ensureGh(fl, ctx).catch(() => false);
				const early = noMerge(fl.state.approvedPlan ?? "") ? null : midFlowMergeRefusal(fl);
				if (early) return early;
				const res = await gateCheck(defaultRunner, kind, dir, target, { passedTrees: fl.state.passedTrees?.[key] ?? [], noMerge: noMerge(fl.state.approvedPlan ?? ""), repo: repo ?? (await originRepo(defaultRunner, dir)) });
				if (res.problem) return res.problem;
				if (res.tree) {
					const stage = fl.state.stage;
					const record = kind === "merge" ? { pr: target ?? (await branchOf(dir)), tree: res.tree, ...(stage ? { stage } : {}) } : res.commit ? { commit: res.commit, tree: res.tree, ...(stage ? { stage } : {}) } : undefined;
					if (record) {
						fl.state.judgedMerges = { ...(fl.state.judgedMerges ?? {}), [key]: record };
						persist(fl);
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
		persist(fl);
		updateStatus(fl, ctx);
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
		if (tracked && STAGES.some((s) => fl.view.used[s].raw !== (fl.state.tokens?.[s]?.raw ?? 0) || fl.view.used[s].cost !== (fl.state.tokens?.[s]?.cost ?? 0))) persist(fl);
		if (fl.pendingHandover) {
			const msg = fl.pendingHandover;
			fl.pendingHandover = undefined;
			deliverHandover(fl, ctx, msg, event.aborted);
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
				recordMetric(fl, { kind: "compaction", at: new Date().toISOString(), reason: "guard", tokensBefore: tokens, ms: Date.now() - compactStart, ok: true });
				fl.compacting = false;
				fl.guardTokens = null;
				if (fl.state.phase === "execute" && fl.state.approvedPlan) void planCardReady(fl).then((card) => fl.state.phase === "execute" && fl.state.approvedPlan && pi.sendMessage({ customType: "workflow-plan-card", content: card, display: true }, { triggerTurn: false }));
			},
			onError: (e) => {
				recordMetric(fl, { kind: "compaction", at: new Date().toISOString(), reason: "guard", tokensBefore: tokens, ms: Date.now() - compactStart, ok: false, error: e.message });
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
			stopWaitTimer(fl);
			fl.wait.waitChecking = true;
			try {
				const verdict = w.check && !w.checkPassed ? await runWaitCheck(fl, w.check) : undefined;
				if (w.check && verdict && verdict.status !== "pass") {
					if (fl.state.waiting !== w) return { action: "continue" };
					if (!ctx.hasUI) {
						startWaitTimer(fl);
						return { action: "handled" };
					}
					const choice = await ctx.ui.select(checkTitle(verdict, w.check), ["Continue anyway", "Keep waiting"]);
					if (fl.state.waiting !== w) return { action: "continue" };
					if (choice !== "Continue anyway") {
						ctx.ui.notify(`workflow: still waiting for "${w.reason}"`, "info");
						startWaitTimer(fl);
						return { action: "handled" };
					}
					how = "forced";
				}
			} finally {
				fl.wait.waitChecking = false;
			}
			if (fl.state.waiting !== w) return { action: "continue" };
			return { action: "transform", text: finishWait(fl, ctx, w, how, typed) };
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
			if (await startDiscussionGate(fl, ctx)) return { action: "handled" };
			await setPhase(fl, ctx, "plan");
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
		await approve(fl, ctx);
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

	pi.on("agent_end", async (event, ctx) => {
		fl.inAgentEnd++;
		const prevAborted = fl.turnAborted;
		const lastMsg = [...event.messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		fl.turnAborted = !!event.aborted || lastMsg?.stopReason === "aborted";
		try {
			await onAgentEnd(fl, event, ctx);
		} finally {
			fl.turnAborted = prevAborted;
			fl.inAgentEnd--;
			if (fl.inAgentEnd === 0) scheduleIdleNotice(fl, ctx);
		}
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "reload") fl.metrics.clear();
		const loaded = loadConfig();
		fl.cfg = loaded.config;
		fl.configError = loaded.error;
		if (fl.configError) ctx.ui.notify(`workflow: bad config, using defaults: ${fl.configError}`, "error");
		// One warning per session for old keys (the removed judge role and quick flow); a /flow reload shows it again.
		if (loaded.warning && loaded.warning !== fl.configWarning) ctx.ui.notify(`workflow: ${loaded.warning}`, "warning");
		fl.configWarning = loaded.warning;
		void ensureGh(fl, ctx).catch(() => false);

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
			if (fl.state.phase === "discuss" || fl.state.phase === "plan") blockPlanTools(fl);
			else syncFlowOnlyTools(pi, fl.state.phase);
			if (event.reason !== "reload") {
				await followWorkingFolder(fl, ctx);
				// --add-dir is a launch flag: only the first session of the process applies it, not a later switch or resume.
				if (event.reason === "startup") applyAddDir(fl, ctx);
				publishFolders(fl, ctx);
			}
			updateStatus(fl, ctx);
			if (fl.state.phase === "execute" && fl.state.waiting) startWaitTimer(fl);
			if (event.reason !== "reload") void planHousekeeping(fl, ctx);
			// Rewrites the plan file, which also (re)starts this session's claim on an unfinished flow.
			if (fl.state.planDoc && !fl.state.planDoc.finished && fl.state.approvedPlan) planMilestone(fl, ctx, undefined, false);
			return;
		}
		if (event.reason === "reload") return;

		const flag = pi.getFlag("flow");
		const start = (typeof flag === "string" && ["discuss", "plan", "execute", "off"].includes(flag) ? flag : fl.cfg.startPhase) as Phase;
		fl.state = { phase: "off", escalated: false, judgeRounds: 0 };
		fl.view.used = emptyStageTokens();
		fl.view.flow = emptyFlowUsage();
		fl.view.flowStarted = undefined;
		applyAddDir(fl, ctx);
		publishFolders(fl, ctx);
		if (start === "off" || !(await setPhase(fl, ctx, start))) updateStatus(fl, ctx);
		void planHousekeeping(fl, ctx);
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
		recordMetric(fl, c.metric);
		if (c.resetErrors) fl.consecutiveErrors = 0;
	});

	pi.on("session_shutdown", async () => {
		if (fl.notify.idleTimer) clearTimeout(fl.notify.idleTimer);
		fl.notify.idleTimer = undefined;
		stopWaitTimer(fl);
		const dir = fl.claim.claimedFlow ? fl.plan.planDirs.get(fl.claim.claimedFlow) : undefined;
		if (dir && fl.claim.claimedFlow) dropClaim(dir, fl.claim.claimedFlow);
		stopClaimTimer(fl);
		stopLiveTimer(fl);
	});

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

	Object.assign(fl.legacy, { planAllowedTools });
}
