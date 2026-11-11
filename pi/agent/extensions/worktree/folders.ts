/** The folders a session has added, read from the workflow's public `session-folders` entry (contract K1). */

export const FOLDERS_ENTRY = "session-folders";

/** Absolute folders of the newest `session-folders` entry (forward slashes); none without one. */
export function foldersFromEntries(entries: { type: string; customType?: string; data?: unknown }[]): string[] {
	const newest = entries.filter((e) => e.type === "custom" && e.customType === FOLDERS_ENTRY).pop();
	const data = newest?.data as { v?: unknown; folders?: unknown } | undefined;
	if (!data || data.v !== 1 || !Array.isArray(data.folders)) return [];
	return data.folders.filter((f): f is string => typeof f === "string" && f.length > 0).map((f) => f.replace(/\\/g, "/").replace(/\/+$/, ""));
}

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
