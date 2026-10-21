/**
 * Answer to the workflow's `workflow:folder-add` event (K6): inside a set, a git folder that `/folders add`
 * is about to attach is replaced by the repo's worktree in the set (reused, or created on the set's branch).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WtConfig } from "./config.ts";
import { setupFiles } from "./files.ts";
import { createAll, excludeLinks, mainRepoOf, preflight, rollback, type Git, type Planned } from "./git-ops.ts";
import { branchOf } from "./layout.ts";
import { readMeta, writeMeta } from "./meta.ts";
import type { Progress } from "./progress.ts";

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const fold = (p: string) => (process.platform === "win32" ? slash(p).toLowerCase() : slash(p));
const inside = (p: string, root: string) => fold(p) === fold(root) || fold(p).startsWith(`${fold(root)}/`);

/** Create the worktrees and their files; on any failure undo what this run created. */
export async function build(git: Git, plan: Planned[], cfg: WtConfig, name: string, progress: Progress): Promise<string[]> {
	const created: Planned[] = [];
	const lines: string[] = [];
	try {
		progress.stage("creating worktrees");
		await createAll(git, plan, branchOf(cfg, name), (p) => created.push(p));
		for (const p of plan) {
			progress.stage(`linking/copying files: ${path.basename(p.info.top)}`);
			const f = setupFiles(p.info.top, p.target, cfg);
			await excludeLinks(git, p.target, f.linked);
			lines.push(`${p.info.top} -> ${p.target}`);
			if (f.linked.length) lines.push(`  linked: ${f.linked.join(", ")}`);
			if (f.copied.length) lines.push(`  copied: ${f.copied.join(", ")}`);
			for (const w of f.warnings) lines.push(`  warning: ${w}`);
		}
		return lines;
	} catch (e) {
		const problems = await rollback(git, created, cfg, name);
		const extra = problems.length ? `\nRollback left problems:\n${problems.join("\n")}` : "\nNothing was left behind.";
		throw new Error(`${(e as Error).message}${extra}`);
	}
}

/** Resolved real path (symlinks, junctions); the input when it cannot be resolved. */
function real(p: string): string {
	try {
		return slash(fs.realpathSync.native(p));
	} catch {
		return slash(p);
	}
}

/** `root/rel` when that exists on disk, otherwise `root`. */
function within(root: string, rel: string): string {
	if (!rel || rel.startsWith("..")) return root;
	const p = `${slash(root)}/${rel}`;
	return fs.existsSync(p) ? p : slash(root);
}

/** Add the repo to `.pi-set.json` when the set has one and no entry with that folder name. */
function recordRepo(setRoot: string, main: string, target: string): void {
	const meta = readMeta(setRoot);
	const dir = path.basename(target);
	if (meta && !meta.repos.some((r) => r.dir === dir)) {
		meta.repos.push({ main, dir });
		writeMeta(setRoot, meta);
	}
}

/** The worktree of `folder`'s repo in the set; null when `folder` is not a git folder or is already in the set. */
export async function worktreeForFolder(
	git: Git,
	o: { cfg: WtConfig; setRoot: string; folder: string },
	progress: Progress,
): Promise<{ folder: string; lines: string[] } | { error: string } | null> {
	const { cfg } = o;
	const setRoot = real(o.setRoot);
	const folder = real(o.folder);
	const name = path.basename(setRoot);
	const t = await git(folder, ["rev-parse", "--show-toplevel"]);
	if (t.code !== 0) return null;
	const top = real(t.stdout.trim());
	if (inside(top, setRoot)) return null;
	const main = (await mainRepoOf(git, top)) ?? top;
	const rel = slash(path.relative(top, folder));

	const list = await git(main, ["worktree", "list", "--porcelain"]);
	for (const l of list.code === 0 ? list.stdout.split(/\r?\n/) : []) {
		if (!l.startsWith("worktree ")) continue;
		const wt = real(l.slice("worktree ".length).trim());
		if (inside(wt, setRoot) && fold(wt) !== fold(setRoot) && fs.existsSync(wt)) {
			recordRepo(setRoot, main, wt);
			return { folder: within(wt, rel), lines: [`reusing worktree ${wt}`] };
		}
	}

	progress.stage("checking repo (fetching)");
	const pre = await preflight(git, [main], cfg, name);
	if (pre.errors.length) return { error: `Nothing created:\n${pre.errors.join("\n")}` };
	const lines = [...pre.warnings];
	try {
		lines.push(...(await build(git, pre.plan, cfg, name, progress)));
	} catch (e) {
		return { error: (e as Error).message };
	}
	const target = slash(pre.plan[0].target);
	recordRepo(setRoot, main, target);
	return { folder: within(target, rel), lines };
}
