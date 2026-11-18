/** The event hooks (turns, tool calls, input, compaction, agent_end, session start and shutdown) and the plan phase's tool rules. */
import * as fs from "node:fs";
import * as path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULTS, loadConfig } from "../config.ts";
import { describeRole } from "../../shared/roles.ts";
import { migrateSavedState } from "../agent-end.ts";
import { countTokens } from "../../shared/tokens.ts";
import * as prompts from "../prompts.ts";
import { discussionGateOnInput } from "../gates.ts";
import { noMerge, gateCheck, defaultRunner, originRepo } from "../../shared/git/merge-gate.ts";
import { repoKey } from "../../shared/repos.ts";
import { codePublishProblem, registryPublishCodeProblem, registryPublishProblem, shellProblem } from "../../shared/git/push-guard.ts";
import { dropClaim } from "../plan-store.ts";
import { checkTitle } from "../waits.ts";
import { stageLine } from "../stages.ts";
import { phaseToolRefusal, planToolProblem } from "../../shared/readonly-tools.ts";
import { syncFlowOnlyTools } from "../plan-tools.ts";
import { countSubagent } from "../agent-events.ts";
import { type FlowSummary, summaryLines, STAGES, emptyStageTokens, emptyFlowUsage, type SubRole } from "../view.ts";
import { type Flow, type FlowState, OWN_TOOLS, type Phase, STATE_ENTRY, SUMMARY_ENTRY } from "./context.ts";
import { existingFolders, flowRepos, git, gitRoot, joinReviewBase, planCardReady } from "./diff.ts";
import { startDiscussionGate } from "./discussion-gate.ts";
import { deliverHandover, ensureGh, onAgentEnd } from "./handover.ts";
import { midFlowMergeRefusal } from "./merge.ts";
import { abortGate, scheduleIdleNotice } from "./notify.ts";
import { approve, blockPlanTools, currentStages, persist, publishRefuse, refilterTools, setPhase, updateStatus } from "./phase.ts";
import { planHousekeeping, planMilestone, recordMetric, stopClaimTimer, stopLiveTimer } from "./plan-files.ts";
import { finishWait, runWaitCheck, startWaitTimer, stopWaitTimer } from "./wait-points.ts";

/** The valid regexes among `patterns`. */
export function regexes(patterns: string[]): RegExp[] {
	return patterns.flatMap((p) => {
		try {
			return [new RegExp(p)];
		} catch {
			return [];
		}
	});
}

export function planAllowedTools(fl: Flow): RegExp[] {
	return regexes(fl.cfg.planAllowedTools);
}
export function planAllow(fl: Flow): RegExp[] {
	return fl.cfg.planBashAllow.flatMap((p) => {
		try {
			return [new RegExp(p)];
		} catch {
			return [];
		}
	});
}

export function planBlocked(problem: string): string {
	return [
		`Plan phase is read-only: ${problem}.`,
		"Do not work around this (no other tool, no script). Put the step in the plan instead: it runs after the user approves, on the execute model.",
		"Reading is fine: ls, cat, grep, find, git status/log/diff/show, gh ... view/list/checks, gh api GET, unity cmd *_status/get_*/find_*/list_*/search/console/captures/editor_play|stop|pause, video_frames.",
	].join(" ");
}

export function approveRe(fl: Flow): RegExp {
	try {
		return new RegExp(fl.cfg.approvePattern, "i");
	} catch {
		return new RegExp(DEFAULTS.approvePattern, "i");
	}
}

export function registerHooks(fl: Flow): void {
	// ----------------------------------------------------------------------
	// Events
	// ----------------------------------------------------------------------

	fl.pi.on("turn_start", async () => {
		refilterTools(fl);
	});

	fl.pi.on("before_agent_start", async (event, ctx) => {
		refilterTools(fl);
		const touched = fl.state.touchedRepos ?? [];
		const opts = event.systemPromptOptions;
		const staged = fl.state.phase === "execute" ? currentStages(fl) : undefined;
		const publishKey = [ctx.cwd, ...existingFolders(ctx), ...touched].join("|");
		if (fl.publishCache?.key !== publishKey) fl.publishCache = { key: publishKey, value: (await flowRepos(fl, ctx)).some((r) => fs.existsSync(path.join(r.root, "scripts", "update-packages.mjs"))) };
		const canPublish = (fl.state.phase === "plan" || fl.state.phase === "execute") && fl.publishCache.value;
		const phaseText = prompts.phaseSection(fl.state.phase, {
			publish: canPublish,
			stage: staged ? stageLine(staged.stages, staged.current) : undefined,
			delivery: fl.state.phase === "execute" ? prompts.deliveryGuidance(fl.cfg.delivery) + (noMerge(fl.state.approvedPlan ?? "") ? "\n- This plan says Delivery: no merge: do not merge, push to a protected branch or publish; commit, push your branch and open the pull request, then stop there." : "") : undefined,
		});
		// A section deleted and re-added moves to the end in pi's patch replay, which then no longer matches the prompt
		// pi-claude-bridge saved (prompt_capture_unresolved). So both sections are always set, in this order; the working
		// folder and the added folders are the workspace extension's `workspace` section, never written here.
		opts.sections["workflow-repos"] = prompts.workflowReposSection(touched);
		opts.sections.workflow = phaseText;
	});

	// Plan phase is read-only: the planner settles the approach, the execute model changes things.
	// Nested calls (codemode's tools.bash) pass through here too.
	fl.pi.on("tool_call", async (event, ctx) => {
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
			const multi = existingFolders(ctx).length > 0 || (fl.state.touchedRepos?.length ?? 0) > 0;
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
		const refused = phaseToolRefusal(fl.state.phase, event.toolName, planAllowedTools(fl), fl.cfg.planBlockedTools);
		if (refused) return { block: true, reason: planBlocked(refused) };
		if (!fl.cfg.planReadOnlyBash) return;
		if (event.toolName === "powershell") return { block: true, reason: planBlocked("PowerShell commands are not checked, so they are off while planning") };
		const problem = planToolProblem(event.toolName, (event.input ?? {}) as Record<string, unknown>, planAllow(fl));
		if (problem) return { block: true, reason: planBlocked(problem) };
	});

	// A repo edited with edit/write joins the flow, so the judge and the delivery cover it.
	fl.pi.on("tool_result", async (event, ctx) => {
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

	// "repeated error" decision point
	fl.pi.on("tool_result", async (event) => {
		if (fl.state.phase !== "execute" || fl.cfg.repeatedErrorThreshold <= 0 || OWN_TOOLS.has(event.toolName)) return;
		fl.consecutiveErrors = event.isError ? fl.consecutiveErrors + 1 : 0;
		if (fl.consecutiveErrors < fl.cfg.repeatedErrorThreshold) return;
		fl.consecutiveErrors = 0;
		fl.pi.sendMessage(
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
	fl.pi.on("turn_end", async (_event, ctx) => {
		const tokens = ctx.getContextUsage()?.tokens ?? null;
		if (tokens === null || fl.cfg.contextGuardTokens <= 0) return;
		const crossed = fl.guardTokens !== null && fl.guardTokens <= fl.cfg.contextGuardTokens && tokens > fl.cfg.contextGuardTokens;
		fl.guardTokens = tokens;
		if (crossed) fl.compactPending = true;
	});

	// Live token count per stage: usage is cumulative while a message streams.
	fl.pi.on("message_update", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) fl.view.mainUsage(countTokens(event.message.usage, fl.cfg.tokenWeights), false, event.message.model, event.message.usage);
	});

	fl.pi.on("message_end", async (event) => {
		if (event.message.role === "assistant" && event.message.usage) fl.view.mainUsage(countTokens(event.message.usage, fl.cfg.tokenWeights), true, event.message.model, event.message.usage);
	});

	fl.pi.registerEntryRenderer<FlowSummary>(SUMMARY_ENTRY, (entry, _opts, theme) => (entry.data ? new Text(summaryLines(entry.data, theme).join("\n"), 1, 0) : undefined));

	fl.pi.on("agent_settled", async (event, ctx) => {
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
				if (fl.state.phase === "execute" && fl.state.approvedPlan) void planCardReady(fl).then((card) => fl.state.phase === "execute" && fl.state.approvedPlan && fl.pi.sendMessage({ customType: "workflow-plan-card", content: card, display: true }, { triggerTurn: false }));
			},
			onError: (e) => {
				recordMetric(fl, { kind: "compaction", at: new Date().toISOString(), reason: "guard", tokensBefore: tokens, ms: Date.now() - compactStart, ok: false, error: e.message });
				fl.compacting = false;
				ctx.ui.notify(`workflow: compaction failed: ${e.message}`, "error");
			},
		});
	});

	// Rows from the previous run stay visible a little while, then make room.
	fl.pi.on("agent_start", async () => {
		if (fl.notify.idleTimer) clearTimeout(fl.notify.idleTimer);
		fl.notify.idleTimer = undefined;
		fl.notify.notifiedSinceStart = false;
		fl.view.clearFinished(15_000);
	});

	// Saying "go" in plan phase approves the plan: switch to execute and send the message on as the start signal.
	fl.pi.on("input", async (event, ctx) => {
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
			if (discussionGateOnInput({ running: true, isGo: approveRe(fl).test(typed) }) === "notice") {
				ctx.ui.notify("workflow: discussion critic running (Esc or any other message cancels it)", "info");
				return { action: "handled" };
			}
			abortGate(fl, "message");
			return { action: "continue" };
		}
		// In discuss, a typed "go" only moves to planning: it never approves or executes.
		if (fl.state.phase === "discuss" && event.source !== "extension" && !event.streamingBehavior && approveRe(fl).test(event.text.trim())) {
			if (await startDiscussionGate(fl, ctx)) return { action: "handled" };
			await setPhase(fl, ctx, "plan");
			ctx.ui.notify(`workflow: planning on ${describeRole(fl.cfg.roles.plan)}`, "info");
			return { action: "transform", text: `${event.text.trim()}\n\n${prompts.PLAN_KICKOFF}` };
		}
		// The plan judge is running (or the planner is fixing its findings): "go" waits for a clean PASS, other text cancels the judge.
		if (fl.state.phase === "plan" && event.source !== "extension" && typed && !typed.startsWith("/") && (fl.gateRun?.kind === "plan" || fl.planFixing)) {
			if (approveRe(fl).test(typed)) {
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
		if (!fl.planReady || !approveRe(fl).test(event.text.trim())) return { action: "continue" };
		ctx.ui.notify(`workflow: plan approved, executing on ${describeRole(fl.cfg.roles.execute)}`, "info");
		await approve(fl, ctx);
		return { action: "handled" };
	});

	fl.pi.on("session_compact", async (event, ctx) => {
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
			if (s > p && (k === -1 || s < k)) fl.pi.appendEntry(SUMMARY_ENTRY, { ...(entries[s] as { data: object }).data, reposted: true });
		} catch {
			// the card is a convenience; never break compaction
		}
	});

	fl.pi.on("agent_end", async (event, ctx) => {
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

	fl.pi.on("session_start", async (event, ctx) => {
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
			else syncFlowOnlyTools(fl.pi, fl.state.phase);
			updateStatus(fl, ctx);
			if (fl.state.phase === "execute" && fl.state.waiting) startWaitTimer(fl);
			if (event.reason !== "reload") void planHousekeeping(fl, ctx);
			// Rewrites the plan file, which also (re)starts this session's claim on an unfinished flow.
			if (fl.state.planDoc && !fl.state.planDoc.finished && fl.state.approvedPlan) planMilestone(fl, ctx, undefined, false);
			return;
		}
		if (event.reason === "reload") return;

		const flag = fl.pi.getFlag("flow");
		const start = (typeof flag === "string" && ["discuss", "plan", "execute", "off"].includes(flag) ? flag : fl.cfg.startPhase) as Phase;
		fl.state = { phase: "off", escalated: false, judgeRounds: 0 };
		fl.view.used = emptyStageTokens();
		fl.view.flow = emptyFlowUsage();
		fl.view.flowStarted = undefined;
		if (start === "off" || !(await setPhase(fl, ctx, start))) updateStatus(fl, ctx);
		void planHousekeeping(fl, ctx);
	});

	// K2: a session that is executing an approved plan is not switched away from.
	fl.pi.on("session_before_switch", async (_event, ctx) => {
		if (!(fl.state.phase === "execute" && fl.state.approvedPlan)) return;
		ctx.ui.notify("workflow: a flow is executing; finish it or leave it with /flow off before switching sessions", "warning");
		return { cancel: true };
	});

	// Explore, advisor and test_run run in the agents extension; a flow counts their usage and metrics.
	fl.pi.events.on("agents:subagent-finished", (data: unknown) => {
		const c = countSubagent(data, fl.state.phase, fl.view.stage);
		if (!c) return;
		fl.view.addFinished(c.event.role as SubRole, c.event.model, c.event.usage);
		recordMetric(fl, c.metric);
		if (c.resetErrors) fl.consecutiveErrors = 0;
	});

	fl.pi.on("session_shutdown", async () => {
		if (fl.notify.idleTimer) clearTimeout(fl.notify.idleTimer);
		fl.notify.idleTimer = undefined;
		stopWaitTimer(fl);
		const dir = fl.claim.claimedFlow ? fl.plan.planDirs.get(fl.claim.claimedFlow) : undefined;
		if (dir && fl.claim.claimedFlow) dropClaim(dir, fl.claim.claimedFlow);
		stopClaimTimer(fl);
		stopLiveTimer(fl);
	});
}
