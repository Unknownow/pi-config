/**
 * /wt: run several pi sessions on the same repos without copying them. `/wt new <name>` makes a git
 * worktree for the working repo and every added folder, links or copies the gitignored files, and opens
 * a new terminal window (or VS Code terminal) running pi there. `/wt open <name>` reopens a set, `/wt done` removes the set a session runs in.
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
import { SWEEP_SCRIPT, detectSession, finishSet, listSets, listText, openPlan, parseEditors, quitReminder, removeSet, repoDirsIn, reposOf, sessionConfig, worktreePrompt, type WtSession } from "./manage.ts";
import { guardProblem } from "./unity-guard.ts";
import { reattach, updateSet, worthNotifying } from "./update.ts";
import { Progress } from "./progress.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { branchOf, checkName, launchSpec, rootProblem, setRootOf, vscodeTerminalSpec } from "./layout.ts";

const SUBCOMMANDS = ["new", "open", "use", "list", "update", "remove", "done", "unlink"];

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

/** Create a set for the working repo and the added folders (no terminal, no session). Reports problems itself and returns null. */
async function createSet(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<Created | null> {
	const fail = (m: string) => {
		ctx.ui.notify(m, "error");
		return null;
	};
	const bad = checkName(name);
	if (bad) return fail(bad);
	const git = progress.wrap(makeGit(pi));
	progress.stage("checking repos (fetching)");
	const found = await collect(git, ctx);
	if (typeof found === "string") return fail(found);
	const loaded = await sessionConfig(git, getAgentDir(), found.workingTop);
	const cfg = loaded.cfg;
	if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
	const rootBad = rootProblem(cfg.root);
	if (rootBad) return fail(rootBad);

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
	progress.stage("opening terminal");
	const git = makeGit(pi);
	const l = await launch(c.cfg, name, await launchCwdOf(git, c.cfg, c.workingTop), c.cwd, c.folders, freshSessionFile(c.cwd));
	const head = `Worktree set "${name}" (branch ${branchOf(c.cfg, name)}) in ${c.setRoot}`;
	ctx.ui.notify([head, ...c.lines, l.error ?? l.text].join("\n"), l.error ? "warning" : "info");
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
	const live = sessionsInUse();
	const usage = (name: string) => {
		const holder = setInUse(live, setRootOf(cfg, name), process.pid);
		return holder ? `in use by pi ${holder.pid}` : "free";
	};
	ctx.ui.notify(await listText(progress.wrap(makeGit(pi)), cfg, editors, usage), "info");
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

async function removeCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<void> {
	const cfg = await configFor(pi, ctx);
	if (!name) {
		const picked = await pickSet(ctx, cfg, "Remove which worktree set?", progress);
		if (!picked) return;
		name = picked;
	}
	const setName = name;
	const holder = setInUse(sessionsInUse(), setRootOf(cfg, setName), process.pid);
	if (holder) return ctx.ui.notify(`${setName} is in use by pi ${holder.pid}`, "error");
	progress.stage(`checking ${setName} (fetching)`);
	const env = {
		git: progress.wrap(makeGit(pi)),
		cfg,
		cwd: ctx.cwd,
		added: addedFolders(ctx),
		hasUI: ctx.hasUI,
		confirm: async (t: string, m: string) => {
			const ok = await progress.pause(() => ctx.ui.confirm(t, m));
			if (ok) progress.stage(`removing ${setName}`);
			return ok;
		},
	};
	const r = await removeSet(env, name);
	ctx.ui.notify(r.text, r.error ? "error" : "info");
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

type UseTarget = { kind: "set"; name: string } | { kind: "original" } | { kind: "new" };

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
		const nm = (await progress.pause(() => ctx.ui.input("Name of the new workspace", "w1")))?.trim();
		if (!nm) return;
		const c = await createSet(pi, ctx, nm, progress);
		if (!c) return;
		targetCwd = c.cwd;
		label = nm;
		setRepos = reposOf(c.cfg, nm);
		repoTop = c.workingTarget;
	} else if (target.kind === "original") {
		const main = await mainRepoOf(git, workingTop);
		if (!main) return ctx.ui.notify("could not find the original repo of this worktree", "error");
		repoTop = main;
		targetCwd = within(main);
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

	const cur = ctx.sessionManager.getSessionFile();
	let file: string;
	try {
		file = cur && fs.existsSync(cur) ? (SessionManager.forkFrom(cur, targetCwd).getSessionFile() ?? "") : freshSessionFile(targetCwd);
		if (!file) throw new Error("no session file");
	} catch (e) {
		return ctx.ui.notify(`could not copy the conversation: ${(e as Error).message}`, "error");
	}
	progress.done();
	const moved = targetCwd;
	const res = await ctx.switchSession(file, {
		withSession: async (nctx) => {
			const folders = foldersFromEntries(nctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]);
			const missing = setRepos.filter((r) => fold(r) !== fold(repoTop) && !folders.some((f) => fold(f) === fold(r))).map((r) => path.basename(r));
			const text = `This conversation moved to ${moved} (${label}). Repo paths now: ${[slash(nctx.cwd), ...folders].join(", ")}. Earlier messages refer to the old paths.`;
			await nctx.sendMessage({
				customType: "worktree-moved",
				display: true,
				content: missing.length ? `${text}\nnot attached: ${missing.join(", ")}; add them with /folders add` : text,
			});
		},
	});
	if (res.cancelled) {
		try {
			fs.unlinkSync(file);
		} catch {}
		ctx.ui.notify("move cancelled", "info");
	}
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

async function doneCmd(pi: ExtensionAPI, ctx: ExtensionCommandContext, progress: Progress): Promise<void> {
	await ctx.waitForIdle();
	const cfg = await configFor(pi, ctx);
	progress.stage("checking the set (fetching)");
	const git = progress.wrap(makeGit(pi));
	const env = {
		git,
		cfg,
		cwd: ctx.cwd,
		added: addedFolders(ctx),
		hasUI: ctx.hasUI,
		confirm: async (t: string, m: string) => {
			const ok = await progress.pause(() => ctx.ui.confirm(t, m));
			if (ok) progress.stage("removing the set");
			return ok;
		},
		session: await detectSession(git, cfg, ctx.cwd),
		editors: await progress.track("unity status", ctx.cwd, unityEditors(pi)),
		leave: (to: string) => process.chdir(to),
	};
	const r = await finishSet(env);
	progress.done();
	const text = r.text;
	const sweep = () => {
		try {
			const p = spawn(process.execPath, ["-e", SWEEP_SCRIPT, "120", "1000", ...r.leftovers], { detached: true, stdio: "ignore", cwd: cfg.root, windowsHide: true });
			p.on("error", () => {});
			p.unref();
		} catch (e) {
			ctx.ui.notify(`Could not start the cleanup of leftover folders: ${(e as Error).message}`, "warning");
		}
	};
	if (!r.removed) {
		if (r.leftovers.length) sweep();
		ctx.ui.notify(text, r.error ? "error" : "info");
		return;
	}
	ctx.ui.notify(text, "info");
	const name = path.basename(slash(env.session?.setRoot ?? ""));
	const close = await ctx.ui.confirm(`Worktree set "${name}" removed`, `${text}

Close this pi session?`);
	if (r.leftovers.length) sweep();
	if (close) ctx.shutdown();
	else ctx.ui.notify("The set is removed; exit pi when you are done.", "info");
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
		description: "Parallel pi sessions on git worktrees: new NAME, open NAME, use [NAME], list, update [NAME], remove NAME, done, unlink PATH",
		getArgumentCompletions: async (prefix) => {
			const m = /^(remove|open|update|use)\s+(\S*)$/i.exec(prefix.trimStart());
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
				if (sub === "done") return await doneCmd(pi, ctx, progress);
				ctx.ui.notify("Usage: /wt new NAME | /wt open NAME | /wt use [NAME] | /wt list | /wt update [NAME] | /wt remove NAME | /wt done | /wt unlink PATH", "info");
			} catch (e) {
				ctx.ui.notify(`/wt ${sub ?? ""} failed: ${(e as Error).message}`, "error");
			} finally {
				progress.done();
			}
		},
	});
}
