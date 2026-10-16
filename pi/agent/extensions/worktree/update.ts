/** /wt update and the update at session start: fast-forward each worktree of a set to its base branch. */

import * as path from "node:path";
import { baseOf, type Git, type GitResult } from "./git-ops.ts";

export type UpdateState = "updated" | "current" | "skipped" | "failed";

export interface RepoUpdate {
	wt: string;
	state: UpdateState;
	text: string;
}

const firstLine = (r: GitResult) => (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? "";
const count = (r: GitResult) => (r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) || 0 : -1);

/**
 * Fetch and fast-forward one worktree to its base branch (origin/HEAD, main or master). Never merges,
 * rebases or resets: a branch with its own commits, a detached HEAD or (unless `allowDirty`) uncommitted
 * changes is left alone and reported. With `allowDirty` git itself refuses when a change would be overwritten.
 * `fetchGit` runs only the fetch (e.g. with a short timeout); every other call, the merge too, uses `git`.
 */
export async function updateRepo(git: Git, wt: string, allowDirty: boolean, fetchGit: Git = git): Promise<RepoUpdate> {
	const out = (state: UpdateState, text: string): RepoUpdate => ({ wt, state, text: `${path.basename(wt)}: ${text}` });
	const found = await baseOf(git, wt);
	if (!found) return out("failed", "no origin/HEAD, main or master");
	const base = found.ref;
	const fetch = await fetchGit(wt, ["fetch", found.remote, "--quiet", "--prune"]);
	const stale = fetch.code === 0 ? "" : ` (fetch failed: ${firstLine(fetch)})`;
	const behind = count(await git(wt, ["rev-list", "--count", `HEAD..${base}`]));
	const own = count(await git(wt, ["rev-list", "--count", `${base}..HEAD`]));
	if (behind < 0 || own < 0) return out("failed", `cannot compare with ${base}${stale}`);
	if (behind === 0) return out("current", `up to date with ${base}${stale}`);
	if (own > 0) return out("skipped", `${behind} behind ${base} but has ${own} own commit(s): rebase or merge by hand${stale}`);
	const branch = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
	if (branch === "HEAD") return out("skipped", `${behind} behind ${base}, detached HEAD${stale}`);
	const status = await git(wt, ["status", "--porcelain"]);
	const dirty = status.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
	if (status.code !== 0) return out("failed", `git status failed: ${firstLine(status)}`);
	if (dirty && !allowDirty) return out("skipped", `${behind} behind ${base}, ${dirty} uncommitted change(s): commit, then /wt update${stale}`);
	const ff = await git(wt, ["merge", "--ff-only", "--quiet", base]);
	if (ff.code !== 0) return out("failed", `fast-forward to ${base} failed: ${firstLine(ff)}`);
	const head = (await git(wt, ["rev-parse", "--short", "HEAD"])).stdout.trim();
	return out("updated", `fast-forwarded ${behind} commit(s) to ${base} (${head})${stale}`);
}

/** Update every worktree of a set, one after another (they share object stores, so no parallel fetches). */
export async function updateSet(git: Git, wts: string[], allowDirty: boolean, fetchGit: Git = git): Promise<RepoUpdate[]> {
	const res: RepoUpdate[] = [];
	for (const wt of wts) {
		try {
			res.push(await updateRepo(git, wt, allowDirty, fetchGit));
		} catch (e) {
			res.push({ wt, state: "failed", text: `${path.basename(wt)}: ${(e as Error).message}` });
		}
	}
	return res;
}

/** True when the report is worth showing at session start (anything but "everything already current"). */
export const worthNotifying = (res: RepoUpdate[]) => res.some((r) => r.state !== "current");
