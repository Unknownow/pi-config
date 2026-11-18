/** Which added folders a session has: the newest `session-folders` entry, only when it names the current working folder. */

export const FOLDERS_ENTRY = "session-folders";

/** Folders of the newest `session-folders` entry whose `cwd` equals `cwd` (compared with forward slashes); [] otherwise. */
export function foldersForCwd(entries: unknown[], cwd: string): string[] {
	const newest = entries
		.filter((e) => (e as { type?: string })?.type === "custom" && (e as { customType?: string }).customType === FOLDERS_ENTRY)
		.pop() as { data?: { cwd?: unknown; folders?: unknown } } | undefined;
	const data = newest?.data;
	if (!data || data.cwd !== cwd.replaceAll("\\", "/") || !Array.isArray(data.folders)) return [];
	return data.folders.filter((f): f is string => typeof f === "string");
}
