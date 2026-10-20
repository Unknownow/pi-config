/** /wt update and the update at session start: follow the base branch, reattach after a merge, rebase unpushed work. */

import * as path from "node:path";
import { baseOf, mergedPrOf, type Gh, type Git, type GitResult } from "./git-ops.ts";

export type UpdateState = "updated" | "current" | "skipped" | "failed" | "reattached" | "rebased";

export interface RepoUpdate {
	wt: string;
	state: UpdateState;
	text: string;
}

export interface UpdateOpts {
	/** Update a dirty tree too (/wt update); git itself refuses when a change would be overwritten. */
	allowDirty: boolean;
	/** Rebase unpushed own commits onto the base branch. */
	rebase: boolean;
	/** The set's branch, e.g. wt/w1; enables reattach. */
	branch?: string;
	/** gh runner; without it a squash or rebase merge on GitHub is not recognised. */
	gh?: Gh;
}

const firstLine = (r: GitResult) => (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? "";
const count = (r: GitResult) => (r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) || 0 : -1);

/**
 * After `gh pr merge --delete-branch` a worktree sits on a detached HEAD at a commit of the base branch with
 * its branch gone. Put the branch back at that commit (no file changes, fine on a dirty tree). Null when nothing
 * had to be done (attached, or detached somewhere else). Costs one `rev-parse` when attached.
 */
export async function reattach(git: Git, wt: string, branch: string): Promise<RepoUpdate | null> {
	const name = path.basename(wt);
	const cur = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (cur.code !== 0 || cur.stdout.trim() !== "HEAD") return null;
	const found = await baseOf(git, wt);
	if (!found) return null;
	if ((await git(wt, ["merge-base", "--is-ancestor", "HEAD", found.ref])).code !== 0) return null;
	const exists = (await git(wt, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
	if (exists && (await git(wt, ["merge-base", "--is-ancestor", branch, "HEAD"])).code !== 0) {
		return { wt, state: "skipped", text: `${name}: branch ${branch} has commits not in HEAD; left detached` };
	}
	const sw = await git(wt, ["switch", "-C", branch]);
	if (sw.code !== 0) return { wt, state: "failed", text: `${name}: cannot reattach to ${branch}: ${firstLine(sw)}` };
	return { wt, state: "reattached", text: `${name}: reattached to ${branch}` };
}

/**
 * Fetch one worktree and bring it to its base branch (origin/HEAD, main or master): reattach the set's branch
 * after a merge, fast-forward a branch with no commits of its own, reset a branch whose work was merged as a PR
 * on GitHub, rebase unpushed own commits. Pushed commits are never rebased (that needs a force push) and
 * undelivered work is never moved. A conflicting rebase is aborted. Without `allowDirty` a tree with uncommitted
 * changes is left alone and reported.
 * `fetchGit` runs only the fetch (e.g. with a short timeout); every other call, the merge too, uses `git`.
 */
export async function updateRepo(git: Git, wt: string, opts: UpdateOpts, fetchGit: Git = git): Promise<RepoUpdate> {
	const out = (state: UpdateState, text: string): RepoUpdate => ({ wt, state, text: `${path.basename(wt)}: ${text}` });
	const found = await baseOf(git, wt);
	if (!found) return out("failed", "no origin/HEAD, main or master");
	const base = found.ref;
	const fetch = await fetchGit(wt, ["fetch", found.remote, "--quiet", "--prune"]);
	const stale = fetch.code === 0 ? "" : ` (fetch failed: ${firstLine(fetch)})`;
	const re = opts.branch ? await reattach(git, wt, opts.branch) : null;
	if (re && re.state !== "reattached") return re;
	const r = await follow(git, wt, base, stale, opts, out);
	if (!re) return r;
	return r.state === "current" ? { ...re, text: `${re.text}${stale}` } : { ...r, text: `${r.text} (${re.text.replace(`${path.basename(wt)}: `, "")})` };
}

async function follow(
	git: Git,
	wt: string,
	base: string,
	stale: string,
	opts: UpdateOpts,
	out: (state: UpdateState, text: string) => RepoUpdate,
): Promise<RepoUpdate> {
	const behind = count(await git(wt, ["rev-list", "--count", `HEAD..${base}`]));
	const own = count(await git(wt, ["rev-list", "--count", `${base}..HEAD`]));
	if (behind < 0 || own < 0) return out("failed", `cannot compare with ${base}${stale}`);
	const status = await git(wt, ["status", "--porcelain"]);
	if (status.code !== 0) return out("failed", `git status failed: ${firstLine(status)}`);
	const dirty = status.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
	if (own > 0 && behind > 0) {
		// A detached HEAD may be a rebase stopped by the user: never rebase, abort or reset there.
		const cur = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
		if (cur === "HEAD") return out("skipped", `${own} own commit(s), ${behind} behind ${base}, detached HEAD${stale}`);
		if (opts.gh && opts.branch) {
			const { pr } = await mergedPrOf(git, opts.gh, wt, opts.branch);
			if (pr !== null) {
				if (dirty) return out("skipped", `delivered in PR #${pr}; commit or discard changes, then /wt update${stale}`);
				const sw = await git(wt, ["switch", "-C", opts.branch, "--no-track", base]);
				if (sw.code !== 0) return out("failed", `reset to ${base} failed: ${firstLine(sw)}`);
				return out("updated", `work delivered in PR #${pr}; reset to ${base}${stale}`);
			}
		}
		const notPushed = count(await git(wt, ["rev-list", "--count", `${base}..HEAD`, "--not", "--remotes"]));
		if (notPushed >= 0 && notPushed < own) {
			return out("skipped", `${own} own commit(s), pushed: rebasing needs a force push; merge ${base} by hand or deliver as is${stale}`);
		}
		if (dirty) return out("skipped", `${own} own commit(s), ${behind} behind ${base}, ${dirty} uncommitted change(s): commit, then /wt update${stale}`);
		if (!opts.rebase) return out("skipped", `${own} own commit(s), ${behind} behind ${base}: /wt update to rebase${stale}`);
		const rb = await git(wt, ["rebase", "--quiet", base]);
		if (rb.code !== 0) {
			await git(wt, ["rebase", "--abort"]);
			return out("failed", `rebase onto ${base} conflicts; left as before: rebase by hand${stale}`);
		}
		const head = (await git(wt, ["rev-parse", "--short", "HEAD"])).stdout.trim();
		return out("rebased", `rebased ${own} commit(s) onto ${base} (${head})${stale}`);
	}
	if (behind === 0) return out("current", `up to date with ${base}${stale}`);
	const current = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	if (current === "HEAD") return out("skipped", `${behind} behind ${base}, detached HEAD${stale}`);
	if (dirty && !opts.allowDirty) return out("skipped", `${behind} behind ${base}, ${dirty} uncommitted change(s): commit, then /wt update${stale}`);
	const ff = await git(wt, ["merge", "--ff-only", "--quiet", base]);
	if (ff.code !== 0) return out("failed", `fast-forward to ${base} failed: ${firstLine(ff)}`);
	const head = (await git(wt, ["rev-parse", "--short", "HEAD"])).stdout.trim();
	return out("updated", `fast-forwarded ${behind} commit(s) to ${base} (${head})${stale}`);
}

/** Update every worktree of a set in parallel (each repo has its own object store); results keep the input order. */
export async function updateSet(git: Git, wts: string[], opts: UpdateOpts, fetchGit: Git = git): Promise<RepoUpdate[]> {
	return Promise.all(
		wts.map(async (wt): Promise<RepoUpdate> => {
			try {
				return await updateRepo(git, wt, opts, fetchGit);
			} catch (e) {
				return { wt, state: "failed", text: `${path.basename(wt)}: ${(e as Error).message}` };
			}
		}),
	);
}

/** True when the report is worth showing at session start (anything but "everything already current"). */
export const worthNotifying = (res: RepoUpdate[]) => res.some((r) => r.state !== "current");
