/** The `workspace` system prompt section: the working folder, the added folders and their rules files. Pure: tests load it without pi. */

/** The agent's view of the session's folders. Set on every turn, also without added folders, so the section never moves. */
export function workspaceSection(cwd: string, folders: string[], rules: { path: string; size: number }[] = []): string {
	const lines = [`Working folder: ${cwd}`];
	if (folders.length) lines.push("Added folders (also part of this task):", ...folders.map((f) => `- ${f}`));
	if (rules.length) {
		lines.push("Rules files of the added folders (not loaded): read a folder's files before you plan or change anything in it.");
		lines.push(...[...rules].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((r) => `- ${r.path} (${r.size} characters)`));
	}
	lines.push(
		"Use absolute paths for files outside the working folder. bash starts in the working folder, so use `cd <folder>` or `git -C <folder>` for the others.",
		"The judge reviews every git repo listed here, not only the working folder's.",
	);
	return lines.join("\n");
}
