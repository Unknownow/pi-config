/**
 * The folders a session has added, read from the public `session-folders` custom entry
 * (`{ v: 1, cwd, folders }`, appended by the extension that manages `/folders`). Two readers:
 * `foldersForCwd` only trusts the newest entry when it names the current working folder;
 * `newestFolders` takes the newest entry whatever its cwd.
 */

export const FOLDERS_ENTRY = "session-folders";

/** The data of a `session-folders` entry. */
export interface SessionFoldersData {
	v: 1;
	/** The working folder the list belongs to, with forward slashes. */
	cwd: string;
	/** Absolute folders. */
	folders: string[];
}

function newestEntry(entries: readonly unknown[]): Record<string, unknown> | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null | undefined;
		if (e?.type === "custom" && e.customType === FOLDERS_ENTRY) return typeof e.data === "object" && e.data !== null ? (e.data as Record<string, unknown>) : {};
	}
	return undefined;
}

/** Folders of the newest `session-folders` entry when its `cwd` equals `cwd` (compared with forward slashes); [] otherwise. */
export function foldersForCwd(entries: readonly unknown[], cwd: string): string[] {
	const data = newestEntry(entries);
	if (!data || data.cwd !== cwd.replaceAll("\\", "/") || !Array.isArray(data.folders)) return [];
	return data.folders.filter((f): f is string => typeof f === "string");
}

/** Absolute folders of the newest `session-folders` entry for any cwd (v 1 only), forward slashes, no trailing slash; [] without one. */
export function newestFolders(entries: readonly unknown[]): string[] {
	const data = newestEntry(entries);
	if (!data || data.v !== 1 || !Array.isArray(data.folders)) return [];
	return data.folders.filter((f): f is string => typeof f === "string" && f.length > 0).map((f) => f.replaceAll("\\", "/").replace(/\/+$/, ""));
}
