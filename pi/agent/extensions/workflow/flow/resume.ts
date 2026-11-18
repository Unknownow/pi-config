/** `/flow resume`: rebuilds an unfinished flow from its plan ref. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repoKey } from "../../shared/repos.ts";
import { splitPlanFile, parseChecklist } from "../plan-doc.ts";
import { type RefEntry, remoteOf, fetchMirror, listRefs, adoptHigher, readClaim, claimLive, pidAlive, readPlanMd, repoInfo } from "../plan-store.ts";
import { cleanCheck } from "../waits.ts";
import { parseStages, stageStart } from "../stages.ts";
import { type Flow } from "./context.ts";
import { existingFolders, gitRoot, planCardText, restoreReview } from "./diff.ts";
import { persist, setPhase, updateStatus } from "./phase.ts";
import { gitEnv, isDir, planDirFor, planMilestone } from "./plan-files.ts";
import { setWaiting, startWaitTimer } from "./wait-points.ts";

/** `/flow resume`: rebuilds an unfinished flow from its plan ref, found in the working folder's repo or an added folder. */
export async function resumeFlow(fl: Flow, ctx: ExtensionContext, wanted: string | undefined): Promise<void> {
	const notify = (text: string, level: "info" | "warning" = "warning") => ctx.ui.notify(`workflow: ${text}`, level);
	const busy = fl.state.phase === "execute" && fl.state.planDoc && !fl.state.planDoc.finished ? fl.state.planDoc.flowId : undefined;
	if (busy && (!wanted || !busy.startsWith(wanted))) {
		notify(`a flow is already running (${busy}); finish or leave it before resuming another`);
		return;
	}
	const cwdRoot = await gitRoot(fl, ctx.cwd);
	if (!cwdRoot) {
		notify("the working folder is not in a git repo, so there is no plan to resume");
		return;
	}
	const searchRoots: string[] = [cwdRoot];
	for (const f of existingFolders(ctx)) {
		const r = await gitRoot(fl, f);
		if (r && !searchRoots.some((s) => repoKey(s) === repoKey(r))) searchRoots.push(r);
	}
	const found = new Map<string, { entry: RefEntry; root: string }>();
	fl.plan.planChain = fl.plan.planChain
		.then(async () => {
			for (const root of searchRoots) {
				const remote = await remoteOf(gitEnv, root);
				if (remote && (await fetchMirror(gitEnv, root, remote.name))) {
					for (const e of await listRefs(gitEnv, root, "remote-plans")) await adoptHigher(gitEnv, root, e.flowId);
				}
			}
		})
		.then(() => {}, () => {});
	await fl.plan.planChain;
	for (const root of searchRoots) {
		for (const e of await listRefs(gitEnv, root, "plans")) {
			if (!e.status || e.status.finished) continue;
			const prev = found.get(e.flowId);
			if (!prev || (prev.entry.status?.rev ?? 0) < e.status.rev) found.set(e.flowId, { entry: e, root });
		}
	}
	let candidates = [...found.values()].sort((a, b) => Date.parse(b.entry.status?.updated ?? "") - Date.parse(a.entry.status?.updated ?? ""));
	if (wanted) candidates = candidates.filter((c) => c.entry.flowId.startsWith(wanted));
	if (!candidates.length) {
		notify(wanted ? `no unfinished plan matches "${wanted}" in this repo or the added folders` : "no unfinished plan found in this repo or the added folders");
		return;
	}
	// S2: another live session may be running the flow.
	const claims = await Promise.all(
		candidates.map(async (c) => {
			const claim = readClaim(await planDirFor(fl, c.root), c.entry.flowId);
			return claim && claim.pid !== process.pid ? claim : null;
		}),
	);
	const liveClaim = (i: number) => (claims[i] && claimLive(claims[i], Date.now(), os.hostname(), pidAlive) ? claims[i] : null);
	let pickIdx = 0;
	if (candidates.length > 1) {
		const labels = candidates.map((c, i) => {
			const live = liveClaim(i);
			return `${c.entry.status?.title} \u2014 ${c.entry.status?.updated.slice(0, 16).replace("T", " ")}${c.entry.status?.stage ? `, stage ${c.entry.status.stage}` : ""}${c.entry.status?.kind === "test" ? " (test flow)" : ""} (${c.entry.flowId})${live ? ` \u2014 running in ${live.cwd} (pid ${live.pid})` : ""}`;
		});
		const chosen = await ctx.ui.select("Resume which flow?", labels);
		const i = chosen ? labels.indexOf(chosen) : -1;
		if (i < 0) return;
		pickIdx = i;
	}
	const pick = candidates[pickIdx];
	const heldBy = liveClaim(pickIdx);
	if (heldBy) {
		notify(`${pick.entry.status?.title} is running in ${heldBy.cwd} (pid ${heldBy.pid}); finish or leave it there first`);
		return;
	}
	if (claims[pickIdx]) notify(`took over a stale claim from pid ${claims[pickIdx]!.pid}`, "info");
	if (busy && busy !== pick.entry.flowId) {
		notify(`a flow is already running (${busy}); finish or leave it before resuming another`);
		return;
	}
	const status = pick.entry.status;
	if (status?.kind === "test") {
		notify("test flows are gone; this one can't be resumed");
		return;
	}
	const md = await readPlanMd(gitEnv, pick.root, pick.entry.commit);
	if (!status || !md) {
		notify("the plan ref is unreadable");
		return;
	}
	const plan = splitPlanFile(md);

	const mine = new Map<string, string>();
	for (const root of searchRoots) {
		const remote = await remoteOf(gitEnv, root);
		if (remote) mine.set(remote.url, root);
	}
	const parent = path.dirname(cwdRoot);
	let siblings: string[] | undefined;
	const findSibling = async (url: string): Promise<string | undefined> => {
		if (!siblings) {
			try {
				siblings = fs.readdirSync(parent).slice(0, 200).map((n) => path.join(parent, n)).filter((d) => fs.existsSync(path.join(d, ".git")));
			} catch {
				siblings = [];
			}
		}
		for (const d of siblings) {
			const remote = await remoteOf(gitEnv, d);
			if (remote?.url === url) return (await gitRoot(fl, d)) ?? undefined;
		}
		return undefined;
	};
	const roots: { root: string; branch?: string; remote?: string }[] = [];
	for (const r of status.repos) {
		let root = r.remote ? mine.get(r.remote) : undefined;
		if (!root && r.remote) root = await findSibling(r.remote);
		if (!root) {
			const label = r.remote ?? "a repo without a remote";
			const answer = r.remote ? (await ctx.ui.input(`Where is ${label} on this device?`, "path to the repo, empty to skip"))?.trim() : "";
			const abs = answer ? path.resolve(ctx.cwd, answer).replace(/\\/g, "/") : "";
			root = abs && isDir(abs) ? ((await gitRoot(fl, abs)) ?? undefined) : undefined;
			if (!root) {
				notify(`${label}: not found on this device, skipped`);
				continue;
			}
		}
		if (!roots.some((x) => repoKey(x.root) === repoKey(root))) roots.push({ root, branch: r.branch, remote: r.remote });
	}
	if (!roots.some((x) => repoKey(x.root) === repoKey(cwdRoot))) roots.unshift({ root: cwdRoot });

	for (const r of roots) {
		if (!r.branch) continue;
		if (r.branch.startsWith("-") || r.branch.includes("@{") || (await gitEnv(r.root, ["check-ref-format", "--branch", r.branch])).code !== 0) {
			notify(`${r.root}: the plan names an invalid branch, left alone`);
			continue;
		}
		const info = await repoInfo(gitEnv, r.root);
		const dirty = await gitEnv(r.root, ["status", "--porcelain"]);
		if (dirty.code !== 0 || dirty.stdout.trim()) {
			notify(`${r.root} has uncommitted changes; it stays on ${info.branch ?? "a detached HEAD"} (the flow used ${r.branch})`);
			continue;
		}
		const remote = await remoteOf(gitEnv, r.root);
		const fetched = remote ? (await gitEnv(r.root, ["fetch", "--quiet", remote.name, `+refs/heads/${r.branch}:refs/remotes/${remote.name}/${r.branch}`])).code === 0 : false;
		const stuck = () => notify(`${r.root}: could not bring ${r.branch} up to ${remote?.name ?? "the remote"}/${r.branch}; check it by hand`);
		if (info.branch !== r.branch && (await gitEnv(r.root, ["switch", "--quiet", r.branch])).code !== 0) {
			stuck();
			continue;
		}
		if (remote && fetched && (await gitEnv(r.root, ["merge", "--ff-only", "--quiet", `${remote.name}/${r.branch}`])).code !== 0) stuck();
	}

	if (!(await setPhase(fl, ctx, "execute"))) return;
	// The plan's other repos join the flow as edited repos (the folder list is the workspace extension's), so the judge and the delivery cover them.
	const added = resumedRepos(roots.map((r) => r.root), { cwd: ctx.cwd, cwdRoot, folders: existingFolders(ctx), touched: fl.state.touchedRepos ?? [] });
	if (added.length) fl.state.touchedRepos = [...(fl.state.touchedRepos ?? []), ...added];
	fl.state.approvedPlan = plan;
	fl.state.stage = status.stage;
	fl.state.stageOutcomes = undefined;
	fl.state.stageJudged = undefined;
	fl.state.checklist = parseChecklist(plan).map((i) => ({ ...i, done: status.done.includes(i.id) }));
	if (!fl.state.checklist.length) fl.state.checklist = undefined;
	fl.state.checkpoints = status.checkpoints?.map((c) => ({ ...c }));
	await restoreReview(fl, ctx, status);
	fl.state.waiting = undefined;
	fl.wait.publishWaitSince.clear();
	if (status.waiting) {
		// Older status files lack the held text and the flags: rebuild the plain stage start for a stage that declares this wait.
		const resumedStages = fl.state.stage ? parseStages(plan) : [];
		const after = fl.state.stage ? resumedStages[fl.state.stage - 1]?.after : undefined;
		const atStart = status.waiting.atStageStart ?? (!!after && after.reason === status.waiting.reason);
		const held = status.waiting.held ?? (atStart && fl.state.stage ? stageStart(resumedStages, fl.state.stage) : undefined);
		const publishStep = /^Call publish_packages again with step (\S+)\.$/.exec(status.waiting.held ?? "")?.[1];
		if (publishStep) fl.wait.publishWaitSince.set(publishStep, status.waiting.since);
		setWaiting(fl, {
			...(publishStep ? { step: publishStep } : {}),
			...(status.waiting.waitKind === "external" ? { waitKind: "external" as const } : {}),
			reason: status.waiting.reason,
			...(cleanCheck(status.waiting.check) ? { check: cleanCheck(status.waiting.check) } : {}),
			since: status.waiting.since,
			stage: fl.state.stage,
			planned: status.waiting.planned ?? true,
			...(atStart ? { atStageStart: true } : {}),
			...(held ? { held } : {}),
		});
	}
	fl.state.planDoc = { flowId: status.flowId, rev: status.rev, roots: roots.map((r) => r.root) };
	persist(fl);
	updateStatus(fl, ctx);
	planMilestone(fl, ctx);
	startWaitTimer(fl, fl.state.waiting?.step && fl.wait.publishWaitSince.has(fl.state.waiting.step) ? Date.parse(fl.state.waiting.since) : undefined);
	await fl.plan.planChain;
	fl.pi.sendMessage(
		{ customType: "workflow-resume-plan", content: `Resumed on this device: check \`git status\` and the branch in each repo, then continue with the open steps.\n\n${planCardText(fl)}`, display: true },
		{ triggerTurn: false },
	);
	notify(`resumed "${status.title}"${status.stage ? ` at stage ${status.stage}` : ""}; send a message to continue${added.length ? ` (${added.length} more repo${added.length === 1 ? "" : "s"} of the plan join the flow)` : ""}`, "info");
}

/** Repos of a resumed plan that join the flow as edited repos: not the working folder's, not an added folder, not already in the flow. */
export function resumedRepos(roots: string[], have: { cwd: string; cwdRoot: string; folders: string[]; touched: string[] }): string[] {
	const out: string[] = [];
	const known = [have.cwd, have.cwdRoot, ...have.folders, ...have.touched].map((p) => repoKey(p));
	for (const r of roots) {
		const abs = path.resolve(r).replace(/\\/g, "/");
		if (known.includes(repoKey(abs)) || out.some((o) => repoKey(o) === repoKey(abs))) continue;
		out.push(abs);
	}
	return out;
}
