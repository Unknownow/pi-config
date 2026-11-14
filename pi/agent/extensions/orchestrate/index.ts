/**
 * Orchestrate extension: one orchestrator session runs 2-4 workflow sub-sessions, each in its own `wt`
 * worktree. It talks to the workflow and worktree extensions only through their public events
 * (workflow K4, K9-K11; worktree W1) and to the sub-sessions through append-only files under
 * `<git common dir>/pi/orchestra/<run>/`. See README.md.
 *
 * The same extension runs in both roles. A session whose worktree is the `cwd` of a sub in an active
 * run is a sub-session; any other session can start a run (orch_run) and becomes its orchestrator.
 */

import { createHash, randomUUID } from "node:crypto";
import { GATE_ENTRY, nextLastProposal, oneGoOnReply, pauseAction, proposalGateAfterFixReply, proposalGateAfterVerdict, proposalGateFromEntries, proposalGateOnInput, proposalGateRounds, proposalGateStart, proposalReviewPrompts, roleOnRestore, roleSwitch, roleWarnText, type ProposalReview, type SavedModel } from "./proposal-gate.ts";
import { runSubagent } from "../agents/subagent.ts";
import { blockingFindings, branchAssistantTexts, findingsBlock, isEscKey, judgeVerdict, lastAgreedList, minorFindings, parseFindings } from "../shared/findings.ts";
import type { Finding } from "../shared/findings.ts";
import { confirmPlanTitle, judgeSection, parsePlanJudge, phaseLabel, planReviewJudgeLine } from "./plan-judge.ts";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import * as os from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { emitClaims } from "../shared/claims.ts";
import { notifyCommand } from "../shared/notify.ts";
import { activeCount, canonicalPackages, kickoffText, makeRunId, readyToSpawn, renderBrief, revertSpawning, setName, staleSpawning, validatePackages, type PackageInput, type Run, type Sub } from "./brief.ts";
import { foldersFromEntries } from "./folders.ts";
import { checkDecision, checkItemAnswer } from "./decide.ts";
import { acceptRef, close, closeIdle, countersOf, emptyItems, escalate, findItem, fingerprintOf, idleAllowed, isParkedWait, liveItems, markStale, openItem, orphanDue, planRef, quoteOk, recordUserMessage, setFingerprint, tick, type Action, type Caps, type Item, type ItemsFile, type Outcome } from "./items.ts";
import { HeldQueue, resolveAllPending, RUN_ENDED_ANSWER, type Identity } from "./identity.ts";
import { decideTrust } from "./trust.ts";
import { parsePorcelainZ } from "./paths.ts";
import { buildRepos, crossRunOverlaps, foldersFor, hasKeyPrefix, subRepos, pickDiffBase, worktreesOf, type Repo, type Worktree } from "./repos.ts";
import { verdictMatches } from "./inbox.ts";
import { applyOutbox, combineRepos, deliveryMerged, endDecision, lastDelivery, mergeGateDecision, needsBiggerPage, parseMergedArgs, pickBase, pickGhRepo, prTreeIndex, shouldPoll, stateAfterVerdict, verdictPayload, type EndHow } from "./delivery.ts";
import { loadConfig, DEFAULTS, type OrchestrateConfig } from "./config.ts";
import { MODE_ENTRY, mergesPullRequest, modeFromEntries, onTyped, toolRefusal, type Mode } from "./mode.ts";
import { PROPOSAL_ASK_USER, PROPOSAL_FIX, RELAY_RUN_KICKOFF, repoTableText, RUN_KICKOFF, section } from "./prompts.ts";
import { authorityProblems, checkRunBriefs, claimHosted, type Executor, executorOf, findingsFile, type Hosted, hostedChange, hostedDecision, hostedOffText, RelayExec, type RepoFolders, relayNames, renderRelayBrief } from "./relay-exec.ts";
import { check, OFFLINE_SECONDS, type Snapshot } from "./monitor.ts";
import { boardLines, buildView, pendingOf, viewSig, widgetLines, type Paint, type SubInput, type View } from "./view.ts";
import {
	addAccepted, appendDecision, appendMerges, charterPath, decisionsPath, readAssumptions, appendMessage, commonDir, itemsPath, findSubByToplevel, listActiveRuns, norm, orchestraDir, readAccepted, readCursor, readItems, readMerges, readNew, readRun, readStatus, readSpawnRegistry, readView, runDir, sameDir, spawnRegistryPath, subDir, withoutSpawnEntries, withSpawnEntry, writeSpawnRegistry, writeCursor, writeItems, writeRun, writeStatus, writeView,
	type Exec, type Message, type SpawnEntry, type Status,
} from "./store.ts";

const ACTIVE: Sub["state"][] = ["spawning", "spawned", "planning", "executing", "awaiting-acceptance"];
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const RELAY_MERGE_HINT = "in a relay run the jobs merge on their own under the run's Authority; a held PR is merged by hand (by the user) and released by the orchestrator's poll";

export default function (pi: ExtensionAPI): void {
	const exec: Exec = async (command, args, opts) => {
		const r = await pi.exec(command, args, { cwd: opts?.cwd, timeout: 60_000 });
		return { stdout: r.stdout, stderr: r.stderr, code: r.killed ? 1 : (r.code ?? 1) };
	};
	const git = async (cwd: string, ...args: string[]): Promise<string | null> => {
		try {
			const r = await exec("git", ["-C", cwd, ...args]);
			return r.code === 0 ? r.stdout.trim() : null;
		} catch {
			return null;
		}
	};

	/** Like git() but the output is not trimmed (porcelain lines start with a space). */
	const gitRaw = async (cwd: string, ...args: string[]): Promise<string | null> => {
		try {
			const r = await exec("git", ["-C", cwd, ...args]);
			return r.code === 0 ? r.stdout : null;
		} catch {
			return null;
		}
	};

	let cfg: OrchestrateConfig = loadConfig(getAgentDir()).config;
	let uiCtx: ExtensionContext | undefined;
	const say = (msg: string, level: "info" | "warning" | "error" = "info") => {
		try {
			uiCtx?.ui.notify(`orchestrate: ${msg}`, level);
		} catch {
			// the context may be gone
		}
	};
	const sendToModel = (customType: string, content: string, deliverAs: "steer" | "followUp" = "followUp") => {
		try {
			pi.sendMessage({ customType, content, display: true }, { deliverAs, triggerTurn: true });
		} catch (e) {
			say(`could not deliver a message: ${(e as Error).message}`, "warning");
		}
	};

	/** A desktop notification; a failure is ignored. */
	const notifyDesktop = (title: string, body: string): void => {
		try {
			const nc = notifyCommand(process.platform, title, body);
			if (nc) execFile(nc.command, nc.args, { timeout: 10_000, windowsHide: true }, () => {});
		} catch {
			// no notification
		}
	};

	// ---------------------------------------------------------------- sub-session side

	interface Me {
		common: string;
		run: Run;
		sub: Sub;
		dir: string;
	}
	let me: Me | null = null;
	let started = false;
	let lastK4: Record<string, unknown> | undefined;
	let k4Waiters: Array<() => void> = [];
	let pendingAsk = new Map<string, (m: { text: string }) => void>();
	/** Who this session is: claims of K10-K13 are held while it is unknown (identity.ts). */
	let identity: Identity = "unknown";
	const heldPlan = new HeldQueue<unknown>();
	const heldMerge = new HeldQueue<unknown>();
	const heldAsk = new HeldQueue<unknown>();
	const heldIdle = new HeldQueue<unknown>();
	/** K12 asks that went to the orchestrator: askId -> the claim's resolver. */
	const askClaims = new Map<string, (v: unknown) => void>();
	const INSTANCE = randomUUID();
	/** An idle report that was posted and not yet ended (agent_start posts idle-end). */
	let idleOpen = false;
	let agentStarts = 0;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const IDLE_EXTRA_MS = 20_000;
	const releaseAsks = (): void => {
		const list = [...askClaims.values()];
		askClaims.clear();
		for (const r of list) r(null);
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
		idleOpen = false;
	};
	const releaseHeld = (): void => {
		for (const q of [heldPlan, heldMerge, heldAsk, heldIdle]) q.release();
	};
	type Claim = (p: Promise<unknown>) => void;
	/** One claim event: held while the identity is unknown, handled as a sub, left alone as anything else. */
	function route(held: HeldQueue<unknown>, handle: (data: unknown, claim: Claim) => void, data: unknown): void {
		if (identity === "not-sub" || !data || typeof data !== "object") return;
		const claim = (data as { claim?: unknown }).claim;
		if (typeof claim !== "function") return;
		if (identity === "unknown") {
			(claim as Claim)(held.hold(data));
			return;
		}
		handle(data, claim as Claim);
	}
	function becomeSub(): void {
		identity = "sub";
		heldPlan.replay(handlePlanReady);
		heldMerge.replay(handleMergeGate);
		heldAsk.replay(handleAsk);
		heldIdle.replay(handleIdle);
	}
	function becomeNotSub(): void {
		identity = "not-sub";
		releaseHeld();
	}
	let k10: { n: number; resolve: (v: unknown) => void } | null = null;
	const requestedTrees = new Set<string>();
	let generation = 0;
	let timers: ReturnType<typeof setInterval>[] = [];
	const every = (ms: number, fn: () => void | Promise<void>) => {
		let busy = false;
		const t = setInterval(() => {
			if (busy) return;
			busy = true;
			Promise.resolve(fn()).catch(() => {}).finally(() => {
				busy = false;
			});
		}, ms);
		t.unref?.();
		timers.push(t);
	};
	const stopTimers = () => {
		for (const t of timers) clearInterval(t);
		timers = [];
	};

	const f = (m: Me, name: string) => `${m.dir}/${name}`;

	const myBranches: string[] = [];
	/** Verdicts already handed to the model (no wait was set then): the replay must not send them again. */
	const toldModel = new Set<string>();
	/** Directives and info that arrived while the plan was under review (sent after the verdict). */
	const heldDuringReview: { type: string; text: string; data?: Record<string, unknown> }[] = [];
	const acceptanceOf = (k: Record<string, unknown> | undefined): { tree: string; since: string } | undefined => {
		const a = k?.acceptance as { tree?: unknown; since?: unknown } | undefined;
		return a && typeof a.tree === "string" && a.tree && typeof a.since === "string" ? { tree: a.tree, since: a.since } : undefined;
	};
	const deliveryOf = (k: Record<string, unknown> | undefined): { mergeMethod: string; deleteBranch: boolean } | undefined => {
		const d = k?.delivery as { mergeMethod?: unknown; deleteBranch?: unknown } | undefined;
		return d && typeof d.mergeMethod === "string" ? { mergeMethod: d.mergeMethod, deleteBranch: d.deleteBranch !== false } : undefined;
	};

	/** The run's target branches and the default branches: shared, never a package's own head branch. */
	const sharedBranch = (run: Run | null | undefined, b: string): boolean => b === "main" || b === "master" || Object.values(run?.targets ?? {}).some((t) => (t.startsWith("origin/") ? t.slice(7) : t) === b);

	/** Adds the branch checked out in `dir` to the status's branch list (restored from the old status file after a restart). */
	async function noteBranch(dir: string | undefined): Promise<void> {
		if (!me || !started || !dir) return;
		if (!myBranches.length) myBranches.push(...(readStatus(f(me, "status.json")).status?.branches ?? []).filter((b) => typeof b === "string"));
		const b = (await git(dir, "rev-parse", "--abbrev-ref", "HEAD"))?.trim();
		const dflt = (await git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"))?.trim().replace(/^origin\//, "");
		if (!b || b === "HEAD" || b === dflt || sharedBranch(readRun(me.common, me.run.id).run ?? me.run, b) || myBranches[myBranches.length - 1] === b) return;
		const at = myBranches.indexOf(b);
		if (at >= 0) myBranches.splice(at, 1);
		myBranches.push(b);
		while (myBranches.length > 20) myBranches.shift();
		writeMyStatus();
	}

	/** K15: hands the orchestrator's verdict on a tree to the workflow's acceptance wait. */
	function emitAcceptance(m: Message): void {
		pi.events.emit("workflow:acceptance", { v: 1, tree: String(m.data?.tree ?? ""), accept: m.data?.accept === true, ...(m.data?.merged ? { merged: m.data.merged } : {}), text: m.text });
	}

	/** After a restart (or when the verdict came before the wait was set): the newest verdict for the waiting tree that follows the newest request for it. */
	function replayVerdict(): void {
		if (!me || !started) return;
		const a = acceptanceOf(lastK4);
		if (!a) return;
		try {
			const out = readNew(f(me, "outbox.jsonl"), 0).msgs.filter((x) => x.type === "accept-request" && x.data?.tree === a.tree);
			const from = out.length ? out[out.length - 1].ts : a.since;
			const v = readNew(f(me, "inbox.jsonl"), 0).msgs.filter((x) => x.type === "accept-verdict" && x.data?.tree === a.tree && x.ts >= from && !toldModel.has(x.id));
			if (v.length) emitAcceptance(v[v.length - 1]);
		} catch {
			/* the next status change tries again */
		}
	}

	function writeMyStatus(): void {
		if (!me || !started) return;
		const k = lastK4 ?? {};
		const num = (v: unknown) => (typeof v === "number" ? v : undefined);
		const s: Status = {
			v: 1,
			phase: typeof k.phase === "string" ? k.phase : "off",
			flowId: typeof k.flowId === "string" ? k.flowId : undefined,
			title: typeof k.title === "string" ? k.title : undefined,
			stage: num(k.stage),
			stages: num(k.stages),
			done: num(k.done),
			total: num(k.total),
			waiting: k.waiting === true ? true : undefined,
			judging: k.judging === "plan" || k.judging === "discussion" ? k.judging : undefined,
			...(acceptanceOf(k) ? { acceptance: { tree: acceptanceOf(k)!.tree, since: acceptanceOf(k)!.since } } : {}),
			...(deliveryOf(k) ? { delivery: deliveryOf(k) } : {}),
			...(myBranches.length ? { branches: [...myBranches] } : {}),
			heartbeat: Date.now(),
			pid: process.pid,
		};
		try {
			writeStatus(f(me, "status.json"), s);
		} catch (e) {
			say(`could not write status: ${(e as Error).message}`, "warning");
		}
	}

	const post = (type: string, msg: string, data?: Record<string, unknown>, replyTo?: string): Message | null => {
		if (!me) return null;
		try {
			return appendMessage(f(me, "outbox.jsonl"), me.sub.id, { type, text: msg, data, replyTo });
		} catch (e) {
			say(`could not write to the orchestrator: ${(e as Error).message}`, "error");
			return null;
		}
	};

	pi.events.on("workflow:status", (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const k = data as Record<string, unknown>;
		lastK4 = k;
		if (mode !== "off" && !me && typeof k.phase === "string" && k.phase !== "off" && !k4Warned) {
			k4Warned = true;
			say(`the workflow is in phase ${k.phase} while orchestrator mode is ${mode}; the read-only guard stays on (/orch off lifts it)`, "warning");
		}
		const waiters = k4Waiters;
		k4Waiters = [];
		for (const w of waiters) w();
		if (!me || !started) return;
		writeMyStatus();
		void noteBranch(me.sub.cwd);
		replayVerdict();
	});

	/** K14: the flow ended (normally, stopped or abandoned); the orchestrator then checks the merge. */
	pi.events.on("workflow:flow-end", (data: unknown) => {
		if (!me || !started) return;
		const d = (data && typeof data === "object" ? data : {}) as { flowId?: unknown; how?: unknown };
		const how = d.how === "finished" || d.how === "stopped" || d.how === "abandoned" ? d.how : "unknown";
		post("flow-ended", `flow ${how}`, { flowId: typeof d.flowId === "string" ? d.flowId : undefined, how });
	});

	/** K10: the plan goes to the orchestrator instead of the menu. */
	pi.events.on("workflow:plan-ready", (data: unknown) => route(heldPlan, handlePlanReady, data));
	function handlePlanReady(data: unknown, claim: Claim): void {
		if (!me || !started) return;
		const d = data as { title?: unknown; plan?: unknown; judge?: unknown };
		const j = parsePlanJudge(d.judge);
		if (typeof d.plan !== "string") return;
		let n = 1;
		try {
			while (fs.existsSync(f(me, `plan-${n}.md`))) n++;
			const file = f(me, `plan-${n}.md`);
			fs.writeFileSync(file, d.plan + judgeSection(j));
			if (!post("plan-review", `Plan ${n} of package ${me.sub.id} is ready for review: ${file}`, { file, n, judgeLine: planReviewJudgeLine(j) })) return;
		} catch {
			return;
		}
		k10?.resolve(null);
		claim(new Promise((resolve) => {
			k10 = { n, resolve };
		}));
		updateSubStatus();
	}

	/** K12: a workflow menu or wait goes to the orchestrator (orch_decide); nothing shows locally. */
	pi.events.on("workflow:ask", (data: unknown) => route(heldAsk, handleAsk, data));
	function handleAsk(data: unknown, claim: Claim): void {
		if (!me || !started) return;
		const d = data as Record<string, unknown>;
		const id = typeof d.id === "string" ? d.id : "";
		if (!id) return;
		const { claim: _claim, ...rest } = d;
		const stage = typeof lastK4?.stage === "number" ? lastK4.stage : undefined;
		if (!post("ask", typeof d.title === "string" ? d.title : id, { ...rest, ...(stage !== undefined ? { stage } : {}) })) return;
		claim(new Promise((resolve) => {
			askClaims.set(id, resolve);
		}));
		updateSubStatus();
	}
	pi.events.on("workflow:ask-done", (data: unknown) => {
		const d = data as { id?: unknown; how?: unknown } | null;
		if (!me || typeof d?.id !== "string") return;
		askClaims.delete(d.id);
		post("ask-done", `ask ${d.id} ${String(d.how ?? "answered")}`, { id: d.id, how: d.how === "withdrawn" ? "withdrawn" : "answered" });
		updateSubStatus();
	});

	/** What the sub waits on from the orchestrator, for the idle gate. */
	function openRequests(): { plan: boolean; ask: boolean; question: boolean; accept: boolean } {
		let accept = false;
		try {
			if (me) accept = pendingOf(readNew(f(me, "outbox.jsonl"), 0).msgs, readNew(f(me, "inbox.jsonl"), 0).msgs).some((p) => p.kind === "accept");
		} catch {
			// unreadable: treat as none
		}
		return { plan: k10 !== null, ask: askClaims.size > 0, question: pendingAsk.size > 0, accept };
	}

	/** K13: the idle notice is the orchestrator's business; an `idle` report follows after 20 s more, unless the sub woke up or waits on something else. */
	pi.events.on("workflow:idle", (data: unknown) => route(heldIdle, handleIdle, data));
	function handleIdle(data: unknown, claim: Claim): void {
		if (!me || !started) return;
		claim(Promise.resolve({ handled: true }));
		const lastText = typeof (data as { lastText?: unknown }).lastText === "string" ? (data as { lastText: string }).lastText : "";
		const at = agentStarts;
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			const m = me;
			if (!m || agentStarts !== at || identity !== "sub") return;
			const fresh = readRun(m.common, m.run.id).run;
			if (!fresh || fresh.state === "ended") return;
			const state = fresh.subs.find((x) => x.id === m.sub.id)?.state ?? m.sub.state;
			if (!idleAllowed(state, openRequests())) return;
			if (post("idle", `Package ${m.sub.id} is idle: ${lastText.slice(-1500) || "(no text)"}`, { lastText: lastText.slice(-4000) })) idleOpen = true;
		}, IDLE_EXTRA_MS);
		idleTimer.unref?.();
	}
	pi.on("agent_start", async () => {
		if (me) {
			agentStarts++;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = undefined;
			if (idleOpen) {
				idleOpen = false;
				post("idle-end", "the sub-session is working again");
			}
		} else orchBusy = true;
	});
	pi.on("agent_end", async () => {
		if (!me) orchBusy = false;
	});

	/** D10: when the orchestrator is not running, say so once per item that has waited over 30 min. */
	const openSince = new Map<string, number>();
	const orphanNotified = new Set<string>();
	function checkOrphans(): void {
		const m = me;
		if (!m) return;
		const live = new Set<string>();
		for (const id of pendingAsk.keys()) live.add(`q:${id}`);
		if (k10) live.add(`plan:${k10.n}`);
		for (const id of askClaims.keys()) live.add(`ask:${id}`);
		try {
			for (const p of pendingOf(readNew(f(m, "outbox.jsonl"), 0).msgs, readNew(f(m, "inbox.jsonl"), 0).msgs)) if (p.kind === "accept") live.add(`accept:${p.repo ?? ""}:${p.ref}`);
		} catch {
			// unreadable
		}
		const now = Date.now();
		for (const k of live) if (!openSince.has(k)) openSince.set(k, now);
		for (const k of [...openSince.keys()]) {
			if (!live.has(k)) {
				openSince.delete(k);
				orphanNotified.delete(k);
			}
		}
		const old = [...openSince].filter(([k, at]) => !orphanNotified.has(k) && now - at >= 30 * 60_000);
		if (!old.length) return;
		const owner = readRun(m.common, m.run.id).run?.owner;
		if (!owner) return;
		for (const [k, at] of old) {
			if (!orphanDue({ ownerHost: owner.host, host: os.hostname(), ownerAlive: pidAlive(owner.pid), ageMs: now - at, alreadyNotified: orphanNotified.has(k) })) continue;
			orphanNotified.add(k);
			notifyDesktop("orchestrator not running", `Package ${m.sub.id} waits for the orchestrator: open it and run /orch watch`);
		}
	}

	/** K11: a merge needs the orchestrator's acceptance of the same tree. */
	pi.events.on("workflow:merge-gate", (data: unknown) => route(heldMerge, handleMergeGate, data));
	function handleMergeGate(data: unknown, claim: Claim): void {
		if (!me || !started) return;
		const d = data as { cwd?: unknown; tree?: unknown; ask?: unknown; kind?: unknown };
		const m = me;
		void noteBranch(typeof d.cwd === "string" && d.cwd ? d.cwd : m.sub.cwd);
		claim(
			(async () => {
				if (readRun(m.common, m.run.id).run?.state === "ended") return null; // the run is over: nobody can accept any more
				const dir = typeof d.cwd === "string" && d.cwd ? d.cwd : m.sub.cwd ?? "";
				// a multi-repo run is accepted per repo: find the worktree this merge is in
				let key = "";
				const fresh = readRun(m.common, m.run.id).run ?? m.run;
				if (fresh.repos?.length) {
					const top = norm((await git(dir, "rev-parse", "--show-toplevel")) ?? dir);
					const sub = fresh.subs.find((x) => x.id === m.sub.id) ?? m.sub;
					const wt = worktreesOf(sub, fresh).find((w) => sameDir(w.cwd, top));
					if (!wt) return { problem: `${top} is not a worktree of package ${m.sub.id} (its repos: ${worktreesOf(sub, fresh).map((w) => w.key).join(", ") || "none"}); the orchestrator accepts only the repos of the package.` };
					key = wt.key;
				}
				const treeGiven = typeof d.tree === "string" && !!d.tree;
				const tree = treeGiven ? (d.tree as string) : await git(dir, "rev-parse", "HEAD^{tree}");
				if (!tree) return { problem: "The orchestrator's acceptance check could not read the tree of this worktree." };
				const token = key ? `${key}:${tree}` : tree;
				// both the orchestrator's accepted.json and its accept-verdict message must name the tree (and the repo; a missing repo is the working repo)
				const workKey = fresh.repos?.[0]?.key ?? "";
				const verdict = readNew(f(m, "inbox.jsonl"), 0).msgs.some((x) => x.type === "accept-verdict" && x.data?.accept === true && x.data?.tree === tree && String(x.data?.repo ?? workKey) === key);
				const dec = mergeGateDecision({ ask: d.ask, kind: d.kind, tree, treeGiven, key, accepted: readAccepted(f(m, "accepted.json")).includes(token), verdictOk: verdict, requested: requestedTrees.has(token), runEnded: false });
				if (dec.mergePass) post("merge-pass", `Package ${m.sub.id} passed the gate for tree ${tree}${key ? ` of repo ${key}` : ""}.`, dec.mergePass);
				if (dec.request) {
					requestedTrees.add(token);
					const branch = (await git(dir, "rev-parse", "--abbrev-ref", "HEAD"))?.trim();
					post("accept-request", `Package ${m.sub.id} asks to ${dec.request.kind === "protected-push" ? "push to a protected branch" : dec.request.kind === "publish" ? "publish" : "merge"} tree ${tree}${key ? ` of repo ${key}` : ""}.`, { ...dec.request, ...(branch && branch !== "HEAD" ? { branch } : {}) });
					updateSubStatus();
				}
				if (dec.pass) return null;
				return { problem: dec.refusal ?? "refused", ...(d.ask === "gate" && (dec.request || requestedTrees.has(token)) ? { pending: true, tree } : {}) };
			})(),
		);
	}

	function deliverInbox(): void {
		if (!me) return;
		// the run is over: nobody will answer any more (every wait ends, no claim stays open)
		if (readRun(me.common, me.run.id).run?.state === "ended") {
			const n = resolveAllPending(pendingAsk, RUN_ENDED_ANSWER);
			k10?.resolve(null);
			k10 = null;
			releaseHeld();
			releaseAsks();
			if (n) updateSubStatus();
		}
		const file = f(me, "inbox.jsonl");
		const cur = f(me, "inbox.read");
		const r = readNew(file, readCursor(cur));
		for (const m of r.msgs) {
			// no directive or info reaches the executor while its plan is under review: hold it until the verdict
			if (k10 && (m.type === "directive" || m.type === "info")) {
				heldDuringReview.push(m);
				continue;
			}
			const pending = m.replyTo ? pendingAsk.get(m.replyTo) : undefined;
			if (m.type === "answer" && pending) {
				pending(m);
			} else if (m.type === "plan-verdict") {
				const approve = m.data?.approve === true;
				if (k10 && verdictMatches(k10.n, m)) {
					k10.resolve(approve ? { approve: true, ...(typeof m.data?.notes === "string" && m.data.notes ? { notes: m.data.notes } : {}) } : { reject: m.text || "the orchestrator rejected the plan" });
					k10 = null;
					say(approve ? "plan approved by the orchestrator" : `plan rejected: ${m.text}`);
				} else {
					say(`verdict for plan ${String(m.data?.n ?? "?")} ignored; ${k10 ? `plan ${k10.n} is under review` : "no plan is under review"}`, "warning");
				}
			} else if (m.type === "decision") {
				const id = String(m.data?.askId ?? "");
				const resolve = askClaims.get(id);
				if (!resolve) say(`a decision for ask ${id} arrived, but no such ask is open; ignored`, "warning");
				else {
					askClaims.delete(id);
					const t = typeof m.data?.text === "string" && m.data.text ? { text: m.data.text } : {};
					resolve(m.data?.resume === true ? { resume: true, ...t } : { choice: m.data?.choice, ...t });
				}
			} else if (m.type === "accept-verdict") {
				const waiting = acceptanceOf(lastK4)?.tree === String(m.data?.tree ?? "");
				emitAcceptance(m);
				if (m.data?.accept !== true) requestedTrees.delete(m.data?.repo ? `${String(m.data.repo)}:${String(m.data?.tree ?? "")}` : String(m.data?.tree ?? ""));
				if (!waiting) {
					toldModel.add(m.id);
					sendToModel("orchestrate-message", `Orchestrator (acceptance ${m.data?.accept === true ? "granted" : "refused"}): ${m.text}`);
				}
			} else if (m.type === "directive") {
				sendToModel("orchestrate-message", `Orchestrator directive: ${m.text}`, m.data?.urgent === true ? "steer" : "followUp");
			} else if (m.type === "answer") {
				sendToModel("orchestrate-message", `Orchestrator answer${m.replyTo ? ` to ${m.replyTo}` : ""}: ${m.text}`);
			} else {
				sendToModel("orchestrate-message", `Orchestrator${m.type === "accept-verdict" ? ` (acceptance ${m.data?.accept === true ? "granted" : "refused"})` : ""}: ${m.text}`);
			}
		}
		// flush once no review is open and the workflow is past the plan phase (its handover has been sent); polled every 3 s
		if (!k10 && heldDuringReview.length && lastK4?.phase !== "plan") {
			for (const m of heldDuringReview.splice(0)) sendToModel("orchestrate-message", `Orchestrator ${m.type === "directive" ? "directive" : "info"}: ${m.text}`, m.data?.urgent === true ? "steer" : "followUp");
		}
		if (r.cursor !== readCursor(cur) || r.bad) writeCursor(cur, r.cursor);
		if (r.bad) say(`${r.bad} unreadable line(s) in the inbox were skipped`, "warning");
		updateSubStatus();
		checkOrphans();
	}

	/** Sub-session status line: the package, and what it waits for from the orchestrator. */
	function updateSubStatus(): void {
		const ui = uiCtx?.ui;
		if (!me || !ui || !uiCtx?.hasUI) return;
		let waiting = "";
		if (k10) waiting = "plan review";
		else if (pendingAsk.size) waiting = "answer";
		else if (askClaims.size) waiting = "decision";
		else {
			try {
				const out = readNew(f(me, "outbox.jsonl"), 0).msgs;
				const inb = readNew(f(me, "inbox.jsonl"), 0).msgs;
				if (pendingOf(out, inb).some((p) => p.kind === "accept")) waiting = "acceptance";
			} catch {
				/* the status line is only informative */
			}
		}
		try {
			ui.setStatus("orchestrate", `orch ${me.run.id}/${me.sub.id}${waiting ? ` · waiting for orchestrator: ${waiting}` : ""}`);
		} catch {
			/* no status support */
		}
	}

	pi.registerTool({
		name: "ask_orchestrator",
		label: "Ask orchestrator",
		description: "Ask the orchestrator session a question about the brief, scope or a decision, and wait for its answer. Only in a session started by the orchestrator.",
		promptSnippet: "ask_orchestrator: ask the orchestrating session a question (orchestrated sub-sessions only)",
		parameters: Type.Object({ question: Type.String({ description: "The question, with what you already tried" }) }),
		async execute(_id, params, signal) {
			if (!me || !started) throw new Error("this session was not started by an orchestrator; ask the user directly");
			const q = post("question", params.question);
			if (!q) throw new Error("could not write the question");
			// no timeout and no fallback to the user: the wait ends on an answer, an abort or the end of the run
			const answer = await new Promise<{ text: string } | null>((resolve) => {
				const done = (v: { text: string } | null) => {
					pendingAsk.delete(q.id);
					updateSubStatus();
					signal?.removeEventListener("abort", onAbort);
					resolve(v);
				};
				const onAbort = () => done(null);
				pendingAsk.set(q.id, done);
				updateSubStatus();
				signal?.addEventListener("abort", onAbort);
			});
			if (!answer) return text("cancelled; the question stays open and a late answer arrives as a message");
			return text(answer.text);
		},
	});

	async function startSubSession(m: Me, ctx: ExtensionContext): Promise<void> {
		if (!lastK4) await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 10_000);
			k4Waiters.push(() => {
				clearTimeout(t);
				resolve();
			});
		});
		await new Promise((r) => setTimeout(r, 500));
		const briefPath = f(m, "brief.md");
		const claims = emitClaims((d) => pi.events.emit("workflow:start-plan", d), { v: 1, title: `${m.run.title}: ${m.sub.id}`, brief: kickoffText(m.sub, m.run, briefPath, decisionsPath(m.common, m.run.id)), allowTools: ["ask_orchestrator"] }, 10_000);
		const ans = (await claims.answer) as { ok?: boolean; error?: string } | null;
		if (!claims.claimed || !ans || ans.error || !ans.ok) {
			ctx.ui.notify(`orchestrate: could not start the flow from the brief (${!claims.claimed ? "workflow extension did not answer" : ans?.error ?? "no answer"}); brief: ${briefPath}`, "error");
			return;
		}
		started = true;
		writeMyStatus();
	}

	// ---------------------------------------------------------------- orchestrator mode

	let mode: Mode = "off";
	/** The newest finished proposal (propose mode): what "go" would run. Cleared by any other reply, typed text or mode change. */
	let lastProposal: { text: string; hash: string } | undefined;
	let proposalReview: ProposalReview | undefined;
	let proposalRun: { controller: AbortController; offEsc?: () => void; hash: string; reason?: "esc" | "command" | "force" | "message" | "mode" | "restart" } | undefined;
	function abortProposal(reason: "esc" | "command" | "force" | "message" | "mode" | "restart"): void {
		const r = proposalRun;
		if (!r || r.reason) return;
		r.reason = reason;
		r.controller.abort();
	}
	let k4Warned = false;
	const goRe = (): RegExp => {
		try {
			return new RegExp(cfg.approvePattern, "i");
		} catch {
			return new RegExp(DEFAULTS.approvePattern, "i");
		}
	};
	let orchPrevModel: SavedModel | undefined;
	/** Model switches run one after another, so a quick /orch off cannot be overtaken by the earlier switch. */
	let roleSwitchChain: Promise<void> = Promise.resolve();
	/** Puts the session on the orchestrator role's model; warns and keeps the current one when it is missing. Never throws. */
	async function applyOrchestratorRole(ctx: ExtensionContext): Promise<void> {
		try {
			const spec = cfg.roles.orchestrator;
			if (!spec) return;
			const slash = spec.model.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(spec.model.slice(0, slash), spec.model.slice(slash + 1)) : undefined;
			if (!model) return say(`model ${spec.model} (orchestrator) not found; keeping the current one`, "warning");
			if (!(await pi.setModel(model))) return say(`no credentials for ${spec.model} (orchestrator); keeping the current model`, "warning");
			if (spec.thinking) pi.setThinkingLevel(spec.thinking);
		} catch (e) {
			say(`could not switch the model: ${(e as Error).message}`, "warning");
		}
	}
	/** Puts back the model and thinking level from before orchestrator mode; keeps the current ones when the model is gone. */
	async function restoreModel(ctx: ExtensionContext, saved: SavedModel): Promise<void> {
		try {
			const slash = saved.model.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(saved.model.slice(0, slash), saved.model.slice(slash + 1)) : undefined;
			if (!model || !(await pi.setModel(model))) return say(`the model from before orchestrator mode (${saved.model}) is not available; keeping the current one`, "warning");
			if (saved.thinking) pi.setThinkingLevel(saved.thinking as ReturnType<typeof pi.getThinkingLevel>);
		} catch (e) {
			say(`could not restore the model: ${(e as Error).message}`, "warning");
		}
	}
	// ---- relay hosted mode (executor relay): claimed while an orchestrator mode is on
	let hosted: Hosted | undefined;
	/** A hosted claim or a job query met "no session context": retried at the first before_agent_start / input. */
	let hostedRetry = false;
	/** The open proposal-judge findings of the move to run; orch_run writes them to findings.md (relay runs). */
	let openFindings: Finding[] = [];
	/** The user typed something since the last proposal pause (relay: only then is a paused proposal judged again). */
	let userAnswered = false;
	/** The executor of the watched run, or else the configured one. */
	const executorNow = (): Executor => executorOf(owned ? { executor: owned.executor } : null, cfg.executor);
	async function claimRelay(retried: boolean): Promise<void> {
		const answer = await claimHosted((e, d) => pi.events.emit(e, d), true);
		hosted = hostedDecision(answer, retried);
		hostedRetry = hosted.state === "pending";
		if (hosted.state === "off") say(hostedOffText(hosted.reason), "error");
	}
	const releaseRelay = (): void => {
		hosted = undefined;
		hostedRetry = false;
		void claimHosted((e, d) => pi.events.emit(e, d), false);
	};
	/** At the first turn: the pending hosted claim and the relay rebuild are retried once. */
	function retryRelayAtTurn(): void {
		if (hostedRetry) {
			hostedRetry = false;
			void claimRelay(true);
		}
		if (relayExec?.needsContext) {
			relayExec.needsContext = false;
			void relayExec.tick().catch((e: Error) => say(e.message, "warning"));
		}
	}
	function setMode(m: Mode, announce = true, ctx?: ExtensionContext): void {
		const hostedDo = me ? null : hostedChange(mode, m, executorNow());
		const phase = typeof lastK4?.phase === "string" ? lastK4.phase : undefined;
		let action = roleSwitch({ from: mode, to: m, isSub: !!me, workflowPhase: phase, hasRole: !!cfg.roles.orchestrator, hasPrev: !!orchPrevModel });
		const warning = action === "warn" ? roleWarnText(m === "off" ? "off" : "on", phase ?? "?", orchPrevModel) : undefined;
		const saved = orchPrevModel;
		if (action === "apply") {
			if (!ctx) action = "none";
			else if (!ctx.model) {
				warning === undefined && say("orchestrate: no current model; the model was not switched", "warning");
				action = "none";
			} else orchPrevModel = { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel() };
		}
		abortProposal("mode");
		if (mode === "off" && m === "discuss") proposalReview = undefined;
		mode = m;
		lastProposal = undefined;
		k4Warned = false;
		try {
			pi.appendEntry(MODE_ENTRY, { v: 1, mode: m, prevModel: m === "off" ? undefined : orchPrevModel });
		} catch (e) {
			say(`could not save the mode: ${(e as Error).message}`, "warning");
		}
		if (announce) say(m === "off" ? "orchestrator mode off: the guard is lifted" : `orchestrator mode: ${m}`);
		if (warning) say(warning, "warning");
		if (action === "apply" && ctx) roleSwitchChain = roleSwitchChain.then(() => applyOrchestratorRole(ctx));
		else if (action === "restore" && ctx && saved) roleSwitchChain = roleSwitchChain.then(() => restoreModel(ctx, saved));
		if (m === "off") orchPrevModel = undefined;
		if (hostedDo === "on") void claimRelay(false);
		else if (hostedDo === "off") releaseRelay();
		updateWidget();
	}
	const assistantText = (m: unknown): string => {
		const a = m as { role?: string; content?: unknown } | undefined;
		if (!a || a.role !== "assistant" || !Array.isArray(a.content)) return "";
		return a.content.filter((c: { type?: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
	};

	// The section is always set (empty when off) so pi's patch replay of the system prompt stays stable.
	let repoTableCache: { key: string; text: string | undefined } | undefined;
	pi.on("before_agent_start", async (event, ctx) => {
		if (!me) retryRelayAtTurn();
		const sections = (event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions?.sections;
		if (!sections) return;
		let table: string | undefined;
		if (!me && (mode === "propose" || mode === "run")) {
			try {
				const key = `${ctx.cwd}|${addedOf(ctx).join("|")}`;
				if (repoTableCache?.key !== key) repoTableCache = { key, text: ((r) => (r ? repoTableText(r) : undefined))(await sessionRepos(ctx)) };
				table = repoTableCache.text;
			} catch {
				table = undefined;
			}
		}
		sections.orchestrate = me ? "" : section(mode, table, executorNow(), cfg.askUser);
	});

	pi.on("tool_call", async (event) => {
		if (me) return;
		const executor = executorNow();
		// merges of a live run go through /orch merge or orch_merge, also with the guard off
		if (event.toolName === "bash" && owned && mergesPullRequest(String((event.input as { command?: unknown } | undefined)?.command ?? ""))) {
			const live = current();
			const done: Sub["state"][] = executor === "relay" ? ["merged", "stopped", "failed", "blocked"] : ["merged", "stopped"];
			if (live && live.state !== "ended" && live.subs.some((s) => !done.includes(s.state))) return { block: true, reason: executor === "relay" ? RELAY_MERGE_HINT : "merges in a run go through /orch merge <id> (user) or orch_merge" };
		}
		const why = mode === "off" && !(owned && executor === "relay") ? null : toolRefusal(mode, event.toolName, (event.input ?? {}) as Record<string, unknown>, executor);
		if (why) return { block: true, reason: why };
		// the orchestrator stops a job itself (the stop passed the guard): no retry for it
		if (event.toolName === "relay_stop" && relayExec) {
			const job = (event.input as { job?: unknown } | undefined)?.job;
			if (typeof job === "string") await relayExec.markOwnStop(job);
		}
	});

	pi.on("input", async (event, ctx) => {
		// what the user types is the evidence for a userQuote on an escalated item (best effort)
		if (!me && owned && event.source !== "extension" && !event.text.trim().startsWith("/")) {
			recordUserMessage(itemsFile, event.text, Date.now());
			if (itemsFile.items.some((i) => i.state === "escalated")) saveItems();
		}
		if (!me && event.source !== "extension") retryRelayAtTurn();
		if (me || mode === "off" || event.source === "extension" || event.streamingBehavior) return { action: "continue" as const };
		const typed = event.text.trim();
		if (typed.startsWith("/")) return { action: "continue" as const };
		userAnswered = true;
		const isGo = goRe().test(typed);
		const gi = proposalGateOnInput({ running: !!proposalRun, isGo });
		if (gi === "notice") {
			say("proposal judge running (Esc or any other message cancels it)");
			return { action: "handled" as const };
		}
		if (gi === "cancel") abortProposal("message");
		if (mode === "propose" && isGo && lastProposal) {
			const d = proposalGateStart({ mode: cfg.autoJudgeProposal, hash: lastProposal.hash, last: proposalReview });
			if (d !== "move") {
				void runProposalGate(ctx, d, true);
				return { action: "handled" as const };
			}
		}
		const t = onTyped(mode, typed, !!lastProposal, goRe(), executorNow());
		lastProposal = undefined;
		if (!t) return { action: "continue" as const };
		setMode(t.mode, true, ctx);
		return { action: "transform" as const, text: `${typed}\n\n${t.append}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (me || (mode !== "propose" && mode !== "discuss")) return;
		const msgs = (event as { messages?: Array<{ role?: string; stopReason?: string }> }).messages ?? [];
		const last = [...msgs].reverse().find((m) => m.role === "assistant");
		const body = assistantText(last).trim();
		lastProposal = nextLastProposal(mode, body, last?.stopReason === "stop" && body.length > 0);
		const next = oneGoOnReply({ executor: executorNow(), mode, ready: !!lastProposal, running: !!proposalRun, status: proposalReview?.status, answered: userAnswered });
		if (next === "fix-reply" && proposalReview) {
			const a = proposalGateAfterFixReply({ prevHash: proposalReview.hash, ready: !!lastProposal, replyHash: lastProposal?.hash });
			if (a === "recheck") void runProposalGate(ctx, "recheck", false);
			else pauseProposal();
		} else if (next === "gate" && lastProposal) {
			// relay: a finished proposal goes to the gate on its own (one "go")
			const d = proposalGateStart({ mode: cfg.autoJudgeProposal, hash: lastProposal.hash, last: proposalReview });
			if (d === "move") moveToRun(ctx, proposalReview?.hash === lastProposal.hash ? blockingFindings(proposalReview.findings) : []);
			else void runProposalGate(ctx, d, true);
		}
	});

	function saveReview(): void {
		if (!proposalReview) return;
		try {
			pi.appendEntry(GATE_ENTRY, { v: 1, ...proposalReview });
		} catch (e) {
			say(`could not save the proposal gate state: ${(e as Error).message}`, "warning");
		}
	}
	/** `ask`: the findings routed to the user; a relay run has the model ask them (the next finished proposal is judged again). */
	function pauseProposal(ask?: Finding[]): void {
		if (proposalReview) proposalReview = { ...proposalReview, status: "paused" };
		userAnswered = false;
		saveReview();
		if (pauseAction(executorNow()) === "wait-go") return say(`the proposal judge needs your decision; answer, then say "go" (or /orch go force)`, "warning");
		say("the proposal judge needs your decision; answer the question, the revised proposal is judged again on its own", "warning");
		if (ask?.length) sendToModel("orchestrate-proposal-ask", `${PROPOSAL_ASK_USER}\n\n${findingsBlock(ask)}`);
	}
	/** Leaves propose for run and sends the kickoff, with the open judge findings when there are any. */
	function moveToRun(ctx: ExtensionContext, open: Finding[], notes: Finding[] = []): void {
		if (proposalReview) proposalReview = { ...proposalReview, status: "idle" };
		openFindings = open;
		setMode("run", true, ctx);
		sendToModel("orchestrate-run-kickoff", (executorNow() === "relay" ? RELAY_RUN_KICKOFF : RUN_KICKOFF) + (open.length ? `\n\nOpen proposal-judge findings; settle them in the briefs' decisions:\n${findingsBlock(open)}` : "") + (notes.length ? `\n\nMinor proposal-judge notes (not blockers; take them into the briefs where they fit):\n${findingsBlock(notes)}` : ""));
	}
	async function runJudge(ctx: ExtensionContext, systemPrompts: string[], signal: AbortSignal): Promise<{ ok: boolean; text: string; error?: string }> {
		const role = cfg.roles.judge ?? (ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: "high" as const } : undefined);
		if (!role) return { ok: false, text: "", error: "no model for the judge" };
		return runSubagent({ role, systemPrompts, tools: cfg.judge.tools, task: "Review the package proposal as described in your system prompt.", cwd: ctx.cwd, extensions: cfg.judge.extensions, timeoutMs: cfg.judge.timeoutMs, idleTimeoutMs: cfg.judge.idleTimeoutMs, signal });
	}
	async function runProposalGate(ctx: ExtensionContext, decision: "full" | "recheck", resetRounds: boolean): Promise<void> {
		uiCtx = ctx;
		abortProposal("restart");
		const lp = lastProposal;
		if (!lp) return say("nothing to judge");
		let rounds = proposalGateRounds({ resetRounds, last: proposalReview });
		const run: NonNullable<typeof proposalRun> = { controller: new AbortController(), hash: lp.hash };
		proposalRun = run;
		if (ctx.hasUI) run.offEsc = ctx.ui.onTerminalInput((d) => (isEscKey(d) ? (abortProposal("esc"), { consume: true }) : undefined));
		updateWidget();
		let repoTable: string | undefined;
		try {
			const repos = await sessionRepos(ctx);
			repoTable = repos ? repoTableText(repos) : undefined;
		} catch {
			// the judge then gets the single-repo note
		}
		const prompts = proposalReviewPrompts({ proposal: lp.text, list: lastAgreedList(branchAssistantTexts(ctx.sessionManager.getBranch())), repoTable, recheck: decision === "recheck" ? proposalReview?.findings : undefined, executor: executorNow() });
		let res: { ok: boolean; text: string; error?: string };
		try {
			if (run.reason || proposalRun !== run) throw new Error("cancelled");
			ctx.ui.setWorkingMessage("judge reviewing the proposal…");
			res = await runJudge(ctx, prompts, run.controller.signal);
		} catch (e) {
			res = { ok: false, text: "", error: (e as Error).message };
		} finally {
			run.offEsc?.();
			if (proposalRun === run) proposalRun = undefined;
			try {
				ctx.ui.setWorkingMessage();
			} catch {
				// the context may be gone
			}
			updateWidget();
		}
		if (run.reason) {
			if (run.reason === "esc" || run.reason === "command") {
				say("proposal judge cancelled; still in propose");
				if (proposalReview) {
					proposalReview = { ...proposalReview, status: "idle" };
					saveReview();
				}
			}
			return;
		}
		if (mode !== "propose" || lastProposal?.hash !== run.hash) return;
		if (!res.ok || !res.text.trim()) {
			say(`proposal judge did not run: ${res.error ?? "empty result"}`, "warning");
			return moveToRun(ctx, []);
		}
		const findings = parseFindings(res.text);
		const verdict = judgeVerdict(res.text);
		rounds += 1;
		proposalReview = { hash: run.hash, verdict, findings, rounds, status: "idle" };
		saveReview();
		try {
			pi.sendMessage({ customType: "orchestrate-proposal-review", content: `Proposal judge: ${verdict}${findings.length ? `\n${findingsBlock(findings)}` : ""}`, display: true });
		} catch {
			// display only
		}
		const next = proposalGateAfterVerdict({ verdict, findings, rounds, max: cfg.maxProposalJudgeRounds });
		if (next === "move") return moveToRun(ctx, [], minorFindings(findings));
		if (next === "move-open") return moveToRun(ctx, blockingFindings(findings), minorFindings(findings));
		if (next === "fix") {
			proposalReview = { ...proposalReview, status: "awaiting-fix" };
			saveReview();
			return sendToModel("orchestrate-proposal-fix", `${PROPOSAL_FIX}\n\n${findingsBlock(blockingFindings(findings).filter((f) => f.route === "auto"))}`);
		}
		pauseProposal(blockingFindings(findings).filter((f) => f.route === "user"));
	}

	// ---------------------------------------------------------------- orchestrator side

	interface Owned {
		common: string;
		runId: string;
		repoCwd: string;
		/** The run's executor (absent: workflow). */
		executor?: Executor;
	}
	let owned: Owned | null = null;
	/** The relay executor of the watched relay run (relay-exec.ts). */
	let relayExec: RelayExec | undefined;
	const snaps = new Map<string, Snapshot>();
	/** Last known PR state per sub and repo key (from checkEnded). */
	const prs = new Map<string, Map<string, "merged" | "not merged" | "unknown">>();
	const setPr = (id: string, key: string, ok: boolean | null): void => {
		const m = prs.get(id) ?? new Map();
		m.set(key, ok === null ? "unknown" : ok ? "merged" : "not merged");
		prs.set(id, m);
	};
	let currentView: View | null = null;
	let lastViewSig = "";
	let viewWarned = false;
	let widgetTui: { requestRender(): void } | undefined;
	let widgetMounted = false;
	let events: string[] = [];
	const spawning = new Set<string>();
	let queue: Promise<unknown> = Promise.resolve();
	const corruptSeen = new Set<string>();

	/** Serialised read-modify-write of run.json (this session is its only writer). */
	function mutate<T>(fn: (run: Run) => T): Promise<T> {
		const o = owned;
		const p = queue.then(() => {
			if (!o) throw new Error("no active run in this session");
			const r = readRun(o.common, o.runId);
			if (!r.run) throw new Error(r.corrupt ?? "run.json is missing");
			const out = fn(r.run);
			writeRun(o.common, r.run);
			return out;
		});
		queue = p.catch(() => {});
		return p;
	}
	/** Whether the project is trusted now (stored on the run: only then are spawned worktrees trusted). A throw counts as not trusted. */
	const projectTrusted = (ctx: ExtensionContext): boolean => {
		try {
			return ctx.isProjectTrusted() === true;
		} catch {
			return false;
		}
	};
	/**
	 * The per-user registry that the trust handler relies on (outside every repo). Only a run whose origin was trusted writes it.
	 * A failure to write is not fatal: the worktree then just gets the normal trust prompt.
	 */
	function registry(change: (list: SpawnEntry[]) => SpawnEntry[]): void {
		let lock: number | undefined;
		const dir = getAgentDir();
		const lockFile = spawnRegistryPath(dir) + ".lock";
		try {
			// a lock file keeps two orchestrators from overwriting each other (stale after 5 s)
			for (let i = 0; i < 20 && lock === undefined; i++) {
				try {
					lock = fs.openSync(lockFile, "wx");
				} catch {
					try {
						if (Date.now() - fs.statSync(lockFile).mtimeMs > 5000) fs.unlinkSync(lockFile);
					} catch {
						// gone already
					}
					const until = Date.now() + 50;
					while (Date.now() < until) { /* short wait */ }
				}
			}
			writeSpawnRegistry(dir, change(readSpawnRegistry(dir)));
		} catch (e) {
			say(`could not update the spawn registry: ${(e as Error).message}`, "warning");
		} finally {
			if (lock !== undefined) {
				fs.closeSync(lock);
				try {
					fs.unlinkSync(lockFile);
				} catch {
					// ignore
				}
			}
		}
	}
	const registerSpawn = (run: Run, common: string, subId: string, state: "spawning" | "spawned", tops: string[]): void => {
		if (run.originTrusted !== true) return;
		registry((l) => withSpawnEntry(l, { runId: run.id, common, sub: subId, state, at: new Date().toISOString(), tops }));
	};
	const unregister = (runId: string, subId?: string): void => registry((l) => (l.some((e) => e.runId === runId && (subId === undefined || e.sub === subId)) ? withoutSpawnEntries(l, runId, subId) : l));
	/** Subs stuck in `spawning` go back to `planned` (a crash during orch_spawn): reported, not silent. */
	async function resetStaleSpawning(run: Run): Promise<void> {
		const alive = run.owner.host !== os.hostname() || pidAlive(run.owner.pid) || run.owner.pid === process.pid;
		const stale = staleSpawning(run, Date.now(), alive);
		if (!stale.length) return;
		await mutate((r) => {
			for (const id of stale) revertSpawning(subOf(r, id));
		});
		for (const id of stale) unregister(run.id, id);
		for (const id of stale) say(`reset ${id} to planned; if a worktree exists use /wt open or /wt remove`, "warning");
	}
	const current = (): Run | null => (owned ? readRun(owned.common, owned.runId).run ?? null : null);
	const need = (): { o: Owned; run: Run } => {
		const run = current();
		if (!owned || !run) throw new Error("no active run in this session; start one with orch_run or /orch watch");
		return { o: owned, run };
	};
	const subOf = (run: Run, id: string): Sub => {
		const s = run.subs.find((x) => x.id === id);
		if (!s) throw new Error(`unknown package "${id}" (have: ${run.subs.map((x) => x.id).join(", ")})`);
		return s;
	};
	const sf = (o: Owned, id: string, name: string) => `${subDir(o.common, o.runId, id)}/${name}`;

	// ---- items: what the sub-sessions wait on, with reminders, escalation and caps (items.ts, decide.ts)
	let itemsFile: ItemsFile = emptyItems();
	let orchBusy = false;
	let lastTickAt = 0;
	const caps = (): Caps => ({ maxPlanRejections: cfg.maxPlanRejections, maxReplans: cfg.maxReplans, maxAutoAnswers: cfg.maxAutoAnswers, maxIdleAnswers: cfg.maxIdleAnswers });
	const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

	function loadItems(o: Owned): void {
		const r = readItems(o.common, o.runId);
		if (r.corrupt) {
			say(`${r.corrupt}; starting with no items (the old file is kept as items.json.corrupt)`, "warning");
			try {
				fs.copyFileSync(itemsPath(o.common, o.runId), `${itemsPath(o.common, o.runId)}.corrupt`);
			} catch {
				// nothing to keep
			}
		}
		itemsFile = r.file;
	}
	function saveItems(): void {
		const o = owned;
		if (!o) return;
		try {
			writeItems(o.common, o.runId, itemsFile);
		} catch (e) {
			say(`could not write items.json: ${(e as Error).message}`, "warning");
		}
	}

	/** One line about an item, for messages to the model. */
	function describeItem(i: Item): string {
		const where = `[${i.sub}]`;
		if (i.kind === "question") return `${where} question ${i.ref}: ${clipText(i.summary, 300)}`;
		if (i.kind === "menu") return `${where} menu ${i.key} (askId ${i.ref}): ${clipText(i.summary, 200)}`;
		if (i.kind === "wait") return `${where} wait (askId ${i.ref}): ${clipText(i.summary, 300)}`;
		if (i.kind === "idle") return `${where} idle report ${i.ref}: ${clipText(i.summary, 300)}`;
		if (i.kind === "plan-review") return `${where} plan ${i.n ?? "?"} review`;
		return `${where} accept request for tree ${(i.tree ?? "").slice(0, 12)}${i.repo ? ` of repo ${i.repo}` : ""}`;
	}
	const answerTool = (i: Item): string =>
		i.kind === "question" ? `orch_send {id:"${i.sub}", type:"answer", replyTo:"${i.ref}", text}` : i.kind === "menu" || i.kind === "wait" ? `orch_decide {id:"${i.sub}", askId:"${i.ref}", ...}` : i.kind === "plan-review" ? `orch_review_plan {id:"${i.sub}", n:${i.n ?? "?"}, ...}` : i.kind === "accept-request" ? `orch_accept {id:"${i.sub}"${i.repo ? `, repo:"${i.repo}"` : ""}, ...}` : `orch_send {id:"${i.sub}", type:"directive", replyTo:"${i.ref}", text}`;

	/** Reminders and escalations: a desktop notification and a message for the orchestrator model (unless `quiet`: its tool result says it). */
	function handleActions(actions: Action[], quiet = false): void {
		for (const a of actions) {
			if (a.type === "step-back") {
				events.push(`Limit reached (${a.why}): ${describeItem(a.item)}. Do not ask the user. Step back: re-read the brief, the plan and the decision log, ask the advisor, then replan, split or narrow the package (answer the item with a different approach, or send a directive after it). Stopping a package is reserved for the user.`);
				continue;
			}
			if (a.type === "remind") {
				if (a.overdue) uiCtx?.ui?.notify?.(`orchestrate: ${a.item.sub} waits for the orchestrator (${a.overdue})`, "warning");
				events.push(`Still open${a.overdue ? ` (${a.overdue})` : ""}: ${describeItem(a.item)}. Answer it (${answerTool(a.item)}); call orch_escalate {id:"${a.item.sub}", ref:"${a.item.ref}", question} only for a reserved action.`);
				continue;
			}
			notifyDesktop("orchestrate: needs you", `${a.item.sub}: ${clipText(a.item.escalation ?? a.item.summary, 160)}`);
			if (!quiet) events.push(`Escalated to the user (${a.why}): ${describeItem(a.item)}. Show it to them with its options and relay their answer with ${answerTool(a.item)} and a userQuote (an exact piece of what they typed after this message).`);
		}
	}

	/** The orchestrator's own clock for reminders: idle time counts only while this session is not working. */
	async function itemTick(): Promise<void> {
		if (!owned) return;
		const now = Date.now();
		const elapsed = lastTickAt ? now - lastTickAt : 0;
		lastTickAt = now;
		const actions = tick(itemsFile, now, !orchBusy, elapsed);
		if (liveItems(itemsFile).length) saveItems();
		if (!actions.length) return;
		handleActions(actions);
		flush();
		refreshView();
	}

	const askText = (sub: string, m: Message): string => {
		const d = m.data ?? {};
		const id = String(d.id ?? "");
		const detail = d.detail ? `\nDetail:\n${String(d.detail).slice(0, 3000)}` : "";
		if (d.kind === "wait") {
			const w = (d.wait ?? {}) as { reason?: unknown; check?: unknown; waitKind?: unknown; checkStatus?: unknown };
			if (isParkedWait(w)) return `[${sub}] waits (resumes by itself when its check passes: ${String(w.check)}): ${String(w.reason ?? m.text)}. Nothing to answer; to end it early, send it a message with orch_send.`;
			return `[${sub}] asks for the user (wait, askId ${id}): ${String(w.reason ?? m.text)}${w.check ? ` (it also resumes by itself when its check passes: ${String(w.check)})` : ""}${detail}\nWaits always go to the user; it is escalated.`;
		}
		const roles = (d.roles ?? {}) as Record<string, string>;
		const options = Array.isArray(d.options) ? (d.options as unknown[]).map(String) : [];
		return `[${sub}] menu ${String(d.key ?? "?")} (askId ${id}): ${m.text}\nOptions: ${options.map((o) => `${o}${roles[o] ? ` [${roles[o]}]` : ""}`).join(" | ")}${detail}\nAnswer it with orch_decide {id:"${sub}", askId:"${id}", choice, text?}.`;
	};

	/** Writes an answer to an item: the item is closed and counted. */
	function closeItem(sub: string, ref: string, how: "answered" | "withdrawn" | "stale", byUser: boolean, outcome?: Outcome): void {
		if (close(itemsFile, sub, ref, { how, byUser, outcome })) {
			saveItems();
			refreshView();
		}
	}

	function stopWatcher(): void {
		stopTimers();
		owned = null;
		relayExec = undefined;
		snaps.clear();
		prs.clear();
		defaultBranches.clear();
		events = [];
		itemsFile = emptyItems();
		currentView = null;
		lastViewSig = "";
		updateWidget();
	}

	const paintWith = (theme: { fg: (c: string, t: string) => string }): Paint => (kind, t) => {
		const c = { accent: "accent", dim: "dim", warn: "warning", ok: "success", err: "error", plain: "" }[kind];
		return c ? theme.fg(c, t) : t;
	};

	/** The widget lives while a mode is on or a run is watched; it re-renders from `currentView`. */
	function updateWidget(): void {
		const ui = uiCtx?.ui;
		if (!ui || !uiCtx?.hasUI) return;
		if (mode === "off" && !owned) {
			if (widgetMounted) ui.setWidget("orchestrate", undefined);
			widgetMounted = false;
			widgetTui = undefined;
			return;
		}
		if (!widgetMounted) {
			widgetMounted = true;
			ui.setWidget("orchestrate", (tui: { requestRender(): void }, theme: { fg: (c: string, t: string) => string }) => {
				widgetTui = tui;
				return {
					render: (width: number) => widgetLines(currentView, mode, Date.now(), paintWith(theme), width, proposalRun ? "proposal" : undefined).map((l) => truncateToWidth(l, width)),
					invalidate: () => undefined,
					dispose: () => {
						widgetTui = undefined;
						widgetMounted = false;
					},
				};
			});
		}
		widgetTui?.requestRender();
	}

	/** Builds view.json from the files and snapshots; writes it (this watcher is its only writer) and redraws only when it changed. */
	function refreshView(): void {
		const o = owned;
		const run = current();
		if (!o || !run) return;
		try {
			const inputs = new Map<string, SubInput>();
			for (const s of run.subs) {
				const snap = snaps.get(s.id);
				inputs.set(s.id, {
					status: readStatus(sf(o, s.id, "status.json")).status,
					files: snap?.files,
					drift: snap?.reported.drift,
					overlap: snap?.reported.overlap,
					stalled: snap?.reported.stalled,
					outbox: readNew(sf(o, s.id, "outbox.jsonl"), 0).msgs,
					inbox: readNew(sf(o, s.id, "inbox.jsonl"), 0).msgs,
					accepted: readAccepted(sf(o, s.id, "accepted.json")),
					items: liveItems(itemsFile, s.id),
					prs: prs.get(s.id),
				});
			}
			const v = buildView(run, Date.now(), cfg.maxSubs, inputs, OFFLINE_SECONDS);
			currentView = v;
			const sig = viewSig(v);
			if (sig === lastViewSig) return;
			lastViewSig = sig;
			writeView(o.common, o.runId, v);
			updateWidget();
		} catch (e) {
			if (!viewWarned) {
				viewWarned = true;
				say(`could not write view.json: ${(e as Error).message}`, "warning");
			}
		}
	}

	function flush(): void {
		if (!events.length) return;
		const content = events.join("\n\n");
		events = [];
		sendToModel("orchestrate-events", content);
	}

	const workingKey = (run: Run): string => run.repos?.[0]?.key ?? "";
	/** The orchestrator's checkout of the repo `key` (the working repo for key ""). */
	const topOfKey = (o: Owned, run: Run, key: string): string => run.repos?.find((r) => r.key === key)?.top ?? o.repoCwd;
	const prefix = (key: string, file: string): string => (key ? `${key}:${norm(file)}` : norm(file));


	async function readOutboxes(): Promise<void> {
		const o = owned;
		const run = current();
		if (!o || !run) return;
		const ended: Array<{ id: string; at: string; how: EndHow }> = [];
		let dirty = false;
		const stateChanges: Array<[string, Sub["state"]]> = [];
		for (const sub of run.subs) {
			if (!ACTIVE.includes(sub.state)) continue;
			const file = sf(o, sub.id, "outbox.jsonl");
			const cur = sf(o, sub.id, "outbox.read");
			const r = readNew(file, readCursor(cur));
			const ob = applyOutbox(r.msgs);
			if (ob.merges.length) {
				try {
					appendMerges(sf(o, sub.id, "merges.json"), ob.merges);
				} catch (e) {
					events.push(`[${sub.id}] could not save its merge records: ${(e as Error).message}`);
				}
			}
			if (ob.end) ended.push({ id: sub.id, ...ob.end });
			for (const m of ob.rest) {
				const head = `[${sub.id}]`;
				const stage = typeof m.data?.stage === "number" ? m.data.stage : readStatus(sf(o, sub.id, "status.json")).status?.stage;
				const open = (): void => {
					handleActions(openItem(itemsFile, { sub: sub.id, type: m.type, id: m.id, text: m.text, data: m.data, stage }, caps(), Date.now()));
					dirty = true;
				};
				if (m.type === "ask") {
					events.push(askText(sub.id, m));
					open();
					continue;
				}
				if (m.type === "ask-done") {
					closeItem(sub.id, String(m.data?.id ?? ""), m.data?.how === "withdrawn" ? "withdrawn" : "answered", false);
					continue;
				}
				if (m.type === "idle") {
					events.push(`${head} is idle (nothing open, no progress). Its last message:\n${String(m.data?.lastText ?? m.text).slice(-1500)}\nAnswer with orch_send (a directive says what to do next) or call orch_escalate.`);
					open();
					continue;
				}
				if (m.type === "idle-end") {
					closeIdle(itemsFile, sub.id, true);
					dirty = true;
					continue;
				}
				if (m.type === "session-started") {
					const stale = markStale(itemsFile, sub.id, String(m.data?.instance ?? ""));
					dirty = true;
					if (stale.length) events.push(`${head} restarted; its open menu and plan reviews are stale (${stale.map((i) => i.ref).join(", ")}). Send it a directive (orch_send) to continue.`);
					continue;
				}
				if (m.type === "question") events.push(`${head} question (id ${m.id}): ${m.text}\nAnswer it with orch_send {id:"${sub.id}", type:"answer", replyTo:"${m.id}", text}.`);
				else if (m.type === "plan-review") events.push(`${head} plan ${String(m.data?.n ?? "?")} ready: ${String(m.data?.file ?? "")}\nRead it against the brief (${sf(o, sub.id, "brief.md")}), then call orch_review_plan with n=${String(m.data?.n ?? "?")}. Refuse a plan that does not cover every stage the brief asks for.${typeof m.data?.judgeLine === "string" && m.data.judgeLine ? `\n${m.data.judgeLine}` : ""}`);
				else if (m.type === "accept-request") {
					stateChanges.push([sub.id, "awaiting-acceptance"]);
					const repoKey = String(m.data?.repo ?? workingKey(run));
					const wt = worktreesOf(sub, run).find((w) => w.key === repoKey) ?? { key: repoKey, cwd: sub.cwd ?? "", base: sub.base };
					events.push(`${head} asks to ${m.data?.kind === "protected-push" ? "push to a protected branch" : m.data?.kind === "publish" ? "publish" : "merge"} tree ${String(m.data?.tree ?? "?")}${run.repos ? ` of repo ${repoKey}` : ""}. Check its diff against the brief's criteria (git -C ${wt.cwd} diff ${await diffBase(wt, o, run)}...HEAD), then call orch_accept${run.repos ? ` with repo "${repoKey}"` : ""}.`);
				} else events.push(`${head} ${m.type}: ${m.text}`);
				if (m.type === "question" || m.type === "plan-review" || m.type === "accept-request") open();
			}
			if (r.bad) events.push(`[${sub.id}] ${r.bad} unreadable line(s) in its outbox were skipped.`);
			if (r.cursor !== readCursor(cur)) writeCursor(cur, r.cursor);
		}
		if (ended.length) {
			const at = new Date().toISOString();
			await mutate((r) => {
				for (const e of ended) {
					const s = r.subs.find((x) => x.id === e.id);
					if (!s || s.state === "merged") continue;
					s.endedAt = e.at || at;
					s.endHow = e.how;
					s.endChecks = 0;
					s.endReported = false;
				}
			});
		}
		if (stateChanges.length) {
			const ready = await mutate((r) => {
				for (const [id, st] of stateChanges) {
					const s = r.subs.find((x) => x.id === id);
					if (s && s.state !== "merged") s.state = st;
				}
			});
		}
		if (ended.length) events.push(...(await checkEnded(false))); // a quick first answer; later polls retry
		if (dirty) saveItems();
		flush();
		refreshView();
	}

	const defaultBranches = new Map<string, string | null>();
	const treeCache = new Map<string, string>();
	const treeFailed = new Map<string, number>();
	const remotesCache = new Map<string, Array<{ name: string; url: string }>>();
	const pushConfirmed = new Set<string>();
	let checkRound = 0;
	let checkChain: Promise<unknown> = Promise.resolve();

	async function remotesOf(top: string): Promise<Array<{ name: string; url: string }>> {
		const hit = remotesCache.get(top);
		if (hit) return hit;
		const out = (await git(top, "remote", "-v")) ?? "";
		const list: Array<{ name: string; url: string }> = [];
		for (const line of out.split("\n")) {
			const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
			if (m) list.push({ name: m[1], url: m[2] });
		}
		if (list.length) remotesCache.set(top, list);
		return list;
	}

	/** gh is always told the repo (owner/name) of the target's remote; its own resolution is never used. */
	async function ghRepoOf(top: string, ref: string | null): Promise<{ remote: string; slug: string } | null> {
		return pickGhRepo(await remotesOf(top), ref);
	}

	async function ghMerged(slug: string, branch: string): Promise<boolean | null> {
		try {
			const r = await exec("gh", ["pr", "list", "-R", slug, "--head", branch, "--state", "merged", "--json", "number"]);
			if (r.code !== 0) return null;
			const arr = JSON.parse(r.stdout || "[]") as unknown;
			return Array.isArray(arr) && arr.length > 0;
		} catch {
			return null;
		}
	}

	async function treeOfSha(top: string, slug: string, sha: string): Promise<string | null> {
		const k = `${slug}|${sha}`;
		const hit = treeCache.get(k);
		if (hit) return hit;
		let t = await git(top, "rev-parse", `${sha}^{tree}`);
		let tried = false;
		if (!t && Date.now() - (treeFailed.get(k) ?? 0) > 10 * 60_000) {
			tried = true;
			try {
				const g = await exec("gh", ["api", `repos/${slug}/commits/${sha}`, "--jq", ".commit.tree.sha"]);
				if (g.code === 0 && /^[0-9a-f]{40}$/.test(g.stdout.trim())) t = g.stdout.trim();
			} catch {}
		}
		if (t) treeCache.set(k, t);
		else if (tried) treeFailed.set(k, Date.now());
		return t;
	}

	/** The branches a package's pull requests have as head: the branches in its accept requests, in its status, and its spawn branch (newest first). */
	function branchesOf(o: Owned, sub: Sub): string[] {
		const out: string[] = [];
		const run = current();
		const add = (b: unknown): void => {
			if (typeof b === "string" && b && b !== "HEAD" && !sharedBranch(run, b) && !out.includes(b)) out.push(b);
		};
		for (const m of readNew(sf(o, sub.id, "outbox.jsonl"), 0).msgs.reverse()) if (m.type === "accept-request") add(m.data?.branch);
		for (const b of [...(readStatus(sf(o, sub.id, "status.json")).status?.branches ?? [])].reverse()) add(b);
		add(sub.branch);
		return out;
	}

	/** The merged PRs of one repo since the run was created, by head tree: those of one head branch (any base), else of one base. Listed at most once per round. */
	async function listMerged(top: string, slug: string, filter: { head?: string; base?: string | null }, created: string): Promise<{ trees: Map<string, number>; unknown: boolean; reason?: string }> {
		const fetchPage = async (limit: number): Promise<Array<{ number: number; headRefOid: string; mergedAt?: string | null }> | null> => {
			try {
				const args = ["pr", "list", "-R", slug, "--state", "merged", ...(filter.head ? ["--head", filter.head] : filter.base ? ["--base", filter.base] : []), "--limit", String(limit), "--json", "number,headRefOid,mergedAt"];
				const r = await exec("gh", args);
				if (r.code !== 0) return null;
				const arr = JSON.parse(r.stdout || "[]") as unknown;
				return Array.isArray(arr) ? (arr as Array<{ number: number; headRefOid: string; mergedAt?: string | null }>) : null;
			} catch {
				return null;
			}
		};
		let prs = await fetchPage(200);
		if (prs && needsBiggerPage(prs.length, 200)) prs = await fetchPage(1000);
		if (!prs) return { trees: new Map(), unknown: true };
		if (needsBiggerPage(prs.length, 1000)) return { trees: new Map(), unknown: true, reason: "too many merged PRs to check" };
		const shas = new Map<string, string | null>();
		for (const pr of prs) if (pr.mergedAt && pr.mergedAt >= created && !shas.has(pr.headRefOid)) shas.set(pr.headRefOid, await treeOfSha(top, slug, pr.headRefOid));
		const idx = prTreeIndex(prs, created, (sha) => shas.get(sha) ?? null);
		return { trees: idx.trees, unknown: idx.unknown > 0 };
	}

	/** The merge check of one sub: per repo, its last delivered tree against the merged pull requests (or the target branch for a protected push). */
	async function checkSub(o: Owned, run: Run, sub: Sub, listings: Map<string, ReturnType<typeof listMerged>>): Promise<{ ok: boolean | null; missing: string[]; notes: string[] }> {
		const results = [];
		const extra: string[] = [];
		const merges = readMerges(sf(o, sub.id, "merges.json"));
		const verdicts = readNew(sf(o, sub.id, "inbox.jsonl"), 0).msgs.filter((x) => x.type === "accept-verdict").map((x) => ({ ...(x.data ?? {}), ts: x.ts }));
		const accepted = readAccepted(sf(o, sub.id, "accepted.json"));
		for (const wt of worktreesOf(sub, run)) {
			const top = topOfKey(o, run, wt.key);
			const ref = run.targets?.[wt.key] ?? (await git(top, "rev-parse", "--abbrev-ref", "@{u}"));
			const gh = await ghRepoOf(top, ref);
			const base = gh ? pickBase(ref, gh.remote) : null;
			const rawCount = wt.base ? await git(wt.cwd, "rev-list", "--count", `${wt.base}..HEAD`) : null;
			const count = rawCount !== null && Number.isFinite(Number(rawCount)) ? Number(rawCount) : null;
			const dirtyFiles = parsePorcelainZ((await gitRaw(wt.cwd, "status", "--porcelain=v1", "-z")) ?? "").length;
			const headTree = await git(wt.cwd, "rev-parse", "HEAD^{tree}");
			const delivery = lastDelivery({ merges, verdicts, accepted, key: wt.key, workingKey: workingKey(run) });
			let prTrees = new Map<string, number>();
			let prUnknown = !gh;
			if (delivery?.kind === "merge" && gh) {
				const recorded = merges.find((m) => m.key === wt.key && m.tree === delivery.tree && m.pr !== undefined);
				if (recorded) prTrees.set(delivery.tree, recorded.pr as number);
				else {
					const branches = branchesOf(o, sub);
					const filters: Array<{ head?: string; base?: string | null }> = branches.length ? branches.map((b) => ({ head: b })) : [{ base }];
					prUnknown = false;
					for (const fl of filters) {
						const lk = `${gh.slug}|${fl.head !== undefined ? `head:${fl.head}` : `base:${fl.base ?? ""}`}`;
						if (!listings.has(lk)) listings.set(lk, listMerged(top, gh.slug, fl, run.created));
						const l = await listings.get(lk)!;
						for (const [t, n] of l.trees) prTrees.set(t, n);
						if (l.unknown) prUnknown = true;
						if (l.reason && !extra.includes(l.reason)) extra.push(l.reason);
					}
				}
			}
			const targetTrees = new Set<string>();
			let targetUnknown = false;
			if (delivery?.kind === "protected-push") {
				const ck = `${sub.id}:${wt.key}:${delivery.tree}`;
				if (pushConfirmed.has(ck)) targetTrees.add(delivery.tree);
				else if (gh && ref && base) {
					await git(top, "fetch", gh.remote, base);
					const log = await git(top, "log", ref, `--since=${run.created}`, "--format=%T");
					if (log === null) targetUnknown = true;
					else for (const t of log.split("\n").filter(Boolean)) targetTrees.add(t);
					if (targetTrees.has(delivery.tree)) pushConfirmed.add(ck);
				} else targetUnknown = true;
			}
			let branchMerged: boolean | null | undefined;
			if (!delivery && count !== 0 && gh) {
				const bs = branchesOf(o, sub);
				if (bs.length) {
					const seen = await Promise.all(bs.map((b) => ghMerged(gh.slug, b)));
					branchMerged = seen.includes(true) ? true : seen.includes(null) ? null : false;
				}
			}
			const res = deliveryMerged({ key: wt.key, delivery, prTrees, prUnknown, targetTrees, targetUnknown, commitsSinceBase: count, dirtyFiles, headTree, branchMerged, base: ref ?? undefined });
			setPr(sub.id, wt.key, res.changed ? res.ok : null);
			results.push(res);
		}
		const c = combineRepos(results);
		return { ...c, notes: [...c.notes, ...extra] };
	}

	/** Confirms the merge of every sub whose flow ended (or of `only`, when asked by hand); returns report lines. One round at a time. */
	function checkEnded(manual: boolean, only?: string[], force?: boolean): Promise<string[]> {
		const p = checkChain.then(() => checkRound1(manual, only, force));
		checkChain = p.catch(() => {});
		return p;
	}

	/** The sub-session's state for merging: `idle` when its session is gone, or its flow ended and it is not in plan or execute again; `waiting` when it holds for acceptance. */
	function subActivity(o: Owned, sub: Sub): { alive: boolean; waiting: boolean; idle: boolean } {
		const st = readStatus(sf(o, sub.id, "status.json")).status;
		const alive = !!st && pidAlive(st.pid);
		const waiting = alive && !!st?.acceptance;
		if (!alive) return { alive, waiting, idle: true };
		const out = readNew(sf(o, sub.id, "outbox.jsonl"), 0).msgs;
		const lastEnd = [...out].reverse().find((m) => m.type === "flow-ended")?.ts;
		const lastStart = [...out].reverse().find((m) => m.type === "session-started")?.ts;
		const ended = !!lastEnd && (!lastStart || lastEnd > lastStart);
		return { alive, waiting, idle: ended && st?.phase !== "execute" && st?.phase !== "plan" };
	}

	const globalDelivery = (): { mergeMethod: string; deleteBranch: boolean } => {
		try {
			const d = (JSON.parse(fs.readFileSync(`${getAgentDir()}/workflow.json`, "utf8")) as { delivery?: { mergeMethod?: unknown; deleteBranch?: unknown } }).delivery ?? {};
			return { mergeMethod: d.mergeMethod === "squash" || d.mergeMethod === "rebase" ? d.mergeMethod : "merge", deleteBranch: d.deleteBranch !== false };
		} catch {
			return { mergeMethod: "merge", deleteBranch: true };
		}
	};

	/**
	 * The orchestrator merges the pull request of a package: only when the sub-session no longer works on it (flow ended, session closed) or waits for acceptance.
	 * Without `force` the head tree of the PR must be accepted; with it any head goes. The merge is pinned to the head commit and recorded in merges.json.
	 * `waiting`: the sub-session is in its acceptance wait, so the package stays registered (the verdict resumes it).
	 */
	async function mergePackage(id: string, opt: { force?: boolean; repo?: string }): Promise<{ merged: boolean; waiting: boolean; failed: boolean; text: string }> {
		const { o, run } = need();
		const sub = subOf(run, id);
		const no = (text: string, failed = false) => ({ merged: false, waiting: false, failed, text });
		if (sub.state === "merged" || sub.state === "stopped") return no(`${id} is already ${sub.state}`);
		const st = readStatus(sf(o, id, "status.json")).status;
		const { waiting, idle } = subActivity(o, sub);
		if (!idle && !waiting) return no(`package ${id} is still working: merging works once its flow ended, its session closed, or while it waits for acceptance`);
		const accepted = new Set(readAccepted(sf(o, id, "accepted.json")));
		const settings = st?.delivery ?? globalDelivery();
		const method = settings.mergeMethod === "squash" || settings.mergeMethod === "rebase" ? settings.mergeMethod : "merge";
		const wts = worktreesOf(sub, run).filter((w) => !opt.repo || w.key === opt.repo.toLowerCase());
		const done: string[] = [];
		const problems: string[] = [];
		let failed = false;
		for (const wt of wts) {
			const label = wt.key || "the repo";
			const top = topOfKey(o, run, wt.key);
			const ref = run.targets?.[wt.key] ?? (await git(top, "rev-parse", "--abbrev-ref", "@{u}"));
			const gh = await ghRepoOf(top, ref);
			if (!gh) {
				problems.push(`${label}: no GitHub origin to merge on`);
				continue;
			}
			type Cand = { number: number; sha: string; tree: string; mergedAt?: string; mergeCommit?: string };
			const mergedPrs: Cand[] = [];
			const openPrs: Cand[] = [];
			for (const b of branchesOf(o, sub)) {
				let arr: Array<{ number: number; state: string; headRefOid: string; mergedAt?: string | null; mergeCommit?: { oid?: string } | null }> = [];
				try {
					const r = await exec("gh", ["pr", "list", "-R", gh.slug, "--head", b, "--state", "all", "--limit", "30", "--json", "number,state,headRefOid,mergedAt,mergeCommit"]);
					if (r.code === 0) arr = JSON.parse(r.stdout || "[]") as typeof arr;
				} catch {}
				for (const pr of arr) {
					if (pr.state !== "MERGED" && pr.state !== "OPEN") continue;
					if (pr.state === "MERGED" && !(pr.mergedAt && pr.mergedAt >= run.created)) continue;
					const tree = await treeOfSha(top, gh.slug, pr.headRefOid);
					if (!tree || (!opt.force && !accepted.has(wt.key ? `${wt.key}:${tree}` : tree))) continue;
					const c: Cand = { number: pr.number, sha: pr.headRefOid, tree, mergedAt: pr.mergedAt ?? undefined, mergeCommit: pr.mergeCommit?.oid };
					const list = pr.state === "MERGED" ? mergedPrs : openPrs;
					if (!list.some((x) => x.number === c.number)) list.push(c);
				}
			}
			const finish = async (c: Cand, how: string, forced: boolean): Promise<void> => {
				appendMerges(sf(o, id, "merges.json"), [{ key: wt.key, tree: c.tree, kind: "merge", at: new Date().toISOString(), pr: c.number, ...(c.mergeCommit ? { mergeCommit: c.mergeCommit } : {}), ...(forced ? { forced: true } : {}) }]);
				if (forced) addAccepted(sf(o, id, "accepted.json"), wt.key ? `${wt.key}:${c.tree}` : c.tree);
				appendMessage(sf(o, id, "inbox.jsonl"), "orch", {
					type: "accept-verdict",
					text: `Pull request #${c.number}${wt.key ? ` of repo ${wt.key}` : ""} ${how}. If plan steps remain, ${settings.deleteBranch ? "its branch is deleted: " : ""}start a new branch from the target.`,
					data: { ...verdictPayload({ tree: c.tree, repo: wt.key, kind: "merge", ask: "gate" }, true), merged: { pr: c.number, ...(c.mergeCommit ? { mergeCommit: c.mergeCommit } : {}) } },
				});
				const item = findItem(itemsFile, id, acceptRef(wt.key, c.tree));
				if (item && item.state === "open") closeItem(id, item.ref, "answered", false, "accepted");
				done.push(`#${c.number}${wt.key ? ` (${wt.key})` : ""} ${how}`);
			};
			if (mergedPrs.length) {
				mergedPrs.sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
				await finish(mergedPrs[0], "was already merged", false);
				continue;
			}
			if (!openPrs.length) {
				problems.push(`${label}: no open pull request ${opt.force ? "on the package's branches" : "with an accepted tree"} (branches: ${branchesOf(o, sub).join(", ") || "none known"})`);
				continue;
			}
			if (opt.force && openPrs.length > 1) {
				problems.push(`${label}: several open pull requests (${openPrs.map((p) => `#${p.number}`).join(", ")}); merge the right one by hand`);
				continue;
			}
			const pr = openPrs[0];
			const r = await exec("gh", ["pr", "merge", String(pr.number), "-R", gh.slug, `--${method}`, ...(settings.deleteBranch ? ["--delete-branch"] : []), "--match-head-commit", pr.sha]);
			if (r.code !== 0) {
				failed = true;
				problems.push(`${label}: gh pr merge #${pr.number} failed: ${(r.stderr || r.stdout || "").trim().split(/\r?\n/)[0] || "no detail"}`);
				continue;
			}
			try {
				const v = await exec("gh", ["pr", "view", String(pr.number), "-R", gh.slug, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]);
				if (v.code === 0 && /^[0-9a-f]{40}$/.test(v.stdout.trim())) pr.mergeCommit = v.stdout.trim();
			} catch {}
			await finish(pr, `merged by the orchestrator (--${method}${settings.deleteBranch ? ", branch deleted" : ""})`, !!opt.force);
		}
		if (done.length) await mutate((r) => {
			const s = subOf(r, id);
			s.state = stateAfterVerdict(s.state);
		});
		const merged = done.length > 0 && !problems.length;
		const doneText = done.map((d) => `${id}: pull request ${d}`).join("; ");
		if (merged && owned) appendDecision(owned.common, owned.runId, id, opt.force ? "forced merge" : "merge", doneText);
		return { merged, waiting, failed, text: [...done.map((d) => `${id}: pull request ${d}`), ...problems.map((p) => `${id}: ${p}`)].join("\n") || `${id}: nothing to merge` };
	}

	/** `/orch merge` and `orch_merge`: merge, then (flow not running) confirm and mark the package merged. A waiting sub-session stays registered. */
	/** The logged assumptions with the packages that build on them, for the final report. */
	function assumptionReport(): string {
		if (!owned) return "";
		const list = readAssumptions(owned.common, owned.runId);
		if (!list.length) return "";
		return `Assumptions made without the user (${list.length}; reverse any with a directive):
${list.map((a) => `${a.line} → affects ${a.affects.join(", ") || "?"}`).join("\n")}`;
	}

	async function mergeAndConfirm(id: string, opt: { force?: boolean; repo?: string }): Promise<string> {
		const r = await mergePackage(id, opt);
		const lines = r.merged && !r.waiting ? await checkEnded(true, [id], false) : [];
		const tail = r.merged && r.waiting ? `${id} waits for acceptance: it gets the merge as its verdict and continues; it is marked merged when its flow ends.` : "";
		return [r.text, ...lines, tail].filter(Boolean).join("\n");
	}

	const autoMerged = new Set<string>();

	async function checkRound1(manual: boolean, only?: string[], force?: boolean): Promise<string[]> {
		const o = owned;
		const run = current();
		if (!o || !run) return [];
		checkRound++;
		const listings = new Map<string, ReturnType<typeof listMerged>>();
		const lines: string[] = [];
		const merged: Array<{ id: string; forcedCheck?: string; notes: string[]; endedAt?: string }> = [];
		const updates = new Map<string, { endChecks?: number; endReported?: boolean; endedAt?: string }>();
		for (const sub of run.subs) {
			if (sub.state === "merged" || sub.state === "stopped") continue;
			if (only ? !only.includes(sub.id) : !shouldPoll(sub)) continue;
			let res = await checkSub(o, run, sub, listings);
			// fallback: the sub-session's flow ended with an accepted tree whose pull request is still open: the orchestrator merges it (once per tree)
			if (!manual && !only && res.ok !== true && sub.endedAt && subActivity(o, sub).idle && !autoMerged.has(`${sub.id}|${sub.endedAt}`)) {
				autoMerged.add(`${sub.id}|${sub.endedAt}`);
				const m = await mergePackage(sub.id, {}).catch((e) => ({ merged: false, waiting: false, failed: true, text: `${sub.id}: ${(e as Error).message}` }));
				if (m.merged || m.failed) lines.push(`[${sub.id}] ${m.text}`);
				if (m.merged) res = await checkSub(o, run, sub, new Map());
			}
			const act = endDecision({ endHow: sub.endHow, ok: res.ok, manual, force: !!force, checks: sub.endChecks ?? 0 });
			const how = sub.endHow ?? "unknown";
			const noteText = res.notes.length ? ` (${res.notes.join("; ")})` : "";
			const upd: { endChecks?: number; endReported?: boolean } = {};
			if (act === "merge") merged.push({ id: sub.id, forcedCheck: res.ok === true ? undefined : res.ok === null ? `could not be checked: ${res.missing.join("; ")}` : res.missing.join("; "), notes: res.notes, endedAt: sub.endedAt });
			else if (act === "report" && (manual || !sub.endReported)) {
				upd.endReported = true;
				const hint = `/orch merge ${sub.id} merges its accepted PR and checks; /orch merge ${sub.id} --force merges and marks it merged without the acceptance.`;
				if (res.ok === true) lines.push(`[${sub.id}] flow ${how}; its delivered trees are merged${noteText}. ${hint}`);
				else lines.push(`[${sub.id}] flow ${how}, ${res.ok === null ? "could not be checked" : "not confirmed merged"}: ${res.missing.join("; ") || "no detail"}${noteText}. ${hint}`);
			}
			if (!manual) {
				const n = Math.min((sub.endChecks ?? 0) + 1, 2);
				if (n !== (sub.endChecks ?? 0)) upd.endChecks = n;
			}
			if (Object.keys(upd).length) updates.set(sub.id, { ...upd, endedAt: sub.endedAt });
		}
		if (updates.size) {
			await mutate((r) => {
				for (const [id, u] of updates) {
					const s = r.subs.find((x) => x.id === id);
					if (!s || s.state === "merged" || s.endedAt !== u.endedAt) continue; // a new end arrived during this round: keep its reset
					const { endedAt: _at, ...rest } = u;
					Object.assign(s, rest);
				}
			});
		}
		if (merged.length) {
			const ready = await mutate((r) => {
				for (const m of merged) {
					const s = r.subs.find((x) => x.id === m.id);
					if (!s || (!manual && s.endedAt !== m.endedAt)) continue;
					s.state = "merged";
					if (m.forcedCheck !== undefined) {
						s.forced = true;
						s.forcedCheck = m.forcedCheck;
					}
				}
				for (const m of merged) unregister(r.id, m.id);
				return { ready: readyToSpawn(r), running: r.subs.filter((s) => ACTIVE.includes(s.state)).map((s) => s.id), all: r.subs.every((s) => s.state === "merged" || s.state === "stopped") };
			});
			const target = run.targets?.[workingKey(run)] ?? "the target branch";
			for (const m of merged) {
				snaps.delete(m.id);
				// the package is done: what it still waited on is moot
				for (const i of liveItems(itemsFile, m.id)) close(itemsFile, m.id, i.ref, { how: "stale" });
				saveItems();
				lines.push(
					`[${m.id}] merged${m.forcedCheck !== undefined ? ` (forced; check: ${m.forcedCheck || "positive"})` : ""}${m.notes.length ? ` (${m.notes.join("; ")})` : ""}. ${ready.ready.length ? `Ready to spawn: ${ready.ready.join(", ")}.` : "Nothing new is ready to spawn."}${ready.running.length ? ` Running: ${ready.running.join(", ")}; they may need to rebase on ${target}.` : ""}${ready.all ? ` All packages are done; tell the user, then /orch end. In that report list every assumption with the packages it affects, and the checks only a person can do.${assumptionReport() ? `\n${assumptionReport()}` : ""}` : ""}`,
				);
			}
		}
		return lines;
	}

	/** Where the sub's own work starts: its merge base with the run's target branch (run.targets), else the default branch, now (so a rebase does not turn merged packages into drift); the spawn-time commit when that fails. */
	async function diffBase(wt: Worktree, o: Owned, run: Run): Promise<string | undefined> {
		if (!wt.cwd) return wt.base;
		const target = run.targets?.[wt.key];
		const viaTarget = target ? await git(wt.cwd, "merge-base", "HEAD", target) : null;
		if (viaTarget) return pickDiffBase({ viaTarget });
		const viaHead = await git(wt.cwd, "merge-base", "HEAD", "origin/HEAD");
		if (viaHead) return pickDiffBase({ viaHead });
		// no origin/HEAD (a repo made with git init + remote add): use the default branch name from gh, read once per repo
		if (!defaultBranches.has(wt.key)) {
			try {
				const gh = await ghRepoOf(topOfKey(o, run, wt.key), run.targets?.[wt.key] ?? null);
				const g = gh ? await exec("gh", ["repo", "view", gh.slug, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]) : null;
				defaultBranches.set(wt.key, g && g.code === 0 && g.stdout.trim() ? g.stdout.trim() : null);
			} catch {
				defaultBranches.set(wt.key, null);
			}
		}
		const name = defaultBranches.get(wt.key);
		if (name) {
			const viaName = await git(wt.cwd, "merge-base", "HEAD", `origin/${name}`);
			if (viaName) return pickDiffBase({ viaName });
		}
		return pickDiffBase({ spawn: wt.base });
	}

	async function pollGit(): Promise<void> {
		const o = owned;
		const run = current();
		if (!o || !run) return;
		const now = Date.now();
		const cur = new Map<string, Snapshot>();
		for (const sub of run.subs) {
			if (!ACTIVE.includes(sub.state) || !sub.cwd) continue;
			const sp = sf(o, sub.id, "status.json");
			const st = readStatus(sp);
			if (st.corrupt && !corruptSeen.has(sp)) {
				corruptSeen.add(sp);
				events.push(`[${sub.id}] status.json is unreadable: ${st.corrupt}`);
			}
			if (!st.status) continue;
			const heads: string[] = [];
			let por = "";
			const all = new Set<string>();
			for (const wt of worktreesOf(sub, run)) {
				heads.push((await git(wt.cwd, "rev-parse", "HEAD")) ?? "");
				const base = await diffBase(wt, o, run);
				const diff = base ? ((await git(wt.cwd, "diff", "--name-only", `${base}...HEAD`)) ?? "") : "";
				const p = (await gitRaw(wt.cwd, "status", "--porcelain=v1", "-z")) ?? "";
				por += `${wt.key}\n${p}\n`;
				const dirty = parsePorcelainZ(p);
				for (const file of [...diff.split("\n").filter(Boolean), ...dirty]) all.add(prefix(wt.key, file));
			}
			const head = heads.join(",");
			const porcelainHash = createHash("md5").update(por).digest("hex");
			const files = [...all];
			const prev = snaps.get(sub.id);
			cur.set(sub.id, {
				head,
				porcelainHash,
				done: st.status.done,
				files,
				heartbeat: st.status.heartbeat,
				phase: st.status.phase,
				waiting: st.status.waiting === true,
				changedAt: prev?.changedAt ?? now,
				reported: prev?.reported ?? { drift: [], overlap: [], offline: false, stalled: false },
			});
			setFingerprint(itemsFile, sub.id, fingerprintOf({ phase: st.status.phase, stage: st.status.stage, done: st.status.done, head, porcelainHash }));
		}
		const phases: Array<[string, Sub["state"]]> = [];
		for (const [id, snap] of cur) {
			const sub = subOf(run, id);
			const other = new Map<string, string[]>();
			for (const [oid, os2] of cur) if (oid !== id) other.set(oid, os2.files);
			const r = check(snaps.get(id), snap, { now, owns: sub.owns, forbids: sub.forbids, otherFiles: other, cfg });
			// a sub-session with an open item waits for the orchestrator: that is not a stall
			const waitingOnUs = liveItems(itemsFile, id).length > 0;
			if (waitingOnUs) r.next.reported.stalled = false;
			snaps.set(id, r.next);
			for (const e of r.events) if (!(waitingOnUs && e.type === "stalled")) events.push(`[${id}] ${e.type}: ${e.text}`);
			if (snap.phase === "plan" && sub.state === "spawned") phases.push([id, "planning"]);
			if (snap.phase === "execute" && (sub.state === "spawned" || sub.state === "planning")) phases.push([id, "executing"]);
		}
		if (phases.length) {
			await mutate((r) => {
				for (const [id, st] of phases) {
					const s = r.subs.find((x) => x.id === id);
					if (s && (s.state === "spawned" || s.state === "planning")) s.state = st;
				}
			});
		}
		events.push(...(await checkEnded(false)));
		saveItems();
		flush();
		refreshView();
	}

	function startWatcher(o: Owned): void {
		stopTimers();
		owned = o;
		snaps.clear();
		prs.clear();
		defaultBranches.clear();
		remotesCache.clear();
		currentView = null;
		lastViewSig = "";
		loadItems(o);
		// subs that ended before the upgrade have no endHow: they get one check
		void mutate((run) => {
			for (const sb of run.subs) if (sb.endedAt && !sb.endHow) {
				sb.endHow = "unknown";
				sb.endChecks = 0;
				sb.endReported = false;
			}
		}).catch(() => {});
		lastTickAt = Date.now();
		every(5_000, readOutboxes);
		every(5_000, itemTick);
		every(cfg.pollSeconds * 1000, pollGit);
		refreshView();
		updateWidget();
	}

	/** Watches a relay run: no workflow watcher, stall checks or merge fallback; the relay poll every pollSeconds. */
	function startRelay(o: Owned): RelayExec {
		stopTimers();
		owned = { ...o, executor: "relay" };
		snaps.clear();
		prs.clear();
		itemsFile = emptyItems();
		currentView = null;
		lastViewSig = "";
		const runId = o.runId;
		const ex = new RelayExec({
			emit: (e, d) => pi.events.emit(e, d),
			read: () => readRun(o.common, runId).run ?? null,
			mutate,
			dir: runDir(o.common, runId),
			folders: () => relayFolders(o.repoCwd, uiCtx),
			runTokens: () => cfg.runTokens,
			tell: (t) => {
				try {
					pi.sendMessage({ customType: "orchestrate-relay", content: `orchestrate: ${t}`, display: true });
				} catch {
					say(t);
				}
				notifyDesktop("orchestrate", t.split("\n")[0].slice(0, 200));
			},
			ended: () => {
				unregister(runId);
				if (mode !== "off") setMode("off", false, uiCtx); // before stopWatcher: the hosted release reads the run's executor
				if (relayExec === ex) stopWatcher();
			},
			changed: () => refreshView(),
		});
		relayExec = ex;
		every(cfg.pollSeconds * 1000, () => ex.tick());
		refreshView();
		updateWidget();
		return ex;
	}

	// relay's tagged job events: only the watched relay run's jobs count (relay-exec checks the tag)
	const relayFail = (e: unknown) => say(`relay event: ${(e as Error).message}`, "warning");
	let relayUnsubs: Array<() => void> = [];
	const unregisterRelayBus = (): void => {
		for (const u of relayUnsubs.splice(0)) {
			try {
				u();
			} catch {
				// already gone
			}
		}
	};
	/** Subscribes the relay events once (at load and at every session_start; unsubscribed at session_shutdown). */
	function registerRelayBus(): void {
		unregisterRelayBus();
		relayUnsubs = [
			pi.events.on("relay:job-end", (d: unknown) => void relayExec?.onJobEnd(d).catch(relayFail)),
			pi.events.on("relay:job-progress", (d: unknown) => void relayExec?.onProgress(d).catch(relayFail)),
			pi.events.on("relay:approval", (d: unknown) => relayExec?.onApproval(d)),
		];
	}
	registerRelayBus();

	async function table(): Promise<string> {
		if (relayExec && owned) {
			const run = current();
			if (run) return relayExec.table(run);
		}
		const { o, run } = need();
		const now = Date.now();
		const rows = run.subs.map((s) => {
			const st = readStatus(sf(o, s.id, "status.json")).status;
			const age = st ? `${Math.round((now - st.heartbeat) / 1000)}s ago` : "-";
			const steps = st?.total ? ` ${st.done ?? 0}/${st.total}` : "";
			return `${s.id.padEnd(16)} ${(s.state === "merged" && s.forced ? "merged (forced)" : s.state).padEnd(20)} ${phaseLabel(st?.phase ?? "-", st?.judging) + steps + (st?.waiting ? " (waiting)" : "")}`.padEnd(52) + ` beat ${age}${s.branch ? `  ${s.branch}` : ""}`;
		});
		const assumed = readAssumptions(o.common, o.runId).length;
		return `Run ${run.id} (${run.title}), running ${activeCount(run)}/${cfg.maxSubs}${assumed ? `, ${assumed} assumption${assumed === 1 ? "" : "s"} logged` : ""}\n${rows.join("\n")}`;
	}

	const addedOf = (ctx: ExtensionContext): string[] => foldersFromEntries(ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]);
	/** The folders relay names a run's repos by (relayNames): the cwd, the added folders of ctx (none without one), the filesystem. */
	const relayFolders = (cwd: string, ctx: ExtensionContext | undefined): RepoFolders => ({ cwd, added: ctx ? addedOf(ctx) : [], exists: fs.existsSync });
	const topOf = async (dir: string): Promise<string | null> => {
		const t = await git(dir, "rev-parse", "--show-toplevel");
		return t ? norm(t) : null;
	};

	/** The run's repos: the working repo and the git repos of the added folders. Undefined when only one repo (a single-repo run). Throws on a key collision. */
	async function sessionRepos(ctx: ExtensionContext): Promise<Repo[] | undefined> {
		const working = await topOf(ctx.cwd);
		if (!working) throw new Error("not in a git repository");
		const added: string[] = [];
		for (const dir of addedOf(ctx)) {
			const t = await topOf(dir);
			if (t) added.push(t);
		}
		const built = buildRepos(working, added);
		if (built.error) throw new Error(built.error);
		return built.repos.length > 1 ? built.repos : undefined;
	}

	/** D7: owned paths that may overlap with active runs of the session's other repos; the user decides. One-sided: only runs found from this session's repos. */
	async function confirmOverlaps(ctx: ExtensionContext, repos: Repo[], packages: PackageInput[], ask = true): Promise<string | undefined> {
		const found: string[] = [];
		const seen = new Set<string>();
		for (const repo of repos.slice(1)) {
			const common2 = await commonDir(exec, repo.top);
			if (!common2) continue;
			for (const other of listActiveRuns(common2).runs) {
				if (seen.has(`${common2}|${other.id}`)) continue;
				seen.add(`${common2}|${other.id}`);
				found.push(...crossRunOverlaps(repos, packages, repo.top, other));
			}
		}
		if (!found.length) return undefined;
		const list = [...new Set(found)].slice(0, 10).join("\n- ");
		// a relay run never asks the user: the model fixes the packages
		if (!ask) throw new Error(`owned paths overlap with active runs in other repos; change the packages' owns so they do not overlap:\n- ${list}`);
		if (!ctx.hasUI) return `WARNING: owned paths may overlap with active runs in other repos (no UI to ask; created anyway):\n- ${list}`;
		const pick = await ctx.ui.select(`Owned paths overlap with other active runs:\n- ${list}`, ["Create anyway", "Cancel"]);
		if (pick === "Create anyway") return `Note: owned paths may overlap with active runs in other repos (you chose to continue):\n- ${list}`;
		throw new Error(`cancelled: owned paths overlap with active runs in other repos:\n- ${list}`);
	}

	const pkgSchema = Type.Object({
		id: Type.String({ description: "Short slug [a-z0-9-], up to 16 characters" }),
		goal: Type.String({ description: "What this package delivers" }),
		criteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria, each checkable" })),
		owns: Type.Array(Type.String(), { description: "Globs of the paths this package may change (src/a/**); no two packages own the same glob. With added repos (/folders) write `repo:glob` (api:src/**); a glob with no repo means the working repo" }),
		forbids: Type.Optional(Type.Array(Type.String(), { description: "Globs it must not touch" })),
		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Package ids that must be merged first" })),
		decisions: Type.Optional(Type.Array(Type.String(), { description: "Decisions already made with the user" })),
		notes: Type.Optional(Type.String()),
		base: Type.Optional(Type.String({ description: "The branch this package starts from and merges into, as the proposal names it (e.g. feat/x); it must be the run's target" })),
		verify: Type.Optional(Type.Array(Type.String(), { description: "Relay runs (required): the commands that prove the package works, one per entry; `<repo key>: <cmd>` runs in that repo" })),
		scale: Type.Optional(Type.String({ description: "Relay runs: the numbers the package must handle" })),
		budget: Type.Optional(Type.String({ description: "Relay runs: the job budget, `wall: 120m; tokens: 4M; size: small|normal|large`" })),
		repos: Type.Optional(Type.Array(Type.String(), { description: "Multi-repo runs: extra repo keys the package needs to read (repos it owns paths in are included on their own)" })),
	});

	pi.registerTool({
		name: "orch_run",
		label: "Orchestrate: run",
		description: "Create an orchestrated run from work packages (2 or more). Validates them, writes the briefs and starts watching. Spawn them afterwards with orch_spawn. One active run per repo.",
		promptSnippet: "orch_run: define the work packages of an orchestrated run (then orch_spawn)",
		parameters: Type.Object({
			title: Type.String({ description: "Short title of the whole job" }),
			charter: Type.String({ description: "The proposal's `## Charter` section as approved: Goal, User decisions, Non-goals, Priorities, Target, Standing orders, Reserved for the user" }),
			packages: Type.Array(pkgSchema),
			targets: Type.Optional(Type.Array(Type.String(), { description: 'Branch the PRs go into: "branch" (working repo) or "key:branch". Default: the upstream of each repo checkout' })),
			authority: Type.Optional(Type.Array(Type.String(), { description: "Relay runs (required): the proposal's `## Authority` lines, one per category merge, publish, comments, delete, formats, deps: `<category>: yes (<specifics>) | no | n/a`" })),
		}),
		async execute(_id, params, _signal, _u, ctx) {
			uiCtx = ctx;
			// The check applies only while the guard is on: /orch off lifts it (D1).
			if (mode !== "off" && mode !== "run") throw new Error("approve the packages first (/orch, then go)");
			const common = await commonDir(exec, ctx.cwd);
			if (!common) throw new Error("not in a git repository");
			const executor: Executor = cfg.executor;
			const relay = executor === "relay";
			if (relay) {
				if (hosted?.state !== "on") await claimRelay(true);
				if (hosted?.state !== "on") throw new Error(hostedOffText(hosted?.state === "off" ? hosted.reason : "relay did not answer"));
				const problems: string[] = [];
				if ((params.packages as PackageInput[]).length > 10) problems.push("a relay run has at most 10 packages");
				problems.push(...authorityProblems((params.authority as string[] | undefined) ?? []));
				for (const p of params.packages as PackageInput[]) if (!p.verify?.some((v) => v.trim())) problems.push(`${p.id}: verify is empty (the commands that prove the package works)`);
				if (problems.length) throw new Error(`invalid relay run:\n- ${problems.join("\n- ")}`);
			}
			const active = listActiveRuns(common).runs;
			if (active.length) throw new Error(`run ${active[0].id} is still active in this repo; finish it or end it with /orch end`);
			const repos = await sessionRepos(ctx);
			if (!repos) {
				const keyed = (params.packages as PackageInput[]).flatMap((p) => [...(p.owns ?? []), ...(p.forbids ?? [])]).filter(hasKeyPrefix);
				if (keyed.length) throw new Error(`invalid packages: no other repos in this session, so use plain globs (not ${keyed.slice(0, 3).join(", ")}); add repos with /folders add`);
			}
			if (!params.charter?.trim()) throw new Error("charter is required: pass the proposal's `## Charter` section (ask the user to settle it first)");
			const errors = validatePackages(params.packages as PackageInput[], repos);
			if (errors.length) throw new Error(`invalid packages:\n- ${errors.join("\n- ")}`);
			const packages = repos ? canonicalPackages(params.packages as PackageInput[], repos).packages : (params.packages as PackageInput[]);
			// where the PRs go: the upstream of each repo's own checkout, or the given targets (checked before anything is written)
			const keys = repos ? repos.map((r) => r.key) : [""];
			const tops = new Map<string, string>(repos ? repos.map((r) => [r.key, r.top] as [string, string]) : [["", (await git(ctx.cwd, "rev-parse", "--show-toplevel")) ?? ctx.cwd]]);
			const given = new Map<string, string>();
			for (const t of (params.targets as string[] | undefined) ?? []) {
				const i = t.indexOf(":");
				const key = i > 0 ? t.slice(0, i) : keys[0];
				if (!keys.includes(key) || (!repos && i > 0)) throw new Error(`target ${t}: unknown repo key; known: ${keys.join(", ") || "(single repo: plain branch)"}`);
				given.set(key, i > 0 ? t.slice(i + 1) : t);
			}
			const label = (k: string) => k || "the working repo";
			const targets: Record<string, string> = {};
			const targetLines: string[] = [];
			for (const k of keys) {
				const top = tops.get(k) as string;
				const g = given.get(k);
				let src = "";
				if (g) {
					src = "given";
					const ref = `origin/${g.replace(/^origin\//, "")}`;
					if ((await git(top, "rev-parse", "--verify", "--quiet", ref)) === null) throw new Error(`target ${g} not found in ${label(k)}: fetch it or fix the name`);
					targets[k] = ref;
				} else {
					let ref = await git(top, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
					if (!ref) {
						const br = await git(top, "rev-parse", "--abbrev-ref", "HEAD");
						if (br && br !== "HEAD" && (await git(top, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${br}`)) !== null) ref = `origin/${br}`;
					}
					if (ref) {
						targets[k] = ref;
						src = `upstream of ${(await git(top, "rev-parse", "--abbrev-ref", "HEAD")) ?? "the checkout"}`;
					}
				}
				if (relay && !targets[k]) throw new Error(`no target branch for ${label(k)}: pass targets (${k ? `"${k}:<branch>"` : '"<branch>"'})`);
				// relay works on origin/<target>: an upstream on another remote would name a wrong branch
				if (relay && !targets[k].startsWith("origin/")) throw new Error(`the target of ${label(k)} is ${targets[k]}, not on origin; relay jobs work on origin/<branch>: pass targets (${k ? `"${k}:<branch>"` : '"<branch>"'}) with a branch of origin`);
				targetLines.push(targets[k] ? `Diff target (${label(k)}): ${targets[k]} (${src}); new worktrees start there` : `No diff target for ${label(k)}: drift is measured against the default branch`);
			}
			// a package that names another base than the run's target: the person decides before anything is written
			const workKey = keys[0];
			for (const p of packages) {
				if (!p.base || !targets[workKey]) continue;
				const named = `origin/${p.base.replace(/^origin\//, "")}`;
				if (named === targets[workKey]) continue;
				if (relay) throw new Error(`package ${p.id} names the base ${named}, but the run's target is ${targets[workKey]}; pass targets: ["${p.base}"] or fix the package's base`);
				if (!ctx.hasUI) throw new Error(`package ${p.id} names the base ${named}, but the run's target is ${targets[workKey]} (${given.has(workKey) ? "given" : "upstream of the checkout"}); pass targets: ["${p.base}"] or fix the package`);
				const pick = await ctx.ui.select(`Package ${p.id} starts from ${named}, but the run's target is ${targets[workKey]}`, [`Use ${targets[workKey]}`, `Use ${named}`, "Cancel"]);
				if (pick === `Use ${named}`) {
					if ((await git(tops.get(workKey) as string, "rev-parse", "--verify", "--quiet", named)) === null) throw new Error(`base ${named} not found in ${label(workKey)}: fetch it or fix the name`);
					targets[workKey] = named;
					for (let i = 0; i < targetLines.length; i++) if (targetLines[i].startsWith(`Diff target (${label(workKey)})`)) targetLines[i] = `Diff target (${label(workKey)}): ${named} (chosen: package ${p.id}); new worktrees start there`;
				} else if (pick !== `Use ${targets[workKey]}`) throw new Error("cancelled: no run was created");
			}
			const overlapNote = repos ? await confirmOverlaps(ctx, repos, packages, !relay) : undefined;
			let existing: string[] = [];
			try {
				existing = fs.readdirSync(orchestraDir(common));
			} catch {
				// first run in this repo
			}
			const id = makeRunId(params.title, new Date(), existing);
			const subs: Sub[] = [];
			for (const p of packages) {
				const name = setName(id, p.id);
				if (!name) throw new Error(`package id "${p.id}" gives an invalid worktree name`);
				subs.push({
					id: p.id, goal: p.goal, criteria: p.criteria ?? [], owns: p.owns ?? [], forbids: p.forbids ?? [], dependsOn: p.dependsOn ?? [], decisions: p.decisions ?? [], notes: p.notes, name, state: "planned",
					...(repos ? { repos: subRepos(p, repos[0].key) } : {}),
					...(relay ? { verify: (p.verify ?? []).filter((v) => v.trim()), ...(p.scale?.trim() ? { scale: p.scale.trim() } : {}), ...(p.budget?.trim() ? { budget: p.budget.trim() } : {}) } : {}),
				});
			}
			const relayFields = relay ? { executor, authority: ((params.authority as string[] | undefined) ?? []).map((a) => a.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean), ...(repos ? {} : { top: tops.get("") as string }) } : {};
			const run: Run = { v: 1, id, title: params.title, created: new Date().toISOString(), owner: { pid: process.pid, host: os.hostname(), session: ctx.sessionManager.getSessionFile() ?? "" }, state: "active", charter: params.charter.trim(), originTrusted: projectTrusted(ctx), ...(repos ? { repos } : {}), targets, ...relayFields, subs };
			const folders = relayFolders(ctx.cwd, ctx);
			const names = relayNames(run, folders);
			if (relay) {
				const bad = checkRunBriefs(run, folders);
				if (bad.length) throw new Error(`the relay briefs are incomplete:\n- ${bad.join("\n- ")}`);
			}
			fs.mkdirSync(runDir(common, id), { recursive: true });
			for (const s of subs) {
				fs.mkdirSync(subDir(common, id, s.id), { recursive: true });
				fs.writeFileSync(`${subDir(common, id, s.id)}/brief.md`, relay ? renderRelayBrief(s, run, names) : renderBrief(s, run, decisionsPath(common, id)));
			}
			if (relay) {
				fs.writeFileSync(findingsFile(runDir(common, id)), openFindings.length ? `${findingsBlock(openFindings)}\n` : "None.\n");
				openFindings = [];
			}
			fs.writeFileSync(charterPath(common, id), `${params.charter.trim()}
`);
			fs.writeFileSync(decisionsPath(common, id), "");
			writeRun(common, run);
			if (relay) {
				const ex = startRelay({ common, runId: id, repoCwd: ctx.cwd });
				void ex.dispatchReady().then(() => ex.settle()).catch((e: Error) => say(e.message, "warning"));
				return text(`Run ${id} created with ${subs.length} packages as relay jobs${repos ? ` over ${repos.length} repos (${repos.map((r) => r.key).join(", ")})` : ""}. Dispatching now: ${readyToSpawn(run).join(", ") || "none"}; the others follow when their dependencies are merged. Briefs are in ${runDir(common, id)}/<id>/brief.md.\n${targetLines.join("\n")}`);
			}
			startWatcher({ common, runId: id, repoCwd: ctx.cwd });
			return text(`Run ${id} created with ${subs.length} packages${repos ? ` over ${repos.length} repos (${repos.map((r) => r.key).join(", ")})` : ""}. Ready to spawn: ${readyToSpawn(run).join(", ") || "none"}. Briefs are in ${runDir(common, id)}/<id>/brief.md.\n${targetLines.join("\n")}${overlapNote ? `\n${overlapNote}` : ""}`);
		},
	});

	pi.registerTool({
		name: "orch_spawn",
		label: "Orchestrate: spawn",
		description: "Open packages as sub-sessions, each in its own wt worktree and terminal. A package can be spawned when all its dependencies are merged, and at most maxSubs run at once.",
		promptSnippet: "orch_spawn: open ready packages as sub-sessions in worktrees",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { description: "Package ids to spawn" }) }),
		async execute(_id, params, _signal, _u, ctx) {
			uiCtx = ctx;
			const { o, run } = need();
			const ready = readyToSpawn(run);
			const lines: string[] = [];
			let running = activeCount(run) + [...spawning].filter((sid) => subOf(run, sid).state === "planned").length; // a set member is counted once: run.json shows it as spawning from the first write
			for (const id of params.ids) {
				const sub = subOf(run, id);
				if (!ready.includes(id) || spawning.has(id)) {
					lines.push(`${id}: not spawned (${sub.state === "planned" ? "a dependency is not merged yet" : `state ${sub.state}`})`);
					continue;
				}
				if (running + 1 > cfg.maxSubs) {
					lines.push(`${id}: not spawned (maxSubs ${cfg.maxSubs} reached)`);
					continue;
				}
				spawning.add(id);
				running++;
				try {
					// the trust handler of the new session waits for this mark (a worktree is trusted only while its run knows it)
					await mutate((r) => {
						const s = subOf(r, id);
						s.state = "spawning";
						s.spawningAt = new Date().toISOString();
					});
					registerSpawn(run, owned?.common ?? "", id, "spawning", []);
					// multi-repo: only the added folders this package needs go into its set (plain folders always do)
					let payload: Record<string, unknown> = { v: 1, name: sub.name };
					if (run.repos) {
						const added = addedOf(ctx);
						const keyOf = new Map<string, string | null>();
						for (const dir of added) {
							const t = await topOf(dir);
							keyOf.set(dir, t ? (run.repos.find((r) => sameDir(r.top, t))?.key ?? "?") : null);
						}
						payload = { ...payload, folders: foldersFor(sub, added, (dir) => keyOf.get(dir) ?? null) };
					}
					// new worktrees start at the run's target, not at the default branch
					const bases: Record<string, string> = {};
					for (const [k, ref] of Object.entries(run.targets ?? {})) {
						const t = run.repos ? run.repos.find((r) => r.key === k)?.top : norm((await git(o.repoCwd, "rev-parse", "--show-toplevel")) ?? o.repoCwd);
						if (t) bases[t] = ref;
					}
					if (Object.keys(bases).length) payload = { ...payload, bases };
					const claims = emitClaims((d) => pi.events.emit("worktree:create", d), payload, 120_000);
					if (!claims.claimed) throw new Error("worktree extension not loaded");
					const ans = (await claims.answer) as { error?: string; cwd?: string; branch?: string; launched?: boolean; text?: string; repos?: Array<{ top?: string; cwd?: string }> } | null;
					if (!ans || ans.error || !ans.cwd) throw new Error(ans?.error ?? "worktree extension gave no answer");
					const top = norm((await git(ans.cwd, "rev-parse", "--show-toplevel")) ?? ans.cwd); // a sub-session finds itself by its git top level
					const base = (await git(top, "rev-parse", "HEAD")) ?? undefined;
					const wts: Worktree[] = [];
					const notes: string[] = [];
					if (run.repos) {
						wts.push({ key: run.repos[0].key, cwd: top, base });
						for (const r of Array.isArray(ans.repos) ? ans.repos : []) {
							if (typeof r?.top !== "string" || typeof r.cwd !== "string") continue;
							const key = run.repos.find((x) => sameDir(x.top, r.top as string))?.key;
							if (!key || wts.some((w) => w.key === key)) continue;
							const wtop = norm((await git(r.cwd, "rev-parse", "--show-toplevel")) ?? r.cwd);
							wts.push({ key, cwd: wtop, base: (await git(wtop, "rev-parse", "HEAD")) ?? undefined });
						}
						if (!Array.isArray(ans.repos)) notes.push("the worktree extension did not report its repos (old version): only the working repo is watched");
						else for (const k of sub.repos ?? []) if (!wts.some((w) => w.key === k)) notes.push(`no worktree for repo ${k}`);
					}
					await mutate((r) => {
						const s = subOf(r, id);
						s.cwd = top;
						s.branch = ans.branch;
						s.base = base;
						if (run.repos) s.worktrees = wts;
						s.state = "spawned";
						delete s.spawningAt;
					});
					registerSpawn(run, owned?.common ?? "", id, "spawned", wts.length ? wts.map((w) => w.cwd) : [top]);
					lines.push(`${id}: spawned in ${top} (${ans.branch ?? "branch ?"})${ans.launched ? "" : "; the terminal did not open, use /wt open " + sub.name}${wts.length > 1 ? `; worktrees: ${wts.map((w) => w.key).join(", ")}` : ""}${notes.length ? `. WARNING: ${notes.join("; ")}` : ""}`);
				} catch (e) {
					running--;
					await mutate((r) => revertSpawning(subOf(r, id))).catch(() => {});
					unregister(run.id, id);
					lines.push(`${id}: failed: ${(e as Error).message} (still planned)`);
				} finally {
					spawning.delete(id);
				}
			}
			return text(`${lines.join("\n")}\nThe sub-sessions start at the plan phase on their own; plans and questions arrive as messages.`);
		},
	});

	pi.registerTool({
		name: "orch_status",
		label: "Orchestrate: status",
		description: "Compact table of the run: each package's state, phase, steps, heartbeat and branch.",
		promptSnippet: "orch_status: table of the run's packages",
		parameters: Type.Object({}),
		async execute() {
			return text(await table());
		},
	});

	pi.registerTool({
		name: "orch_send",
		label: "Orchestrate: send",
		description: "Send a message to a sub-session: answer (to a question, with replyTo), directive (an instruction; urgent interrupts) or info.",
		promptSnippet: "orch_send: answer, instruct or inform a sub-session",
		parameters: Type.Object({
			id: Type.String({ description: "Package id" }),
			type: StringEnum(["answer", "directive", "info"] as const),
			text: Type.String(),
			replyTo: Type.Optional(Type.String({ description: "Question id, for an answer" })),
			urgent: Type.Optional(Type.Boolean({ description: "directive only: interrupt the running turn" })),
			userQuote: Type.Optional(Type.String({ description: "Answering an escalated question: an exact piece of a message the user typed after the escalation" })),
			assumption: Type.Optional(Type.Boolean({ description: "true when the brief, the charter and the log do not settle the question and you chose the most reversible option: it is logged as an assumption and listed in the final report" })),
			affects: Type.Optional(Type.Array(Type.String(), { description: "Package ids that build on this assumption (default: the package you answer)" })),
		}),
		async execute(_id, params) {
			const { o, run } = need();
			subOf(run, params.id);
			const answered = params.replyTo ? findItem(itemsFile, params.id, params.replyTo) : undefined;
			if (answered && answered.kind !== "question" && answered.kind !== "idle") throw new Error(`${params.replyTo} is a ${answered.kind} item: answer it with ${answered.kind === "menu" || answered.kind === "wait" ? "orch_decide" : answered.kind === "plan-review" ? "orch_review_plan" : "orch_accept"}, not orch_send`);
			if (answered?.kind === "question" && params.type !== "answer") throw new Error(`${params.replyTo} is a question: answer it with type "answer" (a ${params.type} would leave the sub-session waiting)`);
			// an escalated idle report is answered by the user: any message to that package needs their quote
			if ((params.type === "directive" || params.type === "info") && liveItems(itemsFile, params.id).some((i) => i.kind === "plan-review")) throw new Error(`${params.id} has a plan under review: use orch_review_plan notes or reasons, not a ${params.type}`);
			const idleEsc = params.replyTo ? undefined : liveItems(itemsFile, params.id).find((i) => i.kind === "idle" && i.state === "escalated");
			const subject = answered ?? idleEsc;
			const bad = subject ? checkItemAnswer(subject, params.userQuote) : null;
			if (bad) throw new Error(bad);
			const m = appendMessage(sf(o, params.id, "inbox.jsonl"), "orch", { type: params.type, text: params.text, replyTo: params.replyTo, data: params.urgent ? { urgent: true } : undefined });
			appendDecision(o.common, o.runId, params.id, params.type, params.text, { assumption: params.assumption, affects: params.affects });
			if (answered?.kind === "question" || subject?.kind === "idle") closeItem(params.id, subject!.ref, "answered", quoteOk(subject!, params.userQuote));
			if (closeIdle(itemsFile, params.id, false).length) {
				saveItems();
				refreshView();
			}
			return text(`sent ${m.id} to ${params.id}`);
		},
	});

	pi.registerTool({
		name: "orch_review_plan",
		label: "Orchestrate: review plan",
		description: "Give the verdict on a sub-session's plan after reading it. Refuse a plan that does not cover every stage the brief asks for. With confirmPlans on, the user confirms an approval from your summary. Approve with notes (the notes parameter) for anything extra the executor should apply; reject only for a blocker or major problem; never send a directive to change an approved plan. Give reasons when rejecting. If the plan file ends in `## Open judge findings`, weigh them: reject with instructions for the ones to fix and settle the \"needs a decision\" ones in the reject text, or approve.",
		promptSnippet: "orch_review_plan: approve or reject a sub-session's plan",
		parameters: Type.Object({
			id: Type.String(),
			n: Type.Number({ description: "Plan number from the plan-review message; the verdict counts only for that plan" }),
			approve: Type.Boolean(),
			summary: Type.String({ description: "One line: what the plan does and why it fits the brief" }),
			reasons: Type.Optional(Type.String({ description: "Required when rejecting: what to change" })),
			notes: Type.Optional(Type.String({ description: "Approve only: extra instructions appended to the approved plan as `## Orchestrator notes`; the executor applies them without a new plan" })),
			userQuote: Type.Optional(Type.String({ description: "A plan review that was escalated to the user: an exact piece of a message they typed after the escalation" })),
		}),
		async execute(_id, params, _s, _u, ctx) {
			uiCtx = ctx;
			const { o, run } = need();
			subOf(run, params.id);
			const planItem = findItem(itemsFile, params.id, planRef(params.n));
			const planBad = planItem ? checkItemAnswer(planItem, params.userQuote) : null;
			if (planBad) throw new Error(planBad);
			let approve = params.approve;
			let reasons = params.reasons ?? "";
			if (approve && cfg.confirmPlans && ctx.hasUI) {
				const review = readNew(sf(o, params.id, "outbox.jsonl"), 0).msgs.filter((m) => m.type === "plan-review" && m.data?.n === params.n).pop();
				const judgeLine = typeof review?.data?.judgeLine === "string" ? review.data.judgeLine : undefined;
				const pick = await ctx.ui.select(confirmPlanTitle(params.id, params.summary, judgeLine), ["Approve", "Reject"]);
				if (pick !== "Approve") {
					approve = false;
					reasons = (await ctx.ui.input("Why reject? (sent to the sub-session)", "")) || "the user rejected the plan";
				}
			}
			if (!approve && !reasons) throw new Error("reasons are required when rejecting a plan");
			appendDecision(o.common, o.runId, params.id, approve ? `plan ${params.n} approved` : `plan ${params.n} rejected`, approve ? [params.summary, params.notes ? `notes: ${params.notes}` : ""].filter(Boolean).join("; ") : reasons);
			appendMessage(sf(o, params.id, "inbox.jsonl"), "orch", { type: "plan-verdict", text: approve ? "approved" : reasons, data: { approve, n: params.n, ...(approve && params.notes?.trim() ? { notes: params.notes.trim() } : {}) } });
			if (planItem) closeItem(params.id, planItem.ref, "answered", quoteOk(planItem, params.userQuote), approve ? "approved" : "rejected");
			return text(approve ? `plan ${params.n} of ${params.id} approved` : `plan ${params.n} of ${params.id} rejected: ${reasons}`);
		},
	});

	pi.registerTool({
		name: "orch_accept",
		label: "Orchestrate: accept",
		description: "Accept or refuse the result a sub-session asked to merge, after checking its diff against the brief's criteria. Acceptance covers the tree it requested; if the worktree changed since, accept again after a new request.",
		promptSnippet: "orch_accept: accept or refuse a sub-session's merge request",
		parameters: Type.Object({ id: Type.String(), accept: Type.Boolean(), reasons: Type.Optional(Type.String({ description: "Required when refusing" })), repo: Type.Optional(Type.String({ description: "Multi-repo runs: the repo key of the request; default the repo of its latest request" })), userQuote: Type.Optional(Type.String({ description: "An accept request that was escalated to the user: an exact piece of a message they typed after the escalation" })) }),
		async execute(_id, params) {
			const { o, run } = need();
			const sub = subOf(run, params.id);
			const wantRepo = params.repo?.toLowerCase();
			const reqs = readNew(sf(o, params.id, "outbox.jsonl"), 0).msgs.filter((m) => m.type === "accept-request" && (wantRepo === undefined || String(m.data?.repo ?? workingKey(run)) === wantRepo));
			const tree = reqs.length ? String(reqs[reqs.length - 1].data?.tree ?? "") : "";
			if (!tree) throw new Error(`${params.id} has not asked for acceptance${wantRepo ? ` in repo ${wantRepo}` : ""} yet: a question asking for acceptance is not a request. Tell it (orch_send) to retry its merge with gh pr merge; the merge gate sends the request.`);
			const lastReq = reqs[reqs.length - 1];
			const repo = reqs.length ? String(lastReq.data?.repo ?? workingKey(run)) : workingKey(run);
			if (!params.accept && !params.reasons) throw new Error("reasons are required when refusing");
			const accItem = findItem(itemsFile, params.id, acceptRef(repo, tree));
			const accBad = accItem ? checkItemAnswer(accItem, params.userQuote) : null;
			if (accBad) throw new Error(accBad);
			if (params.accept) {
				const wt = worktreesOf(sub, run).find((w) => w.key === repo);
				const now = wt ? await git(wt.cwd, "rev-parse", "HEAD^{tree}") : null;
				if (now !== tree) throw new Error(`the sub-session changed since its request (requested tree ${tree}, now ${now ?? "unknown"}); wait for its next accept-request`);
				addAccepted(sf(o, params.id, "accepted.json"), repo ? `${repo}:${tree}` : tree);
			}
			appendMessage(sf(o, params.id, "inbox.jsonl"), "orch", {
				type: "accept-verdict",
				text: params.accept ? `Tree ${tree}${repo ? ` of repo ${repo}` : ""} accepted; retry the merge.` : `Not accepted${repo ? ` (repo ${repo})` : ""}: ${params.reasons}`,
				data: verdictPayload({ tree, repo, kind: lastReq.data?.kind, ask: lastReq.data?.ask }, params.accept),
			});
			if (!params.accept) appendDecision(o.common, o.runId, params.id, "accept refused", params.reasons ?? "");
			if (accItem) closeItem(params.id, accItem.ref, "answered", quoteOk(accItem, params.userQuote), params.accept ? "accepted" : "refused");
			await mutate((r) => {
				const s = subOf(r, params.id);
				s.state = stateAfterVerdict(s.state);
			});
			return text(params.accept ? `accepted tree ${tree}${repo ? ` of repo ${repo}` : ""} of ${params.id}` : `refused ${params.id}: ${params.reasons}`);
		},
	});

	pi.registerTool({
		name: "orch_merge",
		label: "Orchestrate: merge",
		description: "Merge the pull request of a package whose tree you accepted, pinned to its head commit, with the sub-session's own merge settings. Only when the sub-session no longer works (flow ended, session closed) or waits for acceptance; otherwise refused. A waiting sub-session gets the merge as its verdict. There is no force: only the user forces a merge (/orch merge <id> --force).",
		promptSnippet: "orch_merge: merge a package's accepted pull request",
		parameters: Type.Object({ id: Type.String({ description: "Package id" }), repo: Type.Optional(Type.String({ description: "Multi-repo runs: only this repo key" })) }),
		async execute(_id, params) {
			const { run } = need();
			subOf(run, params.id);
			return text(await mergeAndConfirm(params.id, { repo: params.repo }));
		},
	});

	pi.registerTool({
		name: "orch_decide",
		label: "Orchestrate: decide",
		description: "Answer a workflow menu or wait of a sub-session (an `ask` message): pick one of its options (choice, optional text for the sub-session) or end a wait (resume). Some answers are refused: approving or discussing in a plan menu, and anything that stops the flow or repeats a replan needs the user's quote (userQuote).",
		promptSnippet: "orch_decide: answer a sub-session's workflow menu or wait",
		parameters: Type.Object({
			id: Type.String({ description: "Package id" }),
			askId: Type.String({ description: "The askId of the menu or wait" }),
			choice: Type.Optional(Type.String({ description: "One of the menu's options, exactly as written" })),
			resume: Type.Optional(Type.Boolean({ description: "Waits only: end the wait (needs the user's userQuote)" })),
			text: Type.Optional(Type.String({ description: "Sent to the sub-session after the choice is applied" })),
			userQuote: Type.Optional(Type.String({ description: "An exact piece of a message the user typed after the item was escalated; required for escalated items, Stop, waits and a replan over the cap" })),
		}),
		async execute(_id, params) {
			const { o, run } = need();
			subOf(run, params.id);
			const item = findItem(itemsFile, params.id, params.askId);
			const d = checkDecision(item, params, countersOf(itemsFile, params.id), caps());
			if (!d.ok) {
				let extra = "";
				if (d.escalate && item && item.state === "open") {
					handleActions([escalate(item, Date.now(), d.reason)], true);
					saveItems();
					refreshView();
					extra = " The item was escalated to the user: show it to them and relay their answer with userQuote.";
				}
				return text(`refused: ${d.reason}.${extra}`);
			}
			const t = params.text?.trim();
			appendMessage(sf(o, params.id, "inbox.jsonl"), "orch", { type: "decision", text: `decision for ${params.askId}`, data: { askId: params.askId, ...(params.resume ? { resume: true } : { choice: params.choice }), ...(t ? { text: t } : {}) } });
			appendDecision(o.common, o.runId, params.id, "decide", `${params.resume ? "resume" : `chose "${params.choice}"`} for ${item?.key ?? params.askId}${t ? `: ${t}` : ""}`);
			closeItem(params.id, params.askId, "answered", d.byUser, d.outcome);
			return text(`${params.resume ? "resumed" : `chose "${params.choice}" for`} ${params.askId} of ${params.id}${t ? " (with text)" : ""}`);
		},
	});

	pi.registerTool({
		name: "orch_escalate",
		label: "Orchestrate: escalate",
		description: "Escalate an open item to the user, only for an action the charter reserves for them: stopping or dropping a package, changing the goal or scope, or an irreversible action no plan covers. Everything else you decide yourself (an assumption, the advisor, step back). `question` is what the user sees. Then show it to the user and relay their answer with userQuote.",
		promptSnippet: "orch_escalate: send an item that needs the user to them",
		parameters: Type.Object({
			id: Type.String({ description: "Package id" }),
			ref: Type.String({ description: "The item's ref (question id, askId, plan-<n>, ...)" }),
			question: Type.String({ description: "What the user must decide, with the options" }),
		}),
		async execute(_id, params) {
			const { run } = need();
			subOf(run, params.id);
			const item = findItem(itemsFile, params.id, params.ref);
			if (!item) throw new Error(`no item ${params.ref} of ${params.id} (open: ${liveItems(itemsFile, params.id).map((i) => i.ref).join(", ") || "none"})`);
			if (item.state === "escalated") return text(`${params.ref} is already escalated to the user`);
			if (item.state !== "open") throw new Error(`item ${params.ref} is ${item.state}; only an open item can be escalated`);
			handleActions([escalate(item, Date.now(), "escalated by the orchestrator", params.question)], true);
			saveItems();
			refreshView();
			return text(`escalated ${params.ref} of ${params.id} to the user: show it to them now and wait for their answer; relay it with userQuote.`);
		},
	});

	pi.registerCommand("orch", {
		description: "Orchestrator mode and run: start (read-only discussion; \"go\" on a proposal runs the proposal judge first), off, go force, judge cancel, status, watch (resume watching a run), merge <id> [--force] (merge an accepted PR now; --force skips the acceptance), end",
		getArgumentCompletions: (prefix) =>
			["start", "off", "go", "judge", "status", "board", "watch", "merge", "end"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			uiCtx = ctx;
			let sub = args.trim().split(/\s+/)[0];
			if (!sub) sub = owned || me ? "status" : mode === "off" ? "start" : "mode";
			try {
				if (owned?.executor === "relay" && ["merge", "merged", "spawn"].includes(sub)) throw new Error(`/orch ${sub} is for workflow runs: ${RELAY_MERGE_HINT}`);
				if (sub === "start") {
					if (me) throw new Error("this is a sub-session of a run; start orchestrating from another session");
					if (lastK4 && typeof lastK4.phase === "string" && lastK4.phase !== "off") throw new Error(`the workflow is in phase ${lastK4.phase}; end it (/flow off) before /orch start`);
					const common = await commonDir(exec, ctx.cwd);
					if (!common) throw new Error("not in a git repository");
					const active = listActiveRuns(common).runs[0];
					if (active) throw new Error(`run ${active.id} is still active in this repo; resume it with /orch watch or end it with /orch end`);
					setMode("discuss", false, ctx);
					const title = args.trim().slice("start".length).trim();
					ctx.ui.notify("orchestrate: discuss mode (read-only). Say \"go\" for the package proposal, \"go\" again to run it; /orch off lifts the guard.", "info");
					if (title) pi.sendUserMessage(title, { deliverAs: "followUp" });
				} else if (sub === "mode") {
					ctx.ui.notify(`orchestrate: mode ${mode}${mode === "discuss" ? "; \"go\" asks for the package proposal" : mode === "propose" ? "; \"go\" on a finished proposal runs the proposal judge, then starts the run" : ""}; /orch off lifts the guard`, "info");
				} else if (sub === "go") {
					if (args.trim().split(/\s+/)[1]?.toLowerCase() !== "force") throw new Error("usage: /orch go force (runs the proposal without the judge)");
					if (mode !== "propose") throw new Error("/orch go force works only in propose");
					if (!lastProposal) throw new Error("no finished proposal to run");
					abortProposal("force");
					moveToRun(ctx, proposalReview?.hash === lastProposal.hash ? proposalReview.findings : []);
				} else if (sub === "judge") {
					if (args.trim().split(/\s+/)[1]?.toLowerCase() !== "cancel") throw new Error("usage: /orch judge cancel");
					if (proposalRun) abortProposal("command");
					else ctx.ui.notify("orchestrate: no judge running", "info");
				} else if (sub === "off") {
					setMode("off", true, ctx);
					if (owned) ctx.ui.notify(`orchestrate: the watcher keeps running run ${owned.runId}`, "info");
				} else if (sub === "status") {
					ctx.ui.notify(await table(), "info");
				} else if (sub === "board") {
					await showBoard(ctx);
				} else if (sub === "merge") {
					const pm = parseMergedArgs(args.trim().split(/\s+/).slice(1).join(" "));
					if ("error" in pm) throw new Error(pm.error);
					subOf(need().run, pm.id);
					ctx.ui.notify(`orchestrate: ${await mergeAndConfirm(pm.id, { force: pm.force })}`, "info");
				} else if (sub === "end" && !owned) {
					if (mode === "off") throw new Error("no active run in this session");
					setMode("off", true, ctx);
				} else if (sub === "end") {
					// a relay run: the unfinished jobs are stopped first (marked as the orchestrator's stops, so none is retried)
					const stopErrors = relayExec ? await relayExec.stopAll("the run was ended with /orch end") : [];
					if (stopErrors.length) ctx.ui.notify(`orchestrate: could not stop: ${stopErrors.join("; ")}`, "warning");
					await mutate((r) => {
						r.state = "ended";
					});
					const id = owned?.runId;
					const assumed = assumptionReport();
					if (id) unregister(id);
					if (mode !== "off") setMode("off", false, ctx); // before stopWatcher: the hosted release reads the run's executor
					stopWatcher();
					ctx.ui.notify(`orchestrate: run ${id} ended; the worktrees stay (remove them with /wt)${assumed ? `
${assumed}` : ""}`, "info");
				} else if (sub === "watch") {
					const common = await commonDir(exec, ctx.cwd);
					if (!common) throw new Error("not in a git repository");
					const run = listActiveRuns(common).runs[0];
					if (!run) throw new Error("no active run in this repo");
					const mine = run.owner.session && run.owner.session === (ctx.sessionManager.getSessionFile() ?? "");
					const alive = run.owner.host === os.hostname() && pidAlive(run.owner.pid) && run.owner.pid !== process.pid;
					if (!mine && alive) throw new Error(`run ${run.id} is watched by another live session (pid ${run.owner.pid})`);
					const relayRun = run.executor === "relay";
					const ex = relayRun ? startRelay({ common, runId: run.id, repoCwd: ctx.cwd }) : undefined;
					if (!relayRun) startWatcher({ common, runId: run.id, repoCwd: ctx.cwd });
					const wasOff = mode === "off";
					setMode("run", false, ctx);
					if (ex && !wasOff) void claimRelay(false); // setMode claims only from off
					if (ex) void ex.tick().catch((e: Error) => say(e.message, "warning"));
					await resetStaleSpawning(run); // before the owner changes: a dead owner is part of the test
					await mutate((r) => {
						r.owner = { pid: process.pid, host: os.hostname(), session: ctx.sessionManager.getSessionFile() ?? "" };
					});
					ctx.ui.notify(`orchestrate: watching run ${run.id}`, "info");
				} else {
					ctx.ui.notify("usage: /orch start [title] | off | go force | judge cancel | status | board | watch | merged <id> | end", "warning");
				}
			} catch (e) {
				ctx.ui.notify(`orchestrate: ${(e as Error).message}`, "error");
			}
		},
	});

	/** /orch board: reads view.json every 2 s; works in any session of the repo with an active run. */
	async function showBoard(ctx: ExtensionContext): Promise<void> {
		const common = await commonDir(exec, ctx.cwd);
		if (!common) throw new Error("not in a git repository");
		const runId = owned?.runId ?? me?.run.id ?? listActiveRuns(common).runs[0]?.id;
		if (!runId) throw new Error("no active run in this repo");
		let warned = false;
		const read = (): View | null => {
			const r = readView(common, runId);
			if (r.corrupt && !warned) {
				warned = true;
				say(r.corrupt, "warning");
			}
			return r.view ?? null;
		};
		let view = read();
		if (!view) throw new Error("no view.json yet; the orchestrator writes it every few seconds");
		if ((ctx as { mode?: string }).mode !== "tui" || !ctx.hasUI) {
			ctx.ui.notify(boardLines(view, 0, false, 200, Date.now()).join("\n"), "info");
			return;
		}
		let stop = () => {};
		try {
			await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
				let selected = 0;
				let detail = false;
				const timer = setInterval(() => {
					view = read() ?? view;
					tui.requestRender();
				}, 2_000);
				timer.unref?.();
				stop = () => clearInterval(timer);
				const paint = paintWith(theme);
				return {
					render(width: number): string[] {
						const v = view as View;
						const body = boardLines(v, selected, detail, width, Date.now(), paint);
						return [theme.fg("accent", `orch board · ${v.runId} · ${v.subs.length} packages${v.waitingForUser ? ` · ${v.waitingForUser} waiting for you` : ""}`), ...body, theme.fg("dim", "↑↓ select · enter details · esc back/close · refreshes every 2s")].map((l) => truncateToWidth(l, width));
					},
					handleInput(data: string): void {
						const n = (view as View).subs.length;
						if (keybindings.matches(data, "tui.select.up")) selected = Math.max(0, selected - 1);
						else if (keybindings.matches(data, "tui.select.down")) selected = Math.min(Math.max(0, n - 1), selected + 1);
						else if (keybindings.matches(data, "tui.select.confirm")) {
							if (n) detail = true;
						} else if (keybindings.matches(data, "tui.select.cancel")) {
							if (detail) detail = false;
							else {
								stop();
								done(undefined);
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
	}

	function pidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	// ---------------------------------------------------------------- start and stop

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		stopTimers();
		registerRelayBus();
		owned = null;
		relayExec = undefined;
		hosted = undefined;
		hostedRetry = false;
		me = null;
		started = false;
		pendingAsk = new Map();
		k10 = null;
		releaseHeld();
		releaseAsks();
		openSince.clear();
		orphanNotified.clear();
		itemsFile = emptyItems();
		identity = "unknown";
		mode = modeFromEntries(ctx.sessionManager.getBranch());
		orchPrevModel = roleOnRestore(ctx.sessionManager.getBranch());
		proposalReview = proposalGateFromEntries(ctx.sessionManager.getBranch());
		abortProposal("restart");
		lastProposal = undefined;
		k4Warned = false;
		widgetMounted = false;
		widgetTui = undefined;
		currentView = null;
		lastViewSig = "";
		updateWidget();
		const gen = ++generation;
		const loaded = loadConfig(getAgentDir());
		cfg = loaded.config;
		if (loaded.warning) say(loaded.warning, "warning");
		if (!ctx.hasUI) return becomeNotSub();
		const common = await commonDir(exec, ctx.cwd);
		if (gen !== generation) return;
		if (!common) return becomeNotSub();
		const listed = listActiveRuns(common);
		for (const c of listed.corrupt) if (!corruptSeen.has(c)) {
			corruptSeen.add(c);
			say(`unreadable run file: ${c}`, "warning");
		}
		const top = await git(ctx.cwd, "rev-parse", "--show-toplevel");
		if (gen !== generation) return;
		const become = (hit: { run: Run; sub: Sub }) => {
			const m: Me = { common, run: hit.run, sub: hit.sub, dir: subDir(common, hit.run.id, hit.sub.id) };
			me = m;
			post("session-started", `sub-session of ${m.sub.id} started`, { instance: INSTANCE });
			mode = "off";
			orchPrevModel = undefined;
			const fresh = !fs.existsSync(`${m.dir}/status.json`);
			started = !fresh;
			every(3_000, deliverInbox);
			every(60_000, writeMyStatus);
			updateSubStatus();
			becomeSub();
			if (fresh) void startSubSession(m, ctx).catch((e: Error) => ctx.ui.notify(`orchestrate: ${e.message}`, "error"));
		};
		// a restored orchestrator mode with executor relay claims relay's hosted mode again
		const hostedAtStart = () => {
			if (mode !== "off" && cfg.executor === "relay") void claimRelay(false);
		};
		if (!listed.runs.length) {
			hostedAtStart();
			return becomeNotSub();
		}
		const hit = top ? findSubByToplevel(listed.runs, top) : null;
		if (hit) {
			become(hit);
			return;
		}
		const file = ctx.sessionManager.getSessionFile() ?? "";
		const mine = file ? listed.runs.find((r) => r.owner.session === file) : undefined;
		if (mine && mine.executor === "relay") {
			// restart: hosted again, then the package states are rebuilt from relay:job-query (a "no session context" answer is retried at the first turn)
			const ex = startRelay({ common, runId: mine.id, repoCwd: ctx.cwd });
			say(`resumed run ${mine.id} (relay jobs)`);
			void claimRelay(false);
			void ex.tick().catch((e: Error) => say(e.message, "warning"));
			return becomeNotSub();
		}
		if (mine) {
			startWatcher({ common, runId: mine.id, repoCwd: ctx.cwd });
			say(`resumed watching run ${mine.id}`);
			void resetStaleSpawning(mine).catch((e: Error) => say(e.message, "warning"));
			return becomeNotSub();
		}
		if (mode !== "off" || !top) {
			hostedAtStart();
			return becomeNotSub();
		}
		// the terminal may open before orch_spawn has written this worktree into run.json: look again for about 15 s
		if (top) {
			void (async () => {
				for (let i = 0; i < 5; i++) {
					await new Promise((res) => setTimeout(res, 3_000));
					if (gen !== generation || me) return;
					const again = findSubByToplevel(listActiveRuns(common).runs, top);
					if (again) {
						become(again);
						return;
					}
				}
				if (gen === generation && !me) becomeNotSub();
			})();
		}
	});

	pi.on("session_shutdown", async () => {
		stopTimers();
		unregisterRelayBus();
		try {
			uiCtx?.ui.setStatus("orchestrate", undefined);
		} catch {
			/* ignore */
		}
		k10?.resolve(null);
		k10 = null;
		releaseHeld();
		releaseAsks();
		generation++;
	});

	// Worktrees that an orchestrated run spawned are trusted without a prompt (never remembered: trust.json is not written).
	pi.on("project_trust", async (event) => {
		const cwd = (event as { cwd?: string }).cwd;
		if (!cwd) return { trusted: "undecided" as const };
		try {
			const r = await decideTrust(
				{
					locate: (dir) =>
						new Promise((resolve) => {
							execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { cwd: dir, timeout: 5000 }, (err, stdout) => {
								const [common, top] = String(stdout).split(/\r?\n/).map((l) => l.trim());
								resolve(err || !common || !top ? null : { common: norm(common), top: norm(top) });
							});
						}),
					listRuns: (common) => listActiveRuns(common).runs,
					listSpawned: () => readSpawnRegistry(getAgentDir()),
					sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
					now: () => Date.now(),
				},
				cwd,
			);
			return r === "yes" ? { trusted: "yes" as const, remember: false } : { trusted: "undecided" as const };
		} catch {
			return { trusted: "undecided" as const };
		}
	});
}
