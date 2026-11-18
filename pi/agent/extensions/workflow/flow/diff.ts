/** Diffs of the flow's repos, the judge call and its review plan, the review base the judge diffs from, and the plan text the judge reads. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { planFlaws } from "../agent-end.ts";
import { parseFindings } from "../gates.ts";
import { type RepoDiff, collectRepoDiff as collectRepoDiffImpl, citeNames, needsFinalFullReview, shouldSkipRepeatFullReview } from "../../shared/git/repo-diff.ts";
import { forkBase, defaultRunner, mergedBase, baseFromTree } from "../../shared/git/merge-gate.ts";
import { repoKey, combineRepoTexts } from "../../shared/repos.ts";
import { foldersForCwd } from "../../shared/session-folders.ts";
import { type PlanStatus, planCard } from "../plan-doc.ts";
import { readRegistry, type BoardEntry, readLive, boardRows } from "../board.ts";
import { readLocalStatuses, pidAlive, writeReviewRef, deleteReviewRef } from "../plan-store.ts";
import { checkpointNote } from "../checkpoints.ts";
import { stageNote } from "../stages.ts";
import { type DiffPart, mapLimit, emptyUsage, addUsage } from "../../agents/api.ts";
import type { FlowRun } from "../view.ts";
import { type Diff, execFileAsync, type Flow, type FlowState, type JudgeResult, type RepoRef, type ReviewPlan, type Snaps } from "./context.ts";
import { judgeOnce, trimPlan } from "./judge.ts";
import { currentStages, persist } from "./phase.ts";
import { gitEnv, planDirFor, planFilePath } from "./plan-files.ts";
import { modelOf } from "./roles.ts";

export async function git(fl: Flow, cwd: string, ...args: string[]) {
	return fl.pi.exec("git", ["-C", cwd, ...args], { timeout: 30_000 });
}

/** Tracked changes against `base` plus untracked files of one repo (untruncated), or null outside a git work tree. */
export function collectRepoDiff(fl: Flow, cwd: string, base = "HEAD"): Promise<RepoDiff | null> {
	return collectRepoDiffImpl((dir, ...args) => git(fl, dir, ...args), cwd, base);
}

/** A Diff from the whole text (hashed) and its per-repo parts; agents' fitDiffs fits the parts to the judge's limit. */
export function makeDiff(full: string, parts: DiffPart[], files: number, names: string[], checkNames: string[], base: string, repos: RepoRef[], multi: boolean): Diff {
	const hash = createHash("sha1").update(full).digest("hex");
	return { text: full, parts, hash, files, base, names, checkNames, chars: full.length, repos, multi };
}

/** One repo's diff, or null outside a git work tree. `baseKey` identifies the base(s) the diff was taken against. */
export async function collectDiff(fl: Flow, cwd: string, base = "HEAD", baseKey = base): Promise<Diff | null> {
	const r = await collectRepoDiff(fl, cwd, base);
	if (!r) return null;
	const root = (await gitRoot(fl, cwd)) ?? cwd;
	return makeDiff(r.full, [{ key: root, base, full: r.full, names: r.names }], r.files, r.names, r.checkNames, baseKey, [{ root, dir: cwd, changed: r.full.length > 0 }], false);
}

/** The git work tree's top folder containing `dir`, or null. Only successes are cached. */
export async function gitRoot(fl: Flow, dir: string): Promise<string | null> {
	const k = repoKey(dir);
	const hit = fl.rootCache.get(k);
	if (hit) return hit;
	if (!fs.existsSync(dir)) return null;
	const r = await git(fl, dir, "rev-parse", "--show-toplevel");
	const root = r.code === 0 ? r.stdout.trim() : "";
	if (!root) return null;
	fl.rootCache.set(k, root);
	return root;
}

/** The session's added folders (the workspace extension's `session-folders` entry for this working folder) that still exist. */
export function existingFolders(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): string[] {
	return foldersForCwd(ctx.sessionManager.getBranch(), ctx.cwd).filter((f) => {
		try {
			return fs.statSync(f).isDirectory();
		} catch {
			return false;
		}
	});
}

/** Every flow this machine's sessions have recently touched: registry dirs plus this session's repos. */
export async function collectBoard(fl: Flow, ctx: ExtensionContext) {
	const dirs = new Set<string>(readRegistry(path.join(getAgentDir(), "workflow", "board.json")));
	try {
		dirs.add(await planDirFor(fl, null));
		for (const r of await flowRepos(fl, ctx)) dirs.add(await planDirFor(fl, r.root));
	} catch {}
	const entries: BoardEntry[] = [];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		for (const it of readLocalStatuses(dir)) entries.push({ flowId: it.flowId, dir, status: it.status, live: readLive(dir, it.flowId), mtime: it.mtime });
	}
	return boardRows(entries, Date.now(), os.hostname(), pidAlive);
}

/** The repos of this flow: the working folder's, the added folders', then those edited in the flow; git work trees only, no repeats. */
export async function flowRepos(fl: Flow, ctx: ExtensionContext): Promise<RepoRef[]> {
	const out: RepoRef[] = [];
	const seen = new Set<string>();
	const add = (root: string | null, dir: string) => {
		if (!root || seen.has(repoKey(root))) return;
		seen.add(repoKey(root));
		out.push({ root, dir, changed: false });
	};
	add(await gitRoot(fl, ctx.cwd), ctx.cwd);
	for (const f of existingFolders(ctx)) {
		const root = await gitRoot(fl, f);
		add(root, root ?? f);
	}
	for (const t of fl.state.touchedRepos ?? []) {
		const root = await gitRoot(fl, t);
		add(root, root ?? t);
	}
	return out;
}

/** The ref each repo's diff is taken against: `base` when given, else the repo's review base while executing, else HEAD. */
export async function diffBase(fl: Flow, ctx: ExtensionContext, ref: RepoRef, base: string | undefined): Promise<string> {
	if (base) {
		// A base that exists only in the working folder's repo means HEAD in the others.
		if (ref.dir !== ctx.cwd && base !== "HEAD" && (await git(fl, ref.dir, "rev-parse", "--verify", "--quiet", `${base}^{commit}`)).code !== 0) return "HEAD";
		return base;
	}
	if (fl.state.phase === "execute" && !fl.state.reviewBase?.[repoKey(ref.root)]) await joinReviewBase(fl, ref.root, true);
	const review = fl.state.phase === "execute" ? fl.state.reviewBase?.[repoKey(ref.root)] : undefined;
	if (!review) return "HEAD";
	if ((await git(fl, ref.dir, "rev-parse", "--verify", "--quiet", `${review}^{commit}`)).code === 0) return review;
	if (!fl.goneBases.has(review)) {
		fl.goneBases.add(review);
		ctx.ui.notify(`workflow: the review base of ${ref.root} is gone; reviewing from HEAD`, "warning");
	}
	return "HEAD";
}

/** The diff of every repo in this flow, each against its review base (or `base`). With only the working folder's repo it is exactly collectDiff(ctx.cwd). */
export async function collectFlowDiff(fl: Flow, ctx: ExtensionContext, base?: string): Promise<Diff | null> {
	const refs = await flowRepos(fl, ctx);
	if (refs.length === 0) return null;
	const bases = await Promise.all(refs.map((ref) => diffBase(fl, ctx, ref, base)));
	const baseKey = refs.map((ref, i) => `${repoKey(ref.root)}=${bases[i]}`).join(";");
	if (refs.length === 1 && refs[0].dir === ctx.cwd) return collectDiff(fl, ctx.cwd, bases[0], baseKey);
	const per = await mapLimit(refs, 4, async (ref) => collectRepoDiff(fl, ref.dir, bases[refs.indexOf(ref)]));
	const parts: { root: string; text: string }[] = [];
	const diffParts: DiffPart[] = [];
	const names: string[] = [];
	const checkNames: string[] = [];
	let files = 0;
	const repos = refs.map((ref, i) => {
		const r = per[i];
		if (r) {
			parts.push({ root: ref.root, text: r.full });
			if (r.full) diffParts.push({ key: ref.root, base: bases[i], full: r.full, names: r.rootNames });
			names.push(...r.rootNames.map((n) => `${ref.root}/${n}`));
			for (const n of r.checkNames) if (!checkNames.includes(n)) checkNames.push(n);
			files += r.files;
		}
		return { ...ref, changed: !!r && r.full.length > 0 };
	});
	return makeDiff(combineRepoTexts(parts), diffParts, files, names, checkNames, baseKey, repos, true);
}

export function repoRoots(diff: Diff): string[] {
	return diff.repos.filter((r) => r.changed).map((r) => r.root);
}

/** The working tree (tracked and untracked files, minus ignored ones) as a git tree id, or null. Uses a temporary index. */
export async function snapshotTree(cwd: string): Promise<string | null> {
	const tmp = path.join(os.tmpdir(), `workflow-judge-index-${process.pid}-${randomUUID()}`); // unique: snapshotRepos runs this for several repos at once
	const run = (args: string[]) =>
		execFileAsync("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_INDEX_FILE: tmp }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
	try {
		const index = path.resolve(cwd, (await execFileAsync("git", ["-C", cwd, "rev-parse", "--git-path", "index"])).stdout.trim());
		if (fs.existsSync(index)) fs.copyFileSync(index, tmp); // warm start: only changed files get hashed
		await run(["add", "-A"]);
		return (await run(["write-tree"])).stdout.trim() || null;
	} catch {
		return null;
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

/** Each repo's working tree and HEAD, or null when a tree cannot be built. */
export async function snapshotRepos(fl: Flow, diff: Diff): Promise<Snaps | null> {
	const per = await Promise.all(
		diff.repos.map(async (r) => {
			const [tree, head] = await Promise.all([snapshotTree(r.dir), git(fl, r.dir, "rev-parse", "HEAD")]);
			return { key: repoKey(r.root), tree, head: head.stdout.trim() };
		}),
	);
	const snaps: Snaps = {};
	for (const p of per) {
		if (!p.tree) return null;
		snaps[p.key] = { tree: p.tree, head: p.head };
	}
	return snaps;
}

/** True when a minor-fix round changed only files the minor findings cite, in every repo of the diff. */
export async function minorFixOnly(fl: Flow, diff: Diff): Promise<boolean> {
	const fix = fl.state.minorFix;
	if (!fix || !fix.cited.length || fl.state.lastJudge?.base !== diff.base) return false;
	const snaps = await snapshotRepos(fl, diff);
	if (!snaps) return false;
	const keys = Object.keys(snaps);
	if (keys.length !== Object.keys(fix.trees).length || keys.some((k) => !fix.trees[k])) return false;
	for (const r of diff.repos) {
		const k = repoKey(r.root);
		const d = await git(fl, r.dir, "diff", "--name-only", "-z", fix.trees[k], snaps[k].tree);
		if (d.code !== 0) return false;
		const names = d.stdout.split("\0").filter(Boolean).map((n) => n.replace(/\\/g, "/"));
		if (names.some((n) => !fix.cited.some((c) => c === n || c.endsWith(`/${n}`) || (c.includes("/") && n.endsWith(`/${c}`))))) return false;
	}
	return true;
}

/** Whether the judge reviews the whole diff, only the changes since its last round, or nothing (no changes since). */
export async function reviewPlan(fl: Flow, diff: Diff, full: boolean, skipSame = false): Promise<ReviewPlan> {
	const prev = fl.state.lastJudge;
	if (!full && !skipSame && prev?.hash === diff.hash) return { kind: "same", prev };
	const snaps = await snapshotRepos(fl, diff);
	const fullPlan = { kind: "full" as const, snaps };
	// Another base or another set of repos: the last round no longer lines up. Commits since do not matter: the delta is between trees.
	if (full || !fl.cfg.judge.recheck || !prev?.repos || !snaps || prev.base !== diff.base) return fullPlan;
	const before = prev.repos;
	const keys = Object.keys(snaps);
	if (keys.length !== Object.keys(before).length || keys.some((k) => !before[k])) return fullPlan;
	const per = await Promise.all(
		diff.repos.map(async (r) => {
			const k = repoKey(r.root);
			const [d, n] = await Promise.all([
				git(fl, r.dir, "diff", "--no-color", before[k].tree, snaps[k].tree),
				git(fl, r.dir, "diff", "--name-only", "-z", "--diff-filter=d", before[k].tree, snaps[k].tree),
			]);
			return { root: r.root, base: before[k].tree, text: d.stdout, names: n.stdout.split("\0").filter(Boolean) };
		}),
	);
	const delta = diff.multi ? combineRepoTexts(per) : per[0].text;
	// Fixes that rewrite most of the change get a full review: little to save, more to miss.
	if (!delta.trim() || delta.length > diff.chars * fl.cfg.judge.recheckMaxShare) return fullPlan;
	const changed: string[] = [];
	for (const p of per) for (const n of p.names) if (!changed.includes(n)) changed.push(n);
	const parts = per.filter((p) => p.text).map((p) => ({ key: p.root, base: p.base, full: p.text, names: p.names }));
	return { kind: "recheck", snaps, prev, delta, parts, changed, cites: citeNames(per, diff.multi) };
}

/**
 * Reviews `diff`. The first round sees the whole diff; later rounds see only the changes since the
 * last round plus its findings (cheaper, fresh each time). A large change that passes on a
 * re-review gets one final full review when the changes since touched a file the last findings did not cite. `full` forces a full review.
 */
export async function judge(fl: Flow, ctx: ExtensionContext, diff: Diff, focus: string | undefined, signal?: AbortSignal, onChange?: (run: FlowRun) => void, full = false, disputes?: string): Promise<JudgeResult & { run: FlowRun }> {
	// A minor-fix round that touched only the cited files needs no review: the tree counts as passed.
	if (!full && !disputes && (await minorFixOnly(fl, diff))) {
		const run = fl.view.start("judge", "minor fixes in the cited files", modelOf(fl, "judge").model);
		fl.view.finish(run, true, "PASS · only the cited files changed, no re-review");
		onChange?.(run);
		fl.seenDiffs.add(diff.hash);
		const snaps = await snapshotRepos(fl, diff);
		fl.state.minorFix = undefined;
		fl.state.lastJudge = snaps ? { hash: diff.hash, repos: snaps, base: diff.base, verdict: "PASS", text: "The fix touched only the files the minor findings cite; it is passed without another review." } : fl.state.lastJudge;
		markPassed(fl, diff.hash);
		return { verdict: "PASS", text: "The fix touched only the files the minor findings cite; it is passed without another review.", findings: [], hash: diff.hash, usage: emptyUsage(), run };
	}
	// A real review is running: the minor-fix shortcut is gone for good.
	if (fl.state.minorFix) {
		fl.state.minorFix = undefined;
		persist(fl);
	}
	// Disputes need a fresh look at the code, so they never get the "no changes" shortcut (a recheck still applies).
	const plan = await reviewPlan(fl, diff, full, Boolean(disputes));
	if (plan.kind === "same") {
		const run = fl.view.start("judge", "no changes since the last round", modelOf(fl, "judge").model);
		fl.view.finish(run, plan.prev.verdict === "PASS", `${plan.prev.verdict} · unchanged, previous result`);
		onChange?.(run);
		fl.seenDiffs.add(diff.hash);
		return { verdict: plan.prev.verdict, text: `No changes since the last judge round; its result stands.\n\n${plan.prev.text}`, findings: parseFindings(plan.prev.text), hash: diff.hash, usage: emptyUsage(), run };
	}
	let r = await judgeOnce(fl, ctx, diff, focus, plan, signal, onChange, disputes);
	const limit = fl.cfg.judge.finalFullReviewOverChars;
	if (r.verdict === "PASS" && plan.kind === "recheck" && limit > 0 && diff.chars > limit && needsFinalFullReview(fl.cfg.judge.finalFullReviewNewFilesOnly, plan.prev.text, plan.cites)) {
		const share = await repeatShare(fl, diff, plan.snaps);
		if (share !== undefined) {
			r = { ...r, text: `${r.text}\n\nFinal full review skipped: a full review passed this stage and the changes since are ${Math.round(share * 100)}% of the diff.` };
		} else {
			const final = await judgeOnce(fl, ctx, diff, focus, { kind: "full", snaps: plan.snaps }, signal, onChange, disputes);
			r = { ...final, usage: addUsage(addUsage(emptyUsage(), r.usage), final.usage) };
		}
	}
	// A pass that questions the plan is not a pass yet: resolvePlanFlaw decides.
	if (r.verdict === "PASS" && !planFlaws(r.findings).length) markPassed(fl, diff.hash);
	return r;
}

/** The share of the diff changed since the last passing full review of this stage, when that is small enough to skip the final full review; else undefined. */
export async function repeatShare(fl: Flow, diff: Diff, snaps: Snaps | undefined): Promise<number | undefined> {
	const pass = fl.state.lastFullPass;
	if (!pass || !snaps || pass.base !== diff.base || diff.chars <= 0) return undefined;
	const keys = Object.keys(snaps);
	if (keys.length !== Object.keys(pass.repos).length || keys.some((k) => !pass.repos[k])) return undefined;
	const parts = await Promise.all(diff.repos.map((r) => git(fl, r.dir, "diff", "--no-color", pass.repos[repoKey(r.root)]?.tree ?? "", snaps[repoKey(r.root)]?.tree ?? "")));
	if (parts.some((p) => p.code !== 0)) return undefined;
	const since = parts.reduce((n, p) => n + p.stdout.length, 0);
	return shouldSkipRepeatFullReview(since, diff.chars, fl.cfg.judge.finalFullReviewRepeatMaxShare) ? since / diff.chars : undefined;
}

export function markPassed(fl: Flow, hash: string): void {
	fl.state.passedDiff = hash;
	fl.state.judgeRounds = 0;
	recordPassedTrees(fl, hash);
	persist(fl);
}

// ----------------------------------------------------------------------
// Review base, passed trees and the judge gate
// ----------------------------------------------------------------------

/** Remembers the trees of a judge pass: a merge, a push to a protected branch and a publish need the tree they act on to be one of them. */
export function recordPassedTrees(fl: Flow, hash: string): void {
	const repos = fl.state.lastJudge?.hash === hash ? fl.state.lastJudge.repos : undefined;
	if (!repos) return;
	const all = { ...(fl.state.passedTrees ?? {}) };
	for (const [k, v] of Object.entries(repos)) all[k] = [...(all[k] ?? []).filter((t) => t !== v.tree), v.tree].slice(-20);
	fl.state.passedTrees = all;
}

/** Every repo of the flow starts its review at its HEAD. */
export async function initReviewBase(fl: Flow, ctx: ExtensionContext): Promise<void> {
	const base: Record<string, string> = {};
	for (const r of await flowRepos(fl, ctx)) {
		const head = await git(fl, r.dir, "rev-parse", "HEAD");
		if (head.code === 0 && head.stdout.trim()) base[repoKey(r.root)] = head.stdout.trim();
	}
	fl.state.reviewBase = Object.keys(base).length ? base : undefined;
}

/**
 * A repo that joins the flow later reviews from its HEAD at that time. `lazy`: the join is only noticed now (a resumed flow, or a diff of a repo
 * nobody announced), so commits may already exist: the base is then where the branch left the base branch, so they are reviewed too.
 */
export async function joinReviewBase(fl: Flow, root: string, lazy = false): Promise<void> {
	if (fl.state.phase !== "execute") return;
	const key = repoKey(root);
	if (fl.state.reviewBase?.[key]) return;
	let base = "";
	if (lazy) {
		const upstream = await upstreamBase(fl, root);
		base = (upstream ? await forkBase(defaultRunner, root, upstream) : null) ?? "";
	}
	if (!base) {
		const head = await git(fl, root, "rev-parse", "HEAD");
		if (head.code === 0) base = head.stdout.trim();
	}
	if (base) {
		fl.state.reviewBase = { ...(fl.state.reviewBase ?? {}), [key]: base };
		persist(fl);
	}
}

/**
 * While executing, every repo of the flow without a review base joins lazily (`joinReviewBase(root, true)`): a folder added with
 * /folders or moved by /wt since the flow started is only seen here, so commits made in it meanwhile are reviewed too.
 * Runs before the judge and before a delivery.
 */
export async function joinNewRepos(fl: Flow, ctx: ExtensionContext): Promise<void> {
	if (fl.state.phase !== "execute") return;
	for (const ref of await flowRepos(fl, ctx)) if (!fl.state.reviewBase?.[repoKey(ref.root)]) await joinReviewBase(fl, ref.root, true);
}

/** Moves a repo's review base to `commit` and keeps that commit alive under the flow's ref. A failed ref write only warns: the base works until git collects it. */
export async function setReviewBase(fl: Flow, ctx: ExtensionContext, ref: RepoRef, commit: string): Promise<void> {
	const key = repoKey(ref.root);
	fl.state.reviewBase = { ...(fl.state.reviewBase ?? {}), [key]: commit };
	const flowId = fl.state.planDoc?.flowId;
	if (!flowId) return;
	if (await writeReviewRef(gitEnv, ref.dir, flowId, commit)) fl.reviewRefs.set(key, { dir: ref.dir, flowId });
	else ctx.ui.notify(`workflow: review base kept in memory only (could not write refs/pi/review-base/${flowId} in ${ref.root})`, "warning");
}

/** The base branch of a repo as `origin/<name>`: delivery.base, else origin's HEAD, else origin/main; undefined when none exists. */
export async function upstreamBase(fl: Flow, dir: string): Promise<string | undefined> {
	const names: string[] = [];
	if (fl.cfg.delivery.base) names.push(`origin/${fl.cfg.delivery.base}`);
	const head = await git(fl, dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
	if (head.code === 0 && head.stdout.trim()) names.push(head.stdout.trim());
	names.push("origin/main");
	for (const n of names) if ((await git(fl, dir, "rev-parse", "--verify", "--quiet", `${n}^{commit}`)).code === 0) return n;
	return undefined;
}

/**
 * Before a judge run: when the base branch was merged into a repo's branch, its review base takes in what that brought, so the merged work
 * is not reviewed as this flow's. Returns a note for the judge's focus when that was not possible (a conflict, or git before 2.38).
 */
export async function refreshReviewBase(fl: Flow, ctx: ExtensionContext): Promise<string | undefined> {
	if (fl.state.phase !== "execute") return undefined;
	await joinNewRepos(fl, ctx);
	const notes = new Set<string>();
	for (const ref of await flowRepos(fl, ctx)) {
		const base = fl.state.reviewBase?.[repoKey(ref.root)];
		if (!base) continue;
		const upstream = await upstreamBase(fl, ref.dir);
		if (!upstream) continue;
		if ((await git(fl, ref.dir, "merge-base", "--is-ancestor", upstream, "HEAD")).code !== 0) continue;
		if ((await git(fl, ref.dir, "merge-base", "--is-ancestor", upstream, base)).code === 0) continue;
		const moved = await mergedBase(defaultRunner, ref.dir, base, upstream);
		if (moved) await setReviewBase(fl, ctx, ref, moved);
		else notes.add(`This diff includes changes merged from ${upstream}; review only this flow's changes.`);
	}
	return notes.size ? [...notes].join(" ") : undefined;
}

/** After a stage passes: each repo's review base becomes the worktree as it is, so the next stage is reviewed on its own. */
export async function advanceReviewBase(fl: Flow, ctx: ExtensionContext): Promise<void> {
	const repos = fl.state.lastJudge?.repos;
	if (!repos) return;
	for (const ref of await flowRepos(fl, ctx)) {
		const snap = repos[repoKey(ref.root)];
		if (!snap) continue;
		// The worktree as it is now, not the tree that was judged: the flow's pull request may be merged and the base branch moved on since.
		const tree = (await snapshotTree(ref.dir)) ?? snap.tree;
		const sha = await baseFromTree(defaultRunner, ref.dir, tree);
		if (!sha) {
			ctx.ui.notify("workflow: review base not moved (git commit-tree failed)", "warning");
			continue;
		}
		await setReviewBase(fl, ctx, ref, sha);
	}
}

/** Deletes the flow's review-base refs: those this session wrote, and the flow's ref in every repo it covers (a reloaded session lost the list). */
export async function dropReviewRefs(fl: Flow, ctx: ExtensionContext): Promise<void> {
	const written = [...fl.reviewRefs.values()];
	fl.reviewRefs.clear();
	for (const v of written) await deleteReviewRef(gitEnv, v.dir, v.flowId);
	const flowId = fl.state.planDoc?.flowId;
	if (!flowId) return;
	for (const ref of await flowRepos(fl, ctx)) await deleteReviewRef(gitEnv, ref.dir, flowId);
}

/** A resumed flow takes back its review state. A review base git no longer has falls back to HEAD with a warning. */
export async function restoreReview(fl: Flow, ctx: ExtensionContext, status: PlanStatus): Promise<void> {
	fl.state.passedTrees = status.passedTrees ? Object.fromEntries(Object.entries(status.passedTrees).map(([k, v]) => [k, [...v]])) : undefined;
	fl.state.judgedMerges = status.judgedMerges ? Object.fromEntries(Object.entries(status.judgedMerges).map(([k, v]) => [k, { ...v }])) : undefined;
	for (const ref of await flowRepos(fl, ctx)) {
		const key = repoKey(ref.root);
		const sha = status.reviewBase?.[key];
		if (!sha) {
			await joinReviewBase(fl, ref.root, true);
			continue;
		}
		if ((await git(fl, ref.dir, "cat-file", "-e", `${sha}^{commit}`)).code === 0) {
			fl.state.reviewBase = { ...(fl.state.reviewBase ?? {}), [key]: sha };
			fl.reviewRefs.set(key, { dir: ref.dir, flowId: status.flowId });
		} else ctx.ui.notify(`workflow: the review base of ${ref.root} is gone; reviewing from HEAD`, "warning");
	}
}

/** The approved plan for the judge and the arbiter; a very long one loses its middle, never its amendments. */
export function planForJudge(fl: Flow): string {
	const plan = fl.state.approvedPlan;
	if (!plan) return "None recorded: judge the diff on its own.";
	const staged = currentStages(fl);
	const note = staged ? `\n\n${stageNote(staged.stages, staged.current)}` : "";
	const list = fl.state.checklist?.length ? `\n\n## Executor's checklist (claims, not proof)\n${fl.state.checklist.map((i) => `- [${i.done ? "x" : " "}] ${i.id} ${i.text}`).join("\n")}` : "";
	return trimPlan(plan) + note + list + checkpointSection(fl);
}

/** Checkpoints delivered earlier: this stage's in a staged plan, all of them otherwise. */
export function stageCheckpoints(fl: Flow): NonNullable<FlowState["checkpoints"]> {
	const staged = currentStages(fl);
	return (fl.state.checkpoints ?? []).filter((c) => !staged || c.stage === staged.current);
}

export function checkpointSection(fl: Flow): string {
	const note = checkpointNote(stageCheckpoints(fl));
	return note ? `\n\n${note}` : "";
}

/** N of the next `## Amendment N`: the amendments already in the approved plan + 1 (shared by the arbiter and the executor). */
export function nextAmendmentNumber(fl: Flow): number {
	return (fl.state.approvedPlan?.match(/^## Amendment \d+/gm) ?? []).length + 1;
}

/** `planCardText` once the plan file is written: waits for the plan write queue, at most 10 s, so the card can name the file. */
export async function planCardReady(fl: Flow): Promise<string> {
	if (!planFilePath(fl)) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([fl.plan.planChain, new Promise<void>((resolve) => (timer = setTimeout(resolve, 10_000)))]);
		clearTimeout(timer);
	}
	return planCardText(fl);
}

/** The short plan sent after a compaction in place of the full plan. Without a plan file it carries the (trimmed) plan itself. */
export function planCardText(fl: Flow): string {
	const staged = currentStages(fl);
	const file = planFilePath(fl);
	const plan = fl.state.approvedPlan ?? "";
	return planCard(file ? plan : trimPlan(plan), fl.state.checklist, staged?.current, staged?.stages.length, file, fl.state.waiting?.reason);
}
