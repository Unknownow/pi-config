/**
 * /wt: run several pi sessions on the same repos without copying them. `/wt new <name>` makes a git
 * worktree for the working repo and every added folder, links or copies the gitignored files, and opens
 * a new terminal window (or VS Code terminal) running pi there. `/wt open <name>` reopens a set, `/wt done` moves the session home and removes its set, `/wt clean` removes everything that is safe to remove.
 * `/wt update` fast-forwards a set to its base branches; a session inside a set does that at startup. See README.md.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION, getAgentDir, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LINK, loadConfig, type WtConfig } from "./config.ts";
import { isLink, setupFiles, unlinkLink } from "./files.ts";
import { foldersFromEntries } from "./folders.ts";
import { footerText, pidAlive, readLive, removeLive, setInUse, writeLive, type LiveEntry } from "./live.ts";
import { readMeta, writeMeta } from "./meta.ts";
import { latestSession, newSessionFile } from "./sessions.ts";
import { sharedProblem } from "./shared-guard.ts";
import { sendToVscode } from "./vscode-bridge.ts";
import { createAll, excludeLinks, mainRepoOf, preflight, rollback, withLockRetry, type Gh, type Git, type Planned } from "./git-ops.ts";
import { SWEEP_SCRIPT, classifySet, detectSession, listSets, listText, openPlan, parseEditors, quitReminder, removeWithConfirm, repoDirsIn, reposOf, sessionConfig, worktreePrompt, type WorkspaceEnv, type WtSession } from "./manage.ts";
import { cleanFlow, deleteRemotes, discoverMains, fetchAll, planClean, remoteCandidates } from "./clean.ts";
import { guardProblem } from "./unity-guard.ts";
import { renameSet } from "./rename.ts";
import { reattach, updateSet, worthNotifying } from "./update.ts";
import { execRunner } from "./exec.ts";
import { Progress } from "./progress.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { branchOf, checkName, launchSpec, nextFreeName, rootProblem, setRootOf, vscodeTerminalSpec } from "./layout.ts";

const SUBCOMMANDS = ["new", "open", "use", "list", "update", "remove", "rename", "clean", "done", "unlink"];

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const fold = (p: string) => (process.platform === "win32" ? slash(p).toLowerCase() : slash(p));
const liveDir = () => path.join(getAgentDir(), "live");
const sessionsInUse = () => readLive(liveDir(), Date.now(), pidAlive);

function makeGh(pi: ExtensionAPI): Gh {
	return async (cwd, args) => {
		try {
			const r = await pi.exec("gh", args, { cwd, timeout: 20000 });
			return { code: r.code, stdout: r.stdout, stderr: r.stderr };
		} catch (e) {
			return { code: 1, stdout: "", stderr: (e as Error).message };
		}
	};
}

function makeGit(pi: ExtensionAPI, timeout = 60000): Git {
	return withLockRetry(async (cwd, args) => {
		const r = await pi.exec("git", args, { cwd, timeout });
		return { code: r.code, stdout: r.stdout, stderr: r.stderr };
	});
}

/** A header-only session file for a new pi session that starts in `cwd`. */
function freshSessionFile(cwd: string): string {
	return newSessionFile(cwd, {
		create: (c) => {
			const m = SessionManager.create(c);
			return { file: m.getSessionFile(), id: m.getSessionId(), dir: m.getSessionDir() };
		},
		version: CURRENT_SESSION_VERSION,
	});
}

/** Where a launched pi process runs: the original repo of the session's worktree, so no process holds a workspace folder. */
async function launchCwdOf(git: Git, cfg: WtConfig, sessionCwd: string): Promise<string> {
	const top = await git(sessionCwd, ["rev-parse", "--show-toplevel"]);
	const main = top.code === 0 ? await mainRepoOf(git, slash(top.stdout.trim())) : null;
	return main ?? cfg.root;
}

/** The folders added to this session, from the workflow's public `session-folders` entry (absolute, forward slashes). */
function addedFolders(ctx: ExtensionCommandContext): string[] {
	return foldersFromEntries(ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]);
}

/** `existsSync` is false for app execution aliases such as wt.exe; `lstat` sees them. */
function isFile(f: string): boolean {
	try {
		fs.lstatSync(f);
		return true;
	} catch {
		return false;
	}
}

function findWt(): string | null {
	if (process.platform !== "win32") return null;
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
	for (const d of dirs) {
		const f = path.join(d, "wt.exe");
		if (isFile(f)) return f;
	}
	return null;
}

function piCommandOf(cfg: WtConfig): string {
	if (cfg.piCommand) return cfg.piCommand;
	const bundled = path.join(getAgentDir(), "bin", "pi.cmd");
	return process.platform === "win32" && fs.existsSync(bundled) ? slash(bundled) : "pi";
}

interface Collected {
	/** Git roots to put in worktrees; the first is the working repo. */
	repos: string[];
	/** Every folder of the new session in order: a repo root (to be replaced by its worktree) or a plain folder. */
	order: string[];
	workingTop: string;
}

/** Split the working folder and added folders into git repos and plain folders. */
async function collect(git: Git, ctx: ExtensionCommandContext): Promise<Collected | string> {
	const top = async (d: string) => {
		const r = await git(d, ["rev-parse", "--show-toplevel"]);
		return r.code === 0 ? slash(r.stdout.trim()) : null;
	};
	const workingTop = await top(ctx.cwd);
	if (!workingTop) return "run /wt new from a git repo";
	const repos = [workingTop];
	const order: string[] = [];
	for (const f of addedFolders(ctx)) {
		const t = await top(f);
		const entry = t ?? f;
		if (t && !repos.includes(t)) repos.push(t);
		if (entry !== workingTop && !order.includes(entry)) order.push(entry);
	}
	return { repos, order, workingTop };
}

/** Start pi on `sessionFile` in a new terminal. The process runs in `cwd`; pi moves to the session's own folder (`shown`). */
async function launch(cfg: WtConfig, name: string, cwd: string, shown: string, folders: string[], sessionFile: string): Promise<{ text: string; error?: string }> {
	const opts = {
		platform: process.platform,
		launch: cfg.launch,
		wtPath: findWt(),
		piCommand: piCommandOf(cfg),
		cwd,
		name,
		folders,
		sessionFile,
	};
	const bridgeAllowed = cfg.vscode && cfg.launch !== "none";
	const pipe = process.env.PI_VSCODE_TERMINAL;
	let note = "";
	let hint = "";
	if (bridgeAllowed && pipe) {
		const err = await sendToVscode(pipe, vscodeTerminalSpec(opts));
		if (err === null) return { text: `Opened a new VS Code terminal running pi in ${shown}` };
		note = `VS Code terminal failed (${err}), used the fallback. `;
	} else if (bridgeAllowed && process.env.TERM_PROGRAM === "vscode") {
		hint = " (install the pi-terminal-bridge VS Code extension, or open a new VS Code terminal, to get a VS Code terminal instead; see README)";
	}
	const spec = launchSpec(opts);
	if ("print" in spec) return { text: `${note}Start it with: ${spec.print}${hint}` };
	const env = { ...process.env };
	delete env.PI_VSCODE_TERMINAL;
	delete env.TERM_PROGRAM;
	const child = spawn(spec.file, spec.args, { detached: true, stdio: "ignore", cwd, env });
	const failure = await new Promise<string | null>((resolve) => {
		child.once("error", (e) => resolve(e.message));
		child.once("spawn", () => resolve(null));
	});
	if (failure) return { text: "", error: `${note}could not open the terminal (${spec.file}): ${failure}` };
	child.unref();
	return { text: `${note}Opened a new ${cfg.launch === "tab" ? "tab" : "window"} running pi in ${shown}${hint}` };
}

/** Create the worktrees and their files; on any failure undo what this run created. */
async function build(git: Git, plan: Planned[], cfg: WtConfig, name: string, progress: Progress): Promise<string[]> {
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

interface Created {
	cfg: WtConfig;
	name: string;
	/** The session folder in the new set (the working repo's worktree plus the current subfolder). */
	cwd: string;
	/** The worktree root of the working repo. */
	workingTarget: string;
	/** The other repos and plain folders of the new session. */
	folders: string[];
	lines: string[];
	/** The original working repo. */
	workingTop: string;
	setRoot: string;
}

/** The next free `w<N>`: no set folder and no such branch in any of the repos. */
async function suggestName(git: Git, cfg: WtConfig, repos: string[]): Promise<string> {
	return nextFreeName(listSets(cfg), async (n) => {
		for (const r of repos) if ((await git(r, ["rev-parse", "--verify", "--quiet", `refs/heads/${branchOf(cfg, n)}`])).code === 0) return true;
		return false;
	});
}

/** Create a set for the working repo and the added folders (no terminal, no session). Reports problems itself and returns null. */
async function createSet(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<Created | null> {
	const fail = (m: string) => {
		ctx.ui.notify(m, "error");
		return null;
	};
	const git = progress.wrap(makeGit(pi));
	progress.stage("checking repos (fetching)");
	const found = await collect(git, ctx);
	if (typeof found === "string") return fail(found);
	const loaded = await sessionConfig(git, getAgentDir(), found.workingTop);
	const cfg = loaded.cfg;
	if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
	const rootBad = rootProblem(cfg.root);
	if (rootBad) return fail(rootBad);
	if (!name) {
		const suggested = await suggestName(git, cfg, found.repos);
		if (ctx.hasUI) {
			const typed = await progress.pause(() => ctx.ui.input(`Name for the new workspace (Enter = ${suggested})`, suggested));
			if (typed === undefined) {
				ctx.ui.notify("Cancelled.", "info");
				return null;
			}
			name = typed.trim() || suggested;
		} else name = suggested;
	}
	const bad = checkName(name);
	if (bad) return fail(bad);

	const pre = await preflight(git, found.repos, cfg, name);
	for (const w of pre.warnings) ctx.ui.notify(w, "warning");
	if (pre.errors.length) return fail(`Nothing created:\n${pre.errors.join("\n")}`);

	let lines: string[];
	try {
		lines = await build(git, pre.plan, cfg, name, progress);
	} catch (e) {
		return fail((e as Error).message);
	}
	const mains = new Map<string, string>();
	for (const p of pre.plan) mains.set(p.info.top, (await mainRepoOf(git, p.info.top)) ?? p.info.top);
	writeMeta(setRootOf(cfg, name), {
		v: 1,
		created: new Date().toISOString(),
		branch: branchOf(cfg, name),
		repos: pre.plan.map((p) => ({ main: mains.get(p.info.top) ?? p.info.top, dir: path.basename(p.target) })),
	});
	const targetOf = (top: string) => pre.plan.find((p) => p.info.top === top)?.target ?? top;
	const rel = path.relative(found.workingTop, ctx.cwd).replace(/\\/g, "/");
	const cwd = rel && !rel.startsWith("..") ? `${targetOf(found.workingTop)}/${rel}` : targetOf(found.workingTop);
	return { cfg, name, cwd, workingTarget: targetOf(found.workingTop), folders: found.order.map(targetOf), lines, workingTop: found.workingTop, setRoot: setRootOf(cfg, name) };
}

async function newSet(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<void> {
	const c = await createSet(pi, ctx, name, progress);
	if (!c) return;
	name = c.name;
	progress.stage("opening terminal");
	const git = makeGit(pi);
	const l = await launch(c.cfg, name, await launchCwdOf(git, c.cfg, c.workingTop), c.cwd, c.folders, freshSessionFile(c.cwd));
	const head = `Worktree set "${name}" (branch ${branchOf(c.cfg, name)}) in ${c.setRoot}`;
	ctx.ui.notify([head, ...c.lines, l.error ?? l.text].join("\n"), l.error ? "warning" : "info");
}

/** `/wt rename [OLD] [NEW]`: rename an unused, unpushed workspace. */
async function renameCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, oldName: string, newName: string, progress: Progress, own: WtSession | null): Promise<void> {
	const cfg = await configFor(pi, ctx);
	const git = progress.wrap(makeGit(pi));
	if (!oldName) {
		const picked = await pickSet(ctx, cfg, "Rename which workspace?", progress);
		if (!picked) return;
		oldName = picked;
	}
	if (!newName) {
		const repos = reposOf(cfg, oldName);
		const suggested = await suggestName(git, cfg, repos);
		if (!ctx.hasUI) return ctx.ui.notify(`give a new name: /wt rename ${oldName} ${suggested}`, "error");
		const typed = await progress.pause(() => ctx.ui.input(`New name for ${oldName} (Enter = ${suggested})`, suggested));
		if (typed === undefined) return ctx.ui.notify("Cancelled.", "info");
		newName = typed.trim() || suggested;
	}
	const mine = own ? fold(own.setRoot) : null;
	const live = sessionsInUse();
	progress.stage("asking Unity for open editors");
	const editors = await progress.track("unity status", ctx.cwd, unityEditors(pi));
	const r = await renameSet(
		{
			git,
			cfg,
			inUse: (root) => {
				if (mine && fold(root) === mine) return "this session's workspace";
				const h = setInUse(live, root, process.pid);
				if (h) return `in use by pi ${h.pid}`;
				return editors?.some((e) => fold(e) === fold(root) || fold(e).startsWith(`${fold(root)}/`)) ? "open in a Unity Editor" : null;
			},
		},
		oldName,
		newName,
	);
	ctx.ui.notify(r.text, r.error ? "error" : "info");
}

/** The config as /wt new sees it: the default root sits next to the working repo. */
async function configFor(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<WtConfig> {
	const { cfg, warning, parent } = await sessionConfig(makeGit(pi), getAgentDir(), ctx.cwd);
	cachedParent = parent;
	if (warning) ctx.ui.notify(warning, "warning");
	return cfg;
}

let cachedParent: string | null = null;

/** Config for tab completion: no git call, uses the parent folder cached from the session. */
function completionConfig(): WtConfig {
	return loadConfig(getAgentDir(), cachedParent ?? path.dirname(slash(process.cwd()))).cfg;
}

async function unityEditors(pi: ExtensionAPI): Promise<string[] | null> {
	try {
		const r = await pi.exec("unity", ["status", "--format", "json"], { timeout: 10000 });
		return r.code === 0 ? parseEditors(r.stdout) : null;
	} catch {
		return null;
	}
}

async function listCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, progress: Progress): Promise<void> {
	const cfg = await configFor(pi, ctx);
	progress.stage("asking Unity for open editors");
	const editors = await progress.track("unity status", ctx.cwd, unityEditors(pi));
	progress.stage("reading repo status");
	const git = progress.wrap(makeGit(pi));
	const env = workspaceEnv(makeGh(pi), ctx, cfg, git, editors);
	const notes = new Map<string, string>();
	for (const name of listSets(cfg).filter((n) => !checkName(n))) {
		const st = await classifySet(env, name);
		notes.set(name, `${st.kind}: ${st.reason}`);
	}
	ctx.ui.notify(await listText(git, cfg, editors, (name) => notes.get(name) ?? "unknown"), "info");
}

async function pickSet(ctx: ExtensionCommandContext, cfg: WtConfig, title: string, progress: Progress): Promise<string | null> {
	const sets = listSets(cfg);
	if (!sets.length) {
		ctx.ui.notify(`no worktree sets in ${cfg.root}`, "error");
		return null;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify(`give a name; sets: ${sets.join(", ")}`, "error");
		return null;
	}
	return (await progress.pause(() => ctx.ui.select(title, sets))) ?? null;
}

/** git and gh for one command. After `ctx.switchSession()` the captured `pi` is stale, so that path uses `directRun`. */
interface Run {
	git: Git;
	gh: Gh;
}
const piRun = (pi: ExtensionAPI): Run => ({ git: makeGit(pi), gh: makeGh(pi) });
const directRun = (): Run => ({ git: withLockRetry(execRunner("git", 60000)), gh: execRunner("gh", 20000) });

/** What the removal engine needs in this session: who uses a set (also this session itself), and the open Unity Editors. */
function workspaceEnv(gh: Gh, ctx: ExtensionCommandContext, cfg: WtConfig, git: Git, editors: string[] | null): WorkspaceEnv {
	const mine = [ctx.cwd, ...addedFolders(ctx)];
	return {
		git,
		gh,
		cfg,
		editors,
		inUse: (setRoot) => {
			if (mine.some((p) => fold(p) === fold(setRoot) || fold(p).startsWith(`${fold(setRoot)}/`))) return "in use by this session";
			const holder = setInUse(sessionsInUse(), setRoot, process.pid);
			return holder ? `in use by pi ${holder.pid}` : null;
		},
	};
}

/** Deletes leftover folders after pi exits (a Windows folder that was in use when git removed the worktree). */
function startSweep(ctx: ExtensionCommandContext, cfg: WtConfig, leftovers: string[]): void {
	if (!leftovers.length) return;
	try {
		const p = spawn(process.execPath, ["-e", SWEEP_SCRIPT, "120", "1000", ...leftovers], { detached: true, stdio: "ignore", cwd: cfg.root, windowsHide: true });
		p.on("error", () => {});
		p.unref();
	} catch (e) {
		ctx.ui.notify(`Could not start the cleanup of leftover folders: ${(e as Error).message}`, "warning");
	}
}

/** `removeWithConfirm` with this session's dialogs; starts the sweeper for folders that were in use. */
async function removeFlow(run: Run, ctx: ExtensionCommandContext, cfg: WtConfig, name: string, progress: Progress, editors: string[] | null) {
	const git = progress.wrap(run.git);
	const env = {
		...workspaceEnv(run.gh, ctx, cfg, git, editors),
		hasUI: ctx.hasUI,
		confirm: (title: string, message: string) => progress.pause(() => ctx.ui.confirm(title, message)),
		stage: (text: string) => progress.stage(text),
		now: () => new Date(),
	};
	const r = await removeWithConfirm(env, name);
	startSweep(ctx, cfg, r.leftovers);
	return r;
}

async function removeCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<void> {
	const cfg = await configFor(pi, ctx);
	if (!name) {
		const picked = await pickSet(ctx, cfg, "Remove which worktree set?", progress);
		if (!picked) return;
		name = picked;
	}
	progress.stage("asking Unity for open editors");
	const editors = await progress.track("unity status", ctx.cwd, unityEditors(pi));
	const r = await removeFlow(piRun(pi), ctx, cfg, name, progress, editors);
	ctx.ui.notify(r.text, r.error ? "error" : "info");
}

/** `/wt clean`: remove every delivered set, stale entry, merged branch and expired backup; ask before deleting remote branches. */
async function cleanCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, progress: Progress): Promise<void> {
	const cfg = await configFor(pi, ctx);
	const git = progress.wrap(makeGit(pi));
	progress.stage("finding the original repos");
	const tops: string[] = [];
	for (const dir of [ctx.cwd, ...addedFolders(ctx)]) {
		const t = await git(dir, ["rev-parse", "--show-toplevel"]);
		if (t.code === 0 && t.stdout.trim()) tops.push(slash(t.stdout.trim()));
	}
	const mains = await discoverMains(git, cfg, tops);
	progress.stage(`fetching ${mains.length} repo(s)`);
	const warnings = await fetchAll(git, mains);
	const editors = await progress.track("unity status", ctx.cwd, unityEditors(pi));
	progress.stage("checking the worktree sets");
	const env = { ...workspaceEnv(makeGh(pi), ctx, cfg, git, editors), now: new Date() };
	const plan = await planClean(env, mains);
	const flow = await cleanFlow({ git, cfg, inUse: env.inUse }, plan, warnings, {
		hasUI: ctx.hasUI,
		confirm: (title, message) => progress.pause(() => ctx.ui.confirm(title, message)),
		stage: (text) => progress.stage(text),
	});
	if (flow.status === "no-ui" || flow.status === "cancelled") return ctx.ui.notify(flow.text, "info");
	startSweep(ctx, cfg, flow.leftovers);
	const report = (head: string, items: string[]) => (items.length ? [head, ...items.map((i) => `  ${i}`)] : []);
	const out: string[] = [flow.text];
	if (ctx.hasUI) {
		progress.stage("looking for merged remote branches");
		const remote = await remoteCandidates(env, mains);
		if (remote.length) {
			const names = remote.map((r) => `origin/${r.branch} (${path.basename(r.main)})`);
			const ok = await progress.pause(() => ctx.ui.confirm(`Also delete ${remote.length} remote branch(es)?`, names.join("\n")));
			if (ok) {
				const res = await deleteRemotes(git, remote);
				out.push(...report("Remote branches deleted:", res.done), ...report("Remote branches failed:", res.failed));
			} else {
				out.push(...report("Remote branches kept:", names));
			}
		}
	}
	progress.done();
	ctx.ui.notify(out.join("\n"), "info");
}

async function openCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<void> {
	const cfg = await configFor(pi, ctx);
	if (!name) {
		const picked = await pickSet(ctx, cfg, "Open which worktree set?", progress);
		if (!picked) return;
		name = picked;
	}
	const holder = setInUse(sessionsInUse(), setRootOf(cfg, name), process.pid);
	if (holder) return ctx.ui.notify(`${name} is in use by pi ${holder.pid}`, "error");
	progress.stage("finding the set");
	const git = progress.wrap(makeGit(pi));
	const t = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	const preferred = t.code === 0 && t.stdout.trim() ? path.basename(slash(t.stdout.trim())) : null;
	let p = openPlan(cfg, name, preferred);
	if ("error" in p) return ctx.ui.notify(p.error, "error");
	if ("choose" in p) {
		if (!ctx.hasUI) return ctx.ui.notify(`set "${name}" has several repos (${p.choose.join(", ")}); run /wt open from one of them or with a UI`, "error");
		const picked = await progress.pause(() => ctx.ui.select(`Working repo for "${name}"`, p.choose));
		if (picked === undefined) return ctx.ui.notify("Cancelled.", "info");
		p = openPlan(cfg, name, picked);
		if (!("cwd" in p)) return ctx.ui.notify("error" in p ? p.error : "could not choose a repo", "error");
	}
	const fold = (s: string) => (process.platform === "win32" ? slash(s).toLowerCase() : slash(s));
	const cur = await detectSession(git, cfg, ctx.cwd);
	if (cur && fold(cur.setRoot) === fold(setRootOf(cfg, name))) return ctx.ui.notify(`this session already runs in worktree set "${name}"`, "error");
	progress.stage("opening terminal");
	let list: { path: string; modified: Date }[] = [];
	try {
		list = await SessionManager.list(p.cwd);
	} catch {}
	const created = Date.parse(readMeta(setRootOf(cfg, name))?.created ?? "");
	const file = latestSession(list, Number.isNaN(created) ? 0 : created) ?? freshSessionFile(p.cwd);
	const l = await launch(cfg, name, await launchCwdOf(git, cfg, p.cwd), p.cwd, p.folders, file);
	ctx.ui.notify([`Reopening worktree set "${name}" in ${setRootOf(cfg, name)}`, l.error ?? l.text].join("\n"), l.error ? "warning" : "info");
}

/** `/wt update [NAME]`: without NAME, the set this session runs in (or pick one). Uncommitted changes are allowed; git refuses if they would be overwritten. */
async function updateCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<void> {
	const cfg = await configFor(pi, ctx);
	const git = progress.wrap(makeGit(pi));
	if (!name) {
		const cur = await detectSession(git, cfg, ctx.cwd);
		const picked = cur ? path.basename(cur.setRoot) : await pickSet(ctx, cfg, "Update which worktree set?", progress);
		if (!picked) return;
		name = picked;
	}
	const bad = checkName(name);
	if (bad) return ctx.ui.notify(bad, "error");
	const wts = repoDirsIn(setRootOf(cfg, name));
	if (!wts.length) return ctx.ui.notify(`no worktree set "${name}" in ${cfg.root}`, "error");
	progress.stage(`updating ${name}`);
	const res = await updateSet(git, wts, { allowDirty: true, rebase: true, branch: branchOf(cfg, name), gh: makeGh(pi) });
	const failed = res.some((r) => r.state === "failed");
	ctx.ui.notify([`Worktree set "${name}":`, ...res.map((r) => `  ${r.text}`)].join("\n"), failed ? "warning" : "info");
}

/** The original folders of this session's worktree: the main repo and the same subfolder in it. */
async function homeOf(git: Git, ctx: ExtensionCommandContext): Promise<{ repoTop: string; targetCwd: string } | string> {
	const top = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return "run this from a git repo";
	const workingTop = slash(top.stdout.trim());
	const main = await mainRepoOf(git, workingTop);
	if (!main) return "could not find the original repo of this worktree";
	const rel = path.relative(workingTop, ctx.cwd).replace(/\\/g, "/");
	const c = rel && !rel.startsWith("..") ? `${main}/${rel}` : main;
	return { repoTop: main, targetCwd: fs.existsSync(c) ? c : main };
}

type UseTarget = { kind: "set"; name: string } | { kind: "original" } | { kind: "new" };

/** Copies this conversation into `mv.targetCwd` and switches to it; `after` runs in the new session. False when the switch was cancelled (a flow is executing). */
async function moveConversation(
	ctx: ExtensionCommandContext,
	mv: { targetCwd: string; label: string; setRepos: string[]; repoTop: string; after?: (nctx: ExtensionCommandContext) => Promise<void> },
	progress: Progress,
): Promise<boolean> {
	const { targetCwd, label, setRepos, repoTop } = mv;
	const cur = ctx.sessionManager.getSessionFile();
	let file: string;
	try {
		file = cur && fs.existsSync(cur) ? (SessionManager.forkFrom(cur, targetCwd).getSessionFile() ?? "") : freshSessionFile(targetCwd);
		if (!file) throw new Error("no session file");
	} catch (e) {
		ctx.ui.notify(`could not copy the conversation: ${(e as Error).message}`, "error");
		return false;
	}
	progress.done();
	const res = await ctx.switchSession(file, {
		withSession: async (nctx) => {
			const folders = foldersFromEntries(nctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]);
			const missing = setRepos.filter((r) => fold(r) !== fold(repoTop) && !folders.some((f) => fold(f) === fold(r))).map((r) => path.basename(r));
			const text = `This conversation moved to ${targetCwd} (${label}). Repo paths now: ${[slash(nctx.cwd), ...folders].join(", ")}. Earlier messages refer to the old paths.`;
			await nctx.sendMessage({
				customType: "worktree-moved",
				display: true,
				content: missing.length ? `${text}\nnot attached: ${missing.join(", ")}; add them with /folders add` : text,
			});
			await mv.after?.(nctx);
		},
	});
	if (res.cancelled) {
		try {
			fs.unlinkSync(file);
		} catch {}
		ctx.ui.notify("move cancelled", "info");
	}
	return !res.cancelled;
}

/** `/wt use [NAME]`: move this conversation into a free workspace, or back to the original folders (`original`). */
async function useCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress, own: WtSession | null): Promise<void> {
	await ctx.waitForIdle();
	const cfg = await configFor(pi, ctx);
	const git = progress.wrap(makeGit(pi));
	const top = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return ctx.ui.notify("run /wt use from a git repo", "error");
	const workingTop = slash(top.stdout.trim());
	const live = sessionsInUse();
	const sets = listSets(cfg).filter((n) => !checkName(n));
	const here = own ? path.basename(slash(own.setRoot)) : null;
	const holderOf = (n: string) => setInUse(live, setRootOf(cfg, n), process.pid);

	let target: UseTarget;
	if (!name) {
		if (!ctx.hasUI) return ctx.ui.notify(`give a name; sets: ${sets.join(", ")}`, "error");
		const choices = new Map<string, UseTarget>();
		for (const n of sets) if (n !== here && !holderOf(n)) choices.set(`${n}  (free, ${reposOf(cfg, n).length} repo${reposOf(cfg, n).length === 1 ? "" : "s"})`, { kind: "set", name: n });
		if (own) choices.set("original folders", { kind: "original" });
		choices.set("+ new workspace", { kind: "new" });
		const picked = await progress.pause(() => ctx.ui.select("Move this conversation to", [...choices.keys()]));
		if (picked === undefined) return;
		target = choices.get(picked) ?? { kind: "new" };
	} else if (name === "original" && !sets.includes(name)) {
		target = { kind: "original" };
	} else {
		if (!sets.includes(name)) return ctx.ui.notify(`no worktree set "${name}" in ${cfg.root}${sets.length ? `; sets: ${sets.join(", ")}` : ""}`, "error");
		target = { kind: "set", name };
	}
	if (target.kind === "original" && !own) return ctx.ui.notify("this session already runs in the original folders", "error");
	if (target.kind === "set") {
		if (target.name === here) return ctx.ui.notify(`this session already runs in ${here}`, "error");
		const holder = holderOf(target.name);
		if (holder) return ctx.ui.notify(`${target.name} is in use by pi ${holder.pid}`, "error");
	}

	const rel = path.relative(workingTop, ctx.cwd).replace(/\\/g, "/");
	const within = (repo: string) => {
		const c = rel && !rel.startsWith("..") ? `${repo}/${rel}` : repo;
		return fs.existsSync(c) ? c : repo;
	};
	let targetCwd: string;
	let label: string;
	let setRepos: string[] = [];
	let repoTop: string;
	if (target.kind === "new") {
		const c = await createSet(pi, ctx, "", progress);
		if (!c) return;
		targetCwd = c.cwd;
		label = c.name;
		setRepos = reposOf(c.cfg, c.name);
		repoTop = c.workingTarget;
	} else if (target.kind === "original") {
		const home = await homeOf(git, ctx);
		if (typeof home === "string") return ctx.ui.notify(home, "error");
		repoTop = home.repoTop;
		targetCwd = home.targetCwd;
		label = "original folders";
	} else {
		const repos = reposOf(cfg, target.name);
		const commonOf = async (d: string) => {
			const r = await git(d, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
			return r.code === 0 ? fold(r.stdout.trim()) : null;
		};
		const mine = await commonOf(workingTop);
		const match: string[] = [];
		for (const r of repos) if (mine && (await commonOf(r)) === mine) match.push(r);
		if (match.length === 1) repoTop = match[0];
		else if (repos.length === 1) repoTop = repos[0];
		else {
			if (!ctx.hasUI) return ctx.ui.notify(`set "${target.name}" has several repos (${repos.map((r) => path.basename(r)).join(", ")}); run /wt use with a UI`, "error");
			const setName = target.name;
			const picked = await progress.pause(() => ctx.ui.select(`Working repo for "${setName}"`, repos.map((r) => path.basename(r))));
			if (picked === undefined) return;
			repoTop = repos.find((r) => path.basename(r) === picked) ?? repos[0];
		}
		targetCwd = within(repoTop);
		label = `set ${target.name}`;
		setRepos = repos;
	}

	await moveConversation(ctx, { targetCwd, label, setRepos, repoTop }, progress);
}

/** The linked folders (links to the original repo) of a set. */
function linkedIn(setRoot: string, cfg: WtConfig): string[] {
	const out: string[] = [];
	for (const repo of repoDirsIn(setRoot)) for (const rel of new Set([...cfg.link, ...DEFAULT_LINK])) if (isLink(path.join(repo, rel))) out.push(slash(path.join(repo, rel)));
	return out;
}

/** `/wt unlink PATH`: replace links to the original repo by nothing, in every repo of this session's set. Returns whether anything changed. */
function unlinkCmd(ctx: ExtensionCommandContext, rel: string, session: WtSession | null): boolean {
	if (!session) {
		ctx.ui.notify("run /wt unlink inside a worktree session", "error");
		return false;
	}
	if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
		ctx.ui.notify("give a relative path inside the repo, for example /wt unlink node_modules", "error");
		return false;
	}
	const lines: string[] = [];
	for (const repo of repoDirsIn(session.setRoot)) {
		const at = path.join(repo, rel);
		if (!isLink(at)) continue;
		try {
			unlinkLink(at);
			lines.push(`unlinked ${slash(at)}`);
		} catch (e) {
			lines.push(`could not unlink ${slash(at)}: ${(e as Error).message}`);
		}
	}
	if (!lines.length) {
		ctx.ui.notify(`${rel} is not a link in this set`, "error");
		return false;
	}
	ctx.ui.notify([...lines, "install the packages in this workspace now"].join("\n"), "info");
	return true;
}

/** `/wt done`: move this conversation to the original folders, then remove the set it ran in (same questions as `/wt remove`). */
async function doneCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, progress: Progress): Promise<void> {
	await ctx.waitForIdle();
	const cfg = await configFor(pi, ctx);
	const git = progress.wrap(makeGit(pi));
	const session = await detectSession(git, cfg, ctx.cwd);
	if (!session) return ctx.ui.notify("/wt done runs inside a worktree session; use /wt remove NAME from another session.", "error");
	const name = path.basename(slash(session.setRoot));
	const bad = checkName(name);
	if (bad) return ctx.ui.notify(bad, "error");
	if (!ctx.hasUI) return ctx.ui.notify("/wt done needs a UI to confirm.", "error");
	progress.stage("asking Unity for open editors");
	const editors = await progress.track("unity status", ctx.cwd, unityEditors(pi));
	const open = editors?.find((e) => fold(e) === fold(session.setRoot) || fold(e).startsWith(`${fold(session.setRoot)}/`));
	if (open) return ctx.ui.notify(`Nothing removed:\nUnity Editor open for ${open}; close it first`, "error");
	const home = await homeOf(git, ctx);
	if (typeof home === "string") return ctx.ui.notify(home, "error");
	await moveConversation(
		ctx,
		{
			targetCwd: home.targetCwd,
			label: "original folders",
			setRepos: [],
			repoTop: home.repoTop,
			after: async (nctx) => {
				const p = new Progress(nctx.ui, `/wt done ${name}`, truncateToWidth);
				try {
					try {
						const cwdNow = fold(path.resolve(process.cwd()));
						const setNow = fold(path.resolve(session.setRoot));
						if (cwdNow === setNow || cwdNow.startsWith(`${setNow}/`)) process.chdir(home.repoTop);
					} catch {}
					// The captured pi is stale after the switch: run git and gh directly.
					const r = await removeFlow(directRun(), nctx, cfg, name, p, editors);
					nctx.ui.notify(r.removed ? r.text : `set kept: ${r.text}`, r.error ? "error" : "info");
				} catch (e) {
					nctx.ui.notify(`set kept: ${(e as Error).message}`, "error");
				} finally {
					p.done();
				}
			},
		},
		progress,
	);
}

export default function worktree(pi: ExtensionAPI) {
	let session: WtSession | null = null;
	let guardOn = true;
	let autoUpdate = true;
	let rebaseUnpushed = true;
	let setBranch = "";
	let linkPaths: string[] = [];
	let repoRoot: string | null = null;
	let cfgLink: string[] = [];
	const started = new Date().toISOString();
	let busy = false;
	let flow: LiveEntry["flow"] = null;
	let liveCtx: ExtensionContext | null = null;
	let liveTimers: ReturnType<typeof setInterval>[] = [];
	let unsubStatus: (() => void) | undefined;
	const publishLive = () => {
		const c = liveCtx;
		if (!c) return;
		try {
			writeLive(liveDir(), {
				v: 1,
				pid: process.pid,
				started,
				updated: new Date().toISOString(),
				sessionFile: c.sessionManager.getSessionFile() ?? null,
				cwd: slash(c.cwd),
				folders: foldersFromEntries(c.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]),
				repo: repoRoot,
				set: session ? slash(session.setRoot) : null,
				busy,
				flow,
			});
		} catch {}
	};
	const pollFooter = () => {
		try {
			liveCtx?.ui.setStatus("wt-sessions", footerText(sessionsInUse(), process.pid));
		} catch {}
	};
	const stopLive = () => {
		for (const t of liveTimers) clearInterval(t);
		liveTimers = [];
		unsubStatus?.();
		unsubStatus = undefined;
		liveCtx = null;
		removeLive(liveDir(), process.pid);
	};
	const startLive = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		for (const t of liveTimers) clearInterval(t);
		unsubStatus?.();
		liveCtx = ctx;
		busy = false;
		publishLive();
		pollFooter();
		liveTimers = [setInterval(publishLive, 30000), setInterval(pollFooter, 5000)];
		for (const t of liveTimers) t.unref?.();
		unsubStatus = pi.events.on("workflow:status", (d) => {
			const st = d as { v?: number; phase?: string; flowId?: string; title?: string; stage?: number; stages?: number } | null;
			if (!st || st.v !== 1 || typeof st.phase !== "string") return;
			flow = st.phase === "off" ? null : { phase: st.phase, flowId: st.flowId, title: st.title, stage: st.stage, stages: st.stages };
			publishLive();
		});
	};
	pi.on("agent_start", () => {
		busy = true;
		publishLive();
	});
	pi.on("agent_end", () => {
		busy = false;
		publishLive();
	});
	pi.on("session_start", async (event, ctx) => {
		try {
			const git = makeGit(pi);
			const sc = await sessionConfig(git, getAgentDir(), ctx.cwd);
			cachedParent = sc.parent;
			const cfg = sc.cfg;
			guardOn = cfg.unityGuard;
			session = await detectSession(git, cfg, ctx.cwd);
			autoUpdate = cfg.autoUpdate;
			rebaseUnpushed = cfg.rebaseUnpushed;
			setBranch = session ? branchOf(cfg, path.basename(session.setRoot)) : "";
			cfgLink = cfg.link;
			linkPaths = session ? linkedIn(session.setRoot, cfg) : [];
			const t = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
			repoRoot = t.code === 0 ? slash(t.stdout.trim()) : null;
		} catch {
			cachedParent = path.dirname(slash(ctx.cwd));
			session = null;
			linkPaths = [];
			repoRoot = null;
		}
		startLive(ctx);
		// Interactive sessions only: a headless pi (subagent, `pi -p`) in the set must not move files under its parent.
		if (!session || !autoUpdate || !ctx.hasUI || (event.reason !== "startup" && event.reason !== "resume")) return;
		const progress = new Progress(ctx.ui, `worktree update (${path.basename(session.setRoot)})`, truncateToWidth);
		try {
			progress.stage("fetching and fast-forwarding");
			// Only the fetch gets a short timeout and no credential dialog, so an unreachable remote delays startup
			// by seconds; the merge keeps the normal timeout so a long checkout is never killed halfway.
			const short = progress.wrap(makeGit(pi, 15000));
			const fetchGit: Git = (cwd, args) => short(cwd, ["-c", "credential.interactive=never", ...args]);
			const res = await updateSet(progress.wrap(makeGit(pi)), repoDirsIn(session.setRoot), { allowDirty: false, rebase: rebaseUnpushed, branch: setBranch, gh: makeGh(pi) }, fetchGit);
			progress.done();
			if (!worthNotifying(res)) return;
			const text = [`Worktree update (${path.basename(session.setRoot)}):`, ...res.map((r) => `  ${r.text}`)].join("\n");
			ctx.ui.notify(text, res.some((r) => r.state === "failed") ? "warning" : "info");
		} catch (e) {
			ctx.ui.notify(`Worktree update failed: ${(e as Error).message}`, "warning");
		} finally {
			progress.done();
		}
	});
	pi.on("session_shutdown", (event, ctx) => {
		stopLive();
		try {
			if (event.reason !== "quit" || !session || !ctx.hasUI || !process.stderr.isTTY) return;
			if (!repoDirsIn(session.setRoot).length) return;
			process.stderr.write(quitReminder(slash(session.setRoot)));
		} catch {}
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (session && setBranch) {
			// A merge with --delete-branch leaves the repos on a detached HEAD: put the set's branch back.
			try {
				const git = makeGit(pi);
				const done: string[] = [];
				for (const wt of repoDirsIn(session.setRoot)) {
					const r = await reattach(git, wt, setBranch);
					if (r?.state === "reattached") done.push(`  ${r.text}`);
				}
				if (done.length) {
					session = (await detectSession(git, (await sessionConfig(git, getAgentDir(), ctx.cwd)).cfg, ctx.cwd)) ?? session;
					ctx.ui.notify(["Worktree:", ...done].join("\n"), "info");
				}
			} catch {}
		}
		if (session) event.systemPromptOptions.sections.worktree = worktreePrompt(session);
	});
	pi.on("tool_call", async (event, ctx) => {
		if (!session || !guardOn) return;
		const why = guardProblem(event.toolName, (event.input ?? {}) as Record<string, unknown>, { cwd: ctx.cwd, setRoot: session.setRoot });
		if (why) return { block: true, reason: why };
		const shared = sharedProblem(event.toolName, (event.input ?? {}) as Record<string, unknown>, { cwd: ctx.cwd, setRoot: session.setRoot, linked: linkPaths });
		if (shared) return { block: true, reason: shared };
	});
	pi.registerCommand("wt", {
		description: "Parallel pi sessions on git worktrees: new [NAME], open NAME, use [NAME], list, update [NAME], remove NAME, rename [OLD] [NEW], clean, done, unlink PATH",
		getArgumentCompletions: async (prefix) => {
			const m = /^(remove|open|update|use|rename)\s+(\S*)$/i.exec(prefix.trimStart());
			if (m) {
				const sets = listSets(completionConfig()).filter((n) => n.startsWith(m[2]));
				return sets.length ? sets.map((n) => ({ value: `${m[1].toLowerCase()} ${n}`, label: n })) : null;
			}
			if (/\s/.test(prefix.trim())) return null;
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim().toLowerCase())).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const progress = new Progress(ctx.hasUI ? ctx.ui : null, `/wt ${args.trim()}`, truncateToWidth);
			try {
				if (sub === "new") return await newSet(pi, ctx, rest[0] ?? "", progress);
				if (sub === "open") return await openCmd(pi, ctx, rest[0] ?? "", progress);
				if (sub === "use") return await useCmd(pi, ctx, rest[0] ?? "", progress, session);
				if (sub === "unlink") {
					if (unlinkCmd(ctx, rest[0] ?? "", session) && session) linkPaths = linkedIn(session.setRoot, { link: cfgLink } as WtConfig);
					return;
				}
				if (sub === "list") return await listCmd(pi, ctx, progress);
				if (sub === "update") return await updateCmd(pi, ctx, rest[0] ?? "", progress);
				if (sub === "remove") return await removeCmd(pi, ctx, rest[0] ?? "", progress);
				if (sub === "rename") return await renameCmd(pi, ctx, rest[0] ?? "", rest[1] ?? "", progress, session);
				if (sub === "clean") return await cleanCmd(pi, ctx, progress);
				if (sub === "done") return await doneCmd(pi, ctx, progress);
				ctx.ui.notify("Usage: /wt new [NAME] | /wt open NAME | /wt use [NAME] | /wt list | /wt update [NAME] | /wt remove NAME | /wt rename [OLD] [NEW] | /wt clean | /wt done | /wt unlink PATH", "info");
			} catch (e) {
				ctx.ui.notify(`/wt ${sub ?? ""} failed: ${(e as Error).message}`, "error");
			} finally {
				progress.done();
			}
		},
	});
}
