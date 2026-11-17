import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseAddDir, repoKey, parseWorktreeList, followFolders } from "../../shared/repos.ts";
import { type Flow, FOLDERS_ENTRY } from "./context.ts";
import { git, gitRoot } from "./diff.ts";
import { persist, publishFolders } from "./phase.ts";

/** Folders from --add-dir join the session's list (existing folders only, no repeats, not the working folder). */
export function applyAddDir(fl: Flow, ctx: ExtensionContext): void {
	const wanted = parseAddDir(fl.pi.getFlag("add-dir"));
	if (wanted.length === 0) return;
	const folders = [...(fl.state.folders ?? [])];
	let changed = false;
	for (const w of wanted) {
		const abs = path.resolve(ctx.cwd, w).replace(/\\/g, "/");
		const key = repoKey(abs);
		let ok = false;
		try {
			ok = fs.statSync(abs).isDirectory();
		} catch {
			// not there
		}
		if (!ok) ctx.ui.notify(`workflow: --add-dir ${w}: not a folder, skipped`, "warning");
		else if (key === repoKey(ctx.cwd)) ctx.ui.notify(`workflow: --add-dir ${w}: that is the working folder, skipped`, "warning");
		else if (!folders.some((f) => repoKey(f) === key)) {
			folders.push(abs);
			changed = true;
		}
	}
	if (!changed) return;
	fl.state.folders = folders;
	persist(fl);
	publishFolders(fl, ctx);
}

/** K1b: after the session moved to another checkout of the same projects, added folders move to the matching checkouts next to the working folder. */
export async function followWorkingFolder(fl: Flow, ctx: ExtensionContext): Promise<void> {
	const folders = fl.state.folders ?? [];
	if (!folders.length) return;
	const newest = ctx.sessionManager
		.getBranch()
		.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === FOLDERS_ENTRY)
		.pop() as { data?: { cwd?: unknown } } | undefined;
	const prev = newest?.data?.cwd;
	if (typeof prev !== "string" || repoKey(prev) === repoKey(ctx.cwd)) return;
	const top = await gitRoot(fl, ctx.cwd);
	if (!top) return;
	const infos = new Map<string, { top: string; worktrees: string[] }>();
	for (const f of folders) {
		const t = await gitRoot(fl, f);
		if (!t) continue;
		const r = await git(fl, t, "worktree", "list", "--porcelain");
		if (r.code === 0) infos.set(repoKey(f), { top: t, worktrees: parseWorktreeList(r.stdout) });
	}
	const res = followFolders(folders, ctx.cwd.replace(/\\/g, "/"), top, (f) => infos.get(repoKey(f)) ?? null, (p) => fs.existsSync(p));
	if (!res.changes.length && res.folders.length === folders.length) return;
	fl.state.folders = res.folders;
	persist(fl);
	for (const c of res.changes) ctx.ui.notify(`workflow: added folders follow the working folder: ${c.from} \u2192 ${c.to}`, "info");
}
