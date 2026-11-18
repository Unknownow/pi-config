/**
 * The session's added folders: `/folders`, `--add-dir`, the follow rule, their prompt section, skills and prompts, and the
 * `+N folders` status. The list lives in memory, seeded from the session at start; this is the only writer of the public
 * `session-folders` entry (contract K1), and it appends one only when the list changed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, loadProjectContextFiles, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { followFolders, parseAddDir, parseWorktreeList, repoKey } from "../shared/repos.ts";
import { FOLDERS_ENTRY, foldersEntry, foldersForCwd, newestFolders, sameFolders } from "../shared/session-folders.ts";
import { worktreeForFolder } from "./add-folder.ts";
import { foldersCompletions, foldersDescription, foldersUsage, isKnownFolders } from "./commands.ts";
import type { WtConfig } from "./config.ts";
import { addDirFolders, legacyFolders } from "./folders.ts";
import type { Git } from "./git-ops.ts";
import { Progress } from "./progress.ts";
import { workspaceSection } from "./prompt.ts";

export interface FolderDeps {
	git: () => Git;
	/** The set this session runs in and its config, when `/folders add` should attach the repo's worktree there. */
	set: () => { cfg: WtConfig; setRoot: string } | null;
	/** `addedFolderRules` of the config. */
	rules: () => WtConfig["addedFolderRules"];
}

export interface Folders {
	/** The added folders, absolute with forward slashes, in the order added. */
	list: () => string[];
	/** Seeds the list from the session; on a real start also migrates, follows the working folder and applies `--add-dir`. */
	start: (reason: string, ctx: ExtensionContext) => Promise<void>;
}

const slash = (p: string) => p.replace(/\\/g, "/");

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function newestCwd(entries: readonly unknown[]): string | undefined | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: { cwd?: unknown } } | null;
		if (e?.type === "custom" && e.customType === FOLDERS_ENTRY) return typeof e.data?.cwd === "string" ? e.data.cwd : undefined;
	}
	return null;
}

export function registerFolders(pi: ExtensionAPI, deps: FolderDeps): Folders {
	let folders: string[] = [];
	let lastCwd = process.cwd();

	const existing = () => folders.filter(isDir);
	const gitRoot = async (dir: string): Promise<string | null> => {
		if (!fs.existsSync(dir)) return null;
		const r = await deps.git()(dir, ["rev-parse", "--show-toplevel"]);
		return r.code === 0 && r.stdout.trim() ? slash(r.stdout.trim()) : null;
	};
	const showStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const n = existing().length;
		ctx.ui.setStatus("workspace-folders", n ? `+${n} folder${n === 1 ? "" : "s"}` : undefined);
	};
	/** Keeps `next` and appends a `session-folders` entry when it differs from the session's newest one for this working folder. */
	const save = (ctx: ExtensionContext, next: string[]) => {
		folders = [...next];
		if (!sameFolders(foldersForCwd(ctx.sessionManager.getBranch(), ctx.cwd), folders)) pi.appendEntry(FOLDERS_ENTRY, foldersEntry(ctx.cwd, folders));
		showStatus(ctx);
	};

	/** K1b: after the session moved to another checkout of the same projects, added folders move to the matching checkouts next to the working folder. */
	const follow = async (ctx: ExtensionContext, list: string[]): Promise<string[]> => {
		const top = await gitRoot(ctx.cwd);
		if (!top || !list.length) return list;
		const infos = new Map<string, { top: string; worktrees: string[] }>();
		for (const f of list) {
			const t = await gitRoot(f);
			if (!t) continue;
			const r = await deps.git()(t, ["worktree", "list", "--porcelain"]);
			if (r.code === 0) infos.set(repoKey(f), { top: t, worktrees: parseWorktreeList(r.stdout) });
		}
		const res = followFolders(list, slash(ctx.cwd), top, (f) => infos.get(repoKey(f)) ?? null, (p) => fs.existsSync(p));
		for (const c of res.changes) ctx.ui.notify(`workspace: added folders follow the working folder: ${c.from} → ${c.to}`, "info");
		return res.folders;
	};

	pi.registerFlag("add-dir", {
		description: "Extra folders for this session, separated by ; on Windows and : elsewhere",
		type: "string",
	});

	pi.registerCommand("folders", {
		description: foldersDescription(),
		getArgumentCompletions: (prefix) =>
			foldersCompletions(prefix, {
				cwd: lastCwd,
				home: os.homedir(),
				readDirs: (dir) => {
					try {
						return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
					} catch {
						return null;
					}
				},
				folders,
			}),
		handler: async (args, ctx) => {
			lastCwd = ctx.cwd;
			const m = args.trim().match(/^(\S+)\s*([\s\S]*)$/);
			const sub = (m?.[1] ?? "list").toLowerCase();
			const arg = (m?.[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
			if (sub === "list") {
				const lines = [`working folder  ${ctx.cwd}`];
				for (const [i, f] of folders.entries()) {
					const note = !fs.existsSync(f) ? " (missing)" : (await gitRoot(f)) ? "" : " (not a git repo)";
					lines.push(`${i + 1}. ${f}${note}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (!isKnownFolders(sub)) return ctx.ui.notify(foldersUsage(), "warning");
			if (!arg) return ctx.ui.notify(`Usage: /folders ${sub} ${sub === "remove" ? "PATH or N" : "PATH"}`, "warning");
			if (sub === "add") {
				const abs = slash(path.resolve(ctx.cwd, arg));
				if (!isDir(abs)) return ctx.ui.notify(`workspace: ${abs} is not a folder`, "warning");
				if (repoKey(abs) === repoKey(ctx.cwd)) return ctx.ui.notify("workspace: that is already the working folder", "warning");
				if (folders.some((f) => repoKey(f) === repoKey(abs))) return ctx.ui.notify(`workspace: ${abs} is already added`, "warning");
				let final = abs;
				const inSet = deps.set();
				if (inSet && inSet.cfg.addFolderWorktree) {
					// Inside a set, a repo is attached as its worktree in the set (created on the set's branch when missing).
					const progress = new Progress(ctx.hasUI ? ctx.ui : null, `worktree add (${path.basename(inSet.setRoot)})`, truncateToWidth);
					let res: Awaited<ReturnType<typeof worktreeForFolder>>;
					try {
						res = await worktreeForFolder(progress.wrap(deps.git()), { cfg: inSet.cfg, setRoot: inSet.setRoot, folder: abs }, progress);
					} catch (e) {
						res = { error: (e as Error).message };
					} finally {
						progress.done();
					}
					if (res && "error" in res) return ctx.ui.notify(`workspace: ${abs} not added: ${res.error}`, "error");
					if (res) {
						ctx.ui.notify([`Worktree ready in set "${path.basename(inSet.setRoot)}": ${res.folder}`, ...res.lines].join("\n"), "info");
						final = slash(path.resolve(ctx.cwd, res.folder));
						if (!isDir(final)) return ctx.ui.notify(`workspace: ${final} is not a folder`, "warning");
						if (repoKey(final) === repoKey(ctx.cwd)) return ctx.ui.notify("workspace: that is already the working folder", "warning");
						if (folders.some((f) => repoKey(f) === repoKey(final))) return ctx.ui.notify(`workspace: ${final} is already added`, "warning");
					}
				}
				save(ctx, [...folders, final]);
				ctx.ui.notify(final === abs ? `workspace: added ${abs}; reloading` : `workspace: added ${final} (for ${abs}); reloading`, "info");
			} else {
				const n = /^\d+$/.test(arg) ? Number(arg) - 1 : -1;
				const i = n >= 0 ? n : folders.findIndex((f) => repoKey(f) === repoKey(path.resolve(ctx.cwd, arg)));
				if (i < 0 || i >= folders.length) return ctx.ui.notify(`workspace: ${arg} is not in the folder list`, "warning");
				const gone = folders[i];
				save(ctx, folders.filter((_, j) => j !== i));
				ctx.ui.notify(`workspace: removed ${gone}; reloading`, "info");
			}
			// Skills and prompts of the folders are found on reload.
			await ctx.waitForIdle();
			await ctx.reload();
		},
	});

	// A section deleted and re-added moves to the end in pi's patch replay, so it is set on every turn, also without added folders.
	pi.on("before_agent_start", async (event, ctx) => {
		lastCwd = ctx.cwd;
		const list = existing();
		const opts = event.systemPromptOptions;
		const listed: { path: string; size: number }[] = [];
		if (list.length) {
			const have = new Set(opts.contextFiles.map((f) => repoKey(f.path)));
			const full = deps.rules() === "full";
			for (const folder of list) {
				try {
					for (const f of loadProjectContextFiles({ cwd: folder, agentDir: getAgentDir() })) {
						if (have.has(repoKey(f.path))) continue;
						have.add(repoKey(f.path));
						if (full) opts.contextFiles.push(f);
						else listed.push({ path: f.path, size: f.content.length });
					}
				} catch {
					// an unreadable folder just adds no context files
				}
			}
		}
		opts.sections.workspace = workspaceSection(ctx.cwd, list, listed);
	});

	// Skills and prompts of the added folders (session_start runs before this, also on reload).
	pi.on("resources_discover", async () => {
		const skillPaths: string[] = [];
		const promptPaths: string[] = [];
		for (const f of existing()) {
			for (const d of [path.join(f, ".pi", "skills"), path.join(f, ".agents", "skills")]) if (fs.existsSync(d)) skillPaths.push(d);
			const dir = path.join(f, ".pi", "prompts");
			if (fs.existsSync(dir)) promptPaths.push(dir);
		}
		return { skillPaths, promptPaths };
	});

	return {
		list: () => [...folders],
		start: async (reason, ctx) => {
			lastCwd = ctx.cwd;
			const branch = ctx.sessionManager.getBranch();
			let list = foldersForCwd(branch, ctx.cwd);
			if (reason !== "reload") {
				const prev = newestCwd(branch);
				// A session from before workspace owned the list: take the workflow's copy once.
				if (prev === null) list = legacyFolders(branch);
				else if (typeof prev === "string" && repoKey(prev) !== repoKey(ctx.cwd)) list = await follow(ctx, newestFolders(branch));
				// --add-dir is a launch flag: the first session of the process and a new one take it, not a resume or a switch.
				if (reason === "startup" || reason === "new") {
					const r = addDirFolders(list, parseAddDir(pi.getFlag("add-dir")), ctx.cwd, isDir);
					for (const note of r.notes) ctx.ui.notify(note, "warning");
					list = r.folders;
				}
			}
			save(ctx, list);
		},
	};
}
