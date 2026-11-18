/** Added folders that follow the conversation when `/wt use` or `/wt done` moves it to another checkout. Pure: tests load it without git. */
import { repoKey } from "../shared/repos.ts";

/** A folder's git repo: its work tree top and the original repo (`mainRepoOf`) that worktree belongs to. */
export interface FolderRepo {
	top: string;
	main: string;
}

/**
 * The added folders after a move. A folder in a git repo whose original repo has a checkout in `checkouts` (key: `repoKey(main)`,
 * value: that checkout's top) moves to the same subfolder there when it exists; plain folders and other repos stay.
 * A result equal to `newCwd` is dropped, and so are repeats.
 */
export function remapFolders(
	folders: readonly string[],
	repoOf: (folder: string) => FolderRepo | null,
	checkouts: ReadonlyMap<string, string>,
	newCwd: string,
	exists: (p: string) => boolean,
): string[] {
	const out: string[] = [];
	for (const f of folders) {
		let next = f.replace(/\\/g, "/").replace(/\/+$/, "");
		const repo = repoOf(f);
		const to = repo ? checkouts.get(repoKey(repo.main)) : undefined;
		if (repo && to) {
			const top = repoKey(repo.top);
			const key = repoKey(next);
			const rel = key === top ? "" : key.startsWith(`${top}/`) ? next.slice(next.length - (key.length - top.length - 1)) : null;
			const base = to.replace(/\\/g, "/").replace(/\/+$/, "");
			if (rel !== null) {
				const target = rel ? `${base}/${rel}` : base;
				if (exists(target)) next = target;
			}
		}
		if (repoKey(next) === repoKey(newCwd) || out.some((o) => repoKey(o) === repoKey(next))) continue;
		out.push(next);
	}
	return out;
}
