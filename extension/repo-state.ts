/**
 * Pure checks the sync runs before it touches git, so they can be tested without pi.
 *
 * repoState: automatic sync runs only on `master` with no rebase, merge, cherry-pick or revert
 * in progress. rebaseBlock: a rebase onto origin/master is allowed only when no tracked file
 * differs from HEAD and every unpushed commit is one of the sync's own.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The branch the sync works on. Fixed: the committed master is the truth. */
export const SYNC_BRANCH = "master";

/** Subject prefix of the sync's own commits. */
export const SYNC_COMMIT_PREFIX = "chore(config): sync from";

export type RepoState = { ok: true } | { ok: false; reason: string };

/** Marker files in the git dir that say an operation is half done. */
const IN_PROGRESS: Array<[string, string]> = [
	["rebase-merge", "a rebase"],
	["rebase-apply", "a rebase"],
	["MERGE_HEAD", "a merge"],
	["CHERRY_PICK_HEAD", "a cherry-pick"],
	["REVERT_HEAD", "a revert"],
];

/** `gitDir` is the result of `git rev-parse --git-dir`, resolved. Never throws. */
export function repoState(gitDir: string, branch = SYNC_BRANCH): RepoState {
	for (const [marker, what] of IN_PROGRESS) {
		if (fs.existsSync(path.join(gitDir, marker))) return { ok: false, reason: `${what} is in progress (${marker})` };
	}
	let head: string;
	try {
		head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
	} catch (e) {
		return { ok: false, reason: `cannot read HEAD: ${(e as Error).message}` };
	}
	const m = /^ref: refs\/heads\/(.+)$/.exec(head);
	if (!m) return { ok: false, reason: `HEAD is detached, not on ${branch}` };
	if (m[1] !== branch) return { ok: false, reason: `on branch ${m[1]}, not ${branch}` };
	return { ok: true };
}

export interface RebaseBlock {
	/** Tracked files that differ from HEAD. */
	files: string[];
	/** Unpushed commits that are not the sync's own. */
	foreign: string[];
}

/**
 * `porcelain` is the output of `git status --porcelain --untracked-files=no`, `subjects` the
 * subjects of `origin/master..HEAD`. Returns null when a rebase is allowed.
 */
export function rebaseBlock(porcelain: string, subjects: string[]): RebaseBlock | null {
	const files = porcelain.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => l.slice(3));
	const foreign = subjects.filter((s) => !s.startsWith(SYNC_COMMIT_PREFIX));
	return files.length === 0 && foreign.length === 0 ? null : { files, foreign };
}
