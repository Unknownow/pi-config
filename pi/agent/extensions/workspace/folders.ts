/** Pure helpers for the session's added folders: filtering, `--add-dir`, and the list of sessions saved before workspace owned it. */
import * as path from "node:path";
import { repoKey } from "../shared/repos.ts";

const norm = (p: string) => {
	const s = p.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "");
	return process.platform === "win32" ? s.toLowerCase() : s;
};

/** The added folders that are in `only` (compared without trailing slashes, case-insensitive on Windows); all of them when `only` is undefined. Unknown entries in `only` are ignored. */
export function keepFolders(added: string[], only: string[] | undefined): string[] {
	if (!only) return added;
	const want = new Set(only.map(norm));
	return added.filter((f) => want.has(norm(f)));
}

/**
 * The folders of the newest `workflow-state` entry: where the workflow kept the list before the workspace extension took it over.
 * Read once, only to migrate a session that has no `session-folders` entry yet; nothing here writes that state.
 */
export function legacyFolders(entries: readonly unknown[]): string[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: { folders?: unknown } } | null | undefined;
		if (e?.type !== "custom" || e.customType !== "workflow-state") continue;
		const f = e.data?.folders;
		return Array.isArray(f) ? f.filter((x): x is string => typeof x === "string" && x.length > 0).map((x) => x.replace(/\\/g, "/")) : [];
	}
	return [];
}

/** `--add-dir` folders joined to `list`: existing folders only, no repeats, never the working folder. Returns the list and the skip notes. */
export function addDirFolders(list: readonly string[], wanted: readonly string[], cwd: string, isDir: (p: string) => boolean): { folders: string[]; notes: string[] } {
	const folders = [...list];
	const notes: string[] = [];
	for (const w of wanted) {
		const abs = path.resolve(cwd, w).replace(/\\/g, "/");
		const key = repoKey(abs);
		if (!isDir(abs)) notes.push(`workspace: --add-dir ${w}: not a folder, skipped`);
		else if (key === repoKey(cwd)) notes.push(`workspace: --add-dir ${w}: that is the working folder, skipped`);
		else if (!folders.some((f) => repoKey(f) === key)) folders.push(abs);
	}
	return { folders, notes };
}
