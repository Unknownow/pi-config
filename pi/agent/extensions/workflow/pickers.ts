/**
 * Pure helpers for the interactive pickers: folder Tab completion and the model list. The caller
 * supplies the directory reader and the model list, so pickers.test.ts covers them.
 */

import * as path from "node:path";

const MAX_ITEMS = 50;

/** Subfolders of the folder `partial` points into, as `typed/folder/name/` strings. */
export function pathCompletions(partial: string, cwd: string, home: string, readDirs: (dir: string) => string[] | null): string[] {
	const text = partial.replace(/^"/, "").replace(/"$/, "");
	const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
	const folderPart = text.slice(0, cut + 1);
	const prefix = text.slice(cut + 1).toLowerCase();
	let dir: string;
	if (folderPart === "~" || /^~[\\/]/.test(folderPart)) dir = path.resolve(home, "." + folderPart.slice(1));
	else dir = path.resolve(cwd, folderPart || ".");
	const names = readDirs(dir);
	if (!names) return [];
	const shown = folderPart.replace(/\\/g, "/");
	return names
		.filter((n) => n.toLowerCase().startsWith(prefix) && (!n.startsWith(".") || prefix.startsWith(".")))
		.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
		.slice(0, MAX_ITEMS)
		.map((n) => `${shown}${n}/`);
}

/** Models sorted by provider then id, as `provider/id` values with a readable label. */
export function modelChoices(models: { provider: string; id: string; name?: string }[], current?: string): { value: string; label: string }[] {
	return [...models]
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
		.map((m) => {
			const value = `${m.provider}/${m.id}`;
			const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
			return { value, label: `${value}${name}${value === current ? " (current)" : ""}` };
		});
}
