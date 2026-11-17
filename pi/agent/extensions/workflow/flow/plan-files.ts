import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { planTitle } from "../delivery.ts";
import { repoKey, uniqueRoots } from "../../shared/repos.ts";
import { type PlanStatus, renderPlanFile, type Finished, newFlowId, pruneIds } from "../plan-doc.ts";
import { type LiveInfo, readLive, liveEvents, addToRegistry } from "../board.ts";
import { type Git, plansDir, writeClaim, repoInfo, writeLocal, dropClaim, deleteLocal, remoteOf, deleteRef, refRev, commitRef, pushRef, fetchMirror, listRefs, readLocalStatuses, adoptHigher, sweepReviewRefs } from "../plan-store.ts";
import type { MetricEvent } from "../metrics.ts";
import { mapLimit } from "../../agents/api.ts";
import { execFileAsync, type Flow, type PlanSnap } from "./context.ts";
import { flowRepos, gitRoot } from "./diff.ts";
import { autopilotOn, currentStages, persist } from "./phase.ts";

// ----------------------------------------------------------------------
// Plan files
// ----------------------------------------------------------------------

export const gitEnv: Git = async (cwd, args, env) => {
	try {
		const r = await execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
		return { code: 0, stdout: String(r.stdout), stderr: String(r.stderr) };
	} catch (e) {
		const err = e as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: string };
		return { code: typeof err.code === "number" ? err.code : 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? err.message ?? "") };
	}
};

export const metricsFolder = (fl: Flow, id: string) => {
	const d = fl.plan.planDirs.get(id);
	return d ? path.join(d, id) : undefined;
};
export const metricsFlushAll = (fl: Flow) => fl.metrics.flush((id) => metricsFolder(fl, id), fl.state.planDoc && !fl.state.planDoc.finished ? fl.state.planDoc.flowId : undefined);
export function recordMetric(fl: Flow, e: MetricEvent): void {
	fl.metrics.record(e);
	metricsFlushAll(fl);
}

export async function planDirFor(fl: Flow, root: string | null): Promise<string> {
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

export function refreshClaim(fl: Flow): void {
	const dir = fl.claim.claimedFlow ? fl.plan.planDirs.get(fl.claim.claimedFlow) : undefined;
	if (!fl.claim.claimedFlow || !dir) return;
	try {
		writeClaim(dir, fl.claim.claimedFlow, { v: 1, pid: process.pid, host: os.hostname(), cwd: fl.claim.claimCwd || process.cwd(), updated: new Date().toISOString() });
	} catch {}
}
export function stopClaimTimer(fl: Flow): void {
	if (fl.claim.claimTimer) clearInterval(fl.claim.claimTimer);
	fl.claim.claimTimer = undefined;
	fl.claim.claimedFlow = undefined;
}

export function liveSnapshot(fl: Flow): LiveInfo | undefined {
	const flowId = fl.state.planDoc?.flowId;
	if (!flowId || !fl.plan.planDirs.get(flowId)) return undefined;
	const st = currentStages(fl);
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
		autopilot: autopilotOn(fl),
		...(fl.state.waiting ? { waiting: fl.state.waiting.reason.slice(0, 120) } : {}),
		runs: fl.view.runs.filter((r) => r.status === "running").slice(0, 6).map((r) => ({ role: r.role, label: r.label.slice(0, 80), activity: (r.activity ?? "").slice(0, 80) })),
		events: [],
	};
}
export function stopLiveTimer(fl: Flow): void {
	if (fl.live.liveTimer) clearInterval(fl.live.liveTimer);
	fl.live.liveTimer = undefined;
}
/** Ends the snapshot of a flow this session no longer holds in `state`: no wait, no runs, a final event. */
export function liveFinish(dir: string, flowId: string, text: string): void {
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
export function liveTick(fl: Flow, extra?: string): void {
	// Once the flow is finished only the final write (with `extra`) goes through.
	if (fl.state.planDoc?.finished && !extra) {
		stopLiveTimer(fl);
		return;
	}
	try {
		const snap = liveSnapshot(fl);
		if (!snap) {
			stopLiveTimer(fl);
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
			fl.live.liveTimer = setInterval(() => liveTick(fl), 5_000);
			fl.live.liveTimer.unref?.();
		}
	} catch {}
}

export async function writePlan(fl: Flow, ctx: ExtensionContext, snap: PlanSnap): Promise<void> {
	fl.claim.claimCwd = ctx.cwd.replace(/\\/g, "/");
	const found = [...(await flowRepos(fl, ctx)).map((r) => r.root), ...(await Promise.all(snap.touched.map((t) => gitRoot(fl, t))))];
	const roots = uniqueRoots([...snap.roots, ...found.filter((r): r is string => !!r)]);
	const dir = fl.plan.planDirs.get(snap.flowId) ?? (await planDirFor(fl, roots[0] ?? null));
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
		if (fl.claim.claimedFlow === snap.flowId) stopClaimTimer(fl);
		if (fl.state.planDoc?.flowId === snap.flowId) {
			liveTick(fl, `finished: ${snap.finished.text}`);
			stopLiveTimer(fl);
		} else liveFinish(dir, snap.flowId, snap.finished.text);
	} else if (fl.state.planDoc?.flowId === snap.flowId) {
		fl.claim.claimedFlow = snap.flowId;
		refreshClaim(fl);
		fl.claim.claimTimer ??= setInterval(() => refreshClaim(fl), 60_000);
		fl.claim.claimTimer.unref?.();
	}
	metricsFlushAll(fl);
	const live = fl.state.planDoc?.flowId === snap.flowId ? fl.state.planDoc : undefined;
	if (live && roots.join("\n") !== live.roots.join("\n")) {
		live.roots = roots;
		persist(fl);
	}
	const revs = await mapLimit(roots, 3, (root) => syncRoot(fl, ctx, root, snap, planMd, status));
	const top = Math.max(snap.rev, ...revs);
	if (live && top > live.rev) {
		live.rev = top;
		persist(fl);
	}
	if (snap.finished && fl.cfg.plans.keepCount === 0) deleteLocal(dir, snap.flowId);
}

export function planWarn(fl: Flow, ctx: ExtensionContext, flowId: string, text: string): void {
	if (fl.plan.planWarned.has(flowId)) return;
	fl.plan.planWarned.add(flowId);
	ctx.ui.notify(`workflow: ${text}`, "warning");
}

/** Whether plan refs of a repo with this remote URL may be pushed. */
export function syncAllowed(fl: Flow, url: string): boolean {
	const u = url.toLowerCase();
	return fl.cfg.plans.sync === "remote" && !fl.cfg.plans.localOnly.some((s) => s && u.includes(s.toLowerCase()));
}

/** Commits the plan into the repo's plan ref and pushes it. Returns the highest rev written (a rejected push is redone on top of the remote's commit). Never throws. */
export async function syncRoot(fl: Flow, ctx: ExtensionContext, root: string, snap: PlanSnap, planMd: string, status0: PlanStatus): Promise<number> {
	let status = status0;
	try {
		const remote = await remoteOf(gitEnv, root);
		const push = !!remote && syncAllowed(fl, remote.url);
		if (snap.finished && fl.cfg.plans.keepCount === 0) {
			await deleteRef(gitEnv, root, snap.flowId, push ? remote?.name : undefined);
			return 0;
		}
		const cur = await refRev(gitEnv, root, snap.flowId);
		if (cur !== null) {
			if (snap.retry) {
				if (cur > status.rev) {
					planWarn(fl, ctx, snap.flowId, "this flow moved on in another device; use /flow resume");
					return cur;
				}
			} else if (cur >= status.rev) status = { ...status, rev: cur + 1 };
		}
		if (!(await commitRef(gitEnv, root, snap.flowId, planMd, `${JSON.stringify(status, null, 2)}\n`))) {
			planWarn(fl, ctx, snap.flowId, `could not save the plan ref in ${root}`);
			return 0;
		}
		if (!push || !remote) return status.rev;
		const first = await pushRef(gitEnv, root, remote.name, snap.flowId);
		if (first === "ok") return status.rev;
		if (first === "failed") {
			planWarn(fl, ctx, snap.flowId, `could not push the plan to ${remote.url} (it stays local; plans.sync "local" or plans.localOnly turns pushing off)`);
			return status.rev;
		}
		const theirs = (await fetchMirror(gitEnv, root, remote.name)) ? (await listRefs(gitEnv, root, "remote-plans")).find((e) => e.flowId === snap.flowId) : undefined;
		if (!theirs) {
			planWarn(fl, ctx, snap.flowId, `could not push the plan to ${remote.url}: it changed there`);
			return status.rev;
		}
		const rev = Math.max(status.rev, theirs.status?.rev ?? 0) + 1;
		const next: PlanStatus = { ...status, rev };
		const commit = await commitRef(gitEnv, root, snap.flowId, planMd, `${JSON.stringify(next, null, 2)}\n`, theirs.commit);
		if (!commit || (await pushRef(gitEnv, root, remote.name, snap.flowId)) !== "ok") planWarn(fl, ctx, snap.flowId, `could not push the plan to ${remote.url}: it changed there`);
		return rev;
	} catch (e) {
		planWarn(fl, ctx, snap.flowId, `plan sync failed in ${root}: ${(e as Error).message}`);
		return 0;
	}
}

/** A point where the plan file is rewritten: approval, an amendment, a stage end, the flow's end. Runs in the background, in order; `bump: false` only restores the file. */
/** The wait and checkpoints as they go into the plan's status. */
export function waitSnapshot(fl: Flow): Pick<PlanSnap, "waiting" | "checkpoints" | "reviewBase" | "passedTrees" | "judgedMerges"> {
	const w = fl.state.waiting;
	return {
		...(w ? { waiting: { reason: w.reason, ...(w.check ? { check: w.check } : {}), ...(w.waitKind ? { waitKind: w.waitKind } : {}), since: w.since, planned: w.planned, ...(w.atStageStart ? { atStageStart: true } : {}), ...(w.held ? { held: w.held } : {}) } } : {}),
		...(fl.state.checkpoints?.length ? { checkpoints: fl.state.checkpoints.map((c) => ({ ...(c.step ? { step: c.step } : {}), ...(c.stage ? { stage: c.stage } : {}), text: c.text, ok: c.ok })) } : {}),
		...(fl.state.reviewBase && Object.keys(fl.state.reviewBase).length ? { reviewBase: { ...fl.state.reviewBase } } : {}),
		...(fl.state.passedTrees && Object.keys(fl.state.passedTrees).length ? { passedTrees: { ...fl.state.passedTrees } } : {}),
		...(fl.state.judgedMerges && Object.keys(fl.state.judgedMerges).length ? { judgedMerges: { ...fl.state.judgedMerges } } : {}),
	};
}

export function planMilestone(fl: Flow, ctx: ExtensionContext | undefined, finished?: Finished, bump = true): void {
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
		...waitSnapshot(fl),
		retry: !bump,
	};
	const c = ctx ?? fl.lastCtx;
	if (!c) return;
	fl.plan.planChain = fl.plan.planChain
		.then(() => writePlan(fl, c, snap))
		.catch((e) => {
			if (fl.plan.planWarned.has(snap.flowId)) return;
			fl.plan.planWarned.add(snap.flowId);
			c.ui.notify(`workflow: could not save the plan file: ${(e as Error).message}`, "warning");
		});
}

/** Rewrites the current plan file from state (ticks changed). No rev, no git. Returns the path, or undefined when nothing was written before. */
export function rewritePlanFile(fl: Flow): string | undefined {
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
		Object.assign(status, waitSnapshot(fl));
		const file = writeLocal(last.dir, doc.flowId, renderPlanFile(doc.flowId, fl.state.approvedPlan, fl.state.checklist, doc.finished, fl.state.waiting?.reason), status);
		last.status = status;
		return file;
	} catch {
		return undefined;
	}
}

/** The path of the plan file, rewritten from state first when it went missing; undefined when there is none yet. */
export function planFilePath(fl: Flow): string | undefined {
	const doc = fl.state.planDoc;
	const dir = doc && fl.plan.planDirs.get(doc.flowId);
	if (!doc || !dir || !fl.state.approvedPlan) return undefined;
	const file = path.join(dir, doc.flowId, "plan.md");
	if (fs.existsSync(file)) return file;
	if (doc.finished && fl.cfg.plans.keepCount === 0) return undefined;
	return rewritePlanFile(fl);
}

/** Deletes plans past the retention limits in this flow's plan folders, and restores the active flow's file. */
export async function planHousekeeping(fl: Flow, ctx: ExtensionContext): Promise<void> {
	try {
		const repos = await flowRepos(fl, ctx);
		const dirs = new Set<string>([await planDirFor(fl, null)]);
		for (const r of repos) dirs.add(await planDirFor(fl, r.root));
		const active = fl.state.planDoc && !fl.state.planDoc.finished ? fl.state.planDoc.flowId : undefined;
		for (const dir of dirs) {
			const entries = readLocalStatuses(dir).map((e) => {
				const t = e.status ? Date.parse(e.status.updated) : NaN;
				return { flowId: e.flowId, updated: Number.isFinite(t) ? t : e.mtime, finished: e.status ? !!e.status.finished : true };
			});
			for (const id of pruneIds(entries, { keepDays: fl.cfg.plans.keepDays, keepCount: fl.cfg.plans.keepCount, now: Date.now(), activeId: active })) deleteLocal(dir, id);
		}
		fl.plan.planChain = fl.plan.planChain.then(() => mapLimit(repos, 3, (r) => pruneRefs(fl, r.root, active))).then(() => {}, () => {});
		await fl.plan.planChain;
		if (active && fl.state.approvedPlan) planMilestone(fl, ctx, undefined, false);
	} catch {}
}

/** The plan refs of one repo: fetch the remote's, keep the higher revs, delete those past retention (also on the remote). */
export async function pruneRefs(fl: Flow, root: string, activeId: string | undefined): Promise<void> {
	try {
		const remote = await remoteOf(gitEnv, root);
		const sync = !!remote && syncAllowed(fl, remote.url);
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

export const isDir = (p: string): boolean => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};
