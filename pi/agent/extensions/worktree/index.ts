/**
 * /wt: run several pi sessions on the same repos without copying them. `/wt new <name>` makes a git
 * worktree for the working repo and every added folder, links or copies the gitignored files, and opens
 * a new terminal window (or VS Code terminal) running pi there. `/wt open <name>` reopens a set, `/wt done` removes the set a session runs in.
 * `/wt update` fast-forwards a set to its base branches; a session inside a set does that at startup. See README.md.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type WtConfig } from "./config.ts";
import { setupFiles } from "./files.ts";
import { sendToVscode } from "./vscode-bridge.ts";
import { createAll, excludeLinks, preflight, rollback, type Gh, type Git, type Planned } from "./git-ops.ts";
import { SWEEP_SCRIPT, detectSession, finishSet, listSets, listText, openPlan, parseEditors, quitReminder, removeSet, repoDirsIn, sessionConfig, worktreePrompt, type WtSession } from "./manage.ts";
import { guardProblem } from "./unity-guard.ts";
import { reattach, updateSet, worthNotifying } from "./update.ts";
import { Progress } from "./progress.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { branchOf, checkName, launchSpec, rootProblem, setRootOf, vscodeTerminalSpec } from "./layout.ts";

const STATE_ENTRY = "workflow-state";
const SUBCOMMANDS = ["new", "open", "list", "update", "remove", "done"];

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

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
	return async (cwd, args) => {
		const r = await pi.exec("git", args, { cwd, timeout });
		return { code: r.code, stdout: r.stdout, stderr: r.stderr };
	};
}

/** The folders added to this session by the workflow extension (absolute, forward slashes). */
function addedFolders(ctx: ExtensionCommandContext): string[] {
	const saved = ctx.sessionManager
		.getBranch()
		.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === STATE_ENTRY)
		.pop() as { data?: { folders?: string[] } } | undefined;
	return (saved?.data?.folders ?? []).map(slash);
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

async function launch(cfg: WtConfig, name: string, cwd: string, folders: string[], piArgs: string[] = []): Promise<{ text: string; error?: string }> {
	const opts = {
		platform: process.platform,
		launch: cfg.launch,
		wtPath: findWt(),
		piCommand: piCommandOf(cfg),
		cwd,
		name,
		folders,
		piArgs,
	};
	const bridgeAllowed = cfg.vscode && cfg.launch !== "none";
	const pipe = process.env.PI_VSCODE_TERMINAL;
	let note = "";
	let hint = "";
	if (bridgeAllowed && pipe) {
		const err = await sendToVscode(pipe, vscodeTerminalSpec(opts));
		if (err === null) return { text: `Opened a new VS Code terminal running pi in ${cwd}` };
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
	return { text: `${note}Opened a new ${cfg.launch === "tab" ? "tab" : "window"} running pi in ${cwd}${hint}` };
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

async function newSet(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string, progress: Progress): Promise<void> {
	const bad = checkName(name);
	if (bad) return ctx.ui.notify(bad, "error");
	const git = progress.wrap(makeGit(pi));
	progress.stage("checking repos (fetching)");
	const found = await collect(git, ctx);
	if (typeof found === "string") return ctx.ui.notify(found, "error");
	const loaded = await sessionConfig(git, getAgentDir(), found.workingTop);
	const cfg = loaded.cfg;
	if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
	const rootBad = rootProblem(cfg.root);
	if (rootBad) return ctx.ui.notify(rootBad, "error");

	const pre = await preflight(git, found.repos, cfg, name);
	for (const w of pre.warnings) ctx.ui.notify(w, "warning");
	if (pre.errors.length) return ctx.ui.notify(`Nothing created:\n${pre.errors.join("\n")}`, "error");

	let lines: string[];
	try {
		lines = await build(git, pre.plan, cfg, name, progress);
	} catch (e) {
		return ctx.ui.notify((e as Error).message, "error");
	}
	const targetOf = (top: string) => pre.plan.find((p) => p.info.top === top)?.target ?? top;
	const rel = path.relative(found.workingTop, ctx.cwd).replace(/\\/g, "/");
	const cwd = rel && !rel.startsWith("..") ? `${targetOf(found.workingTop)}/${rel}` : targetOf(found.workingTop);
	const folders = found.order.map(targetOf);
	progress.stage("opening terminal");
	const l = await launch(cfg, name, cwd, folders);
	const head = `Worktree set "${name}" (branch ${branchOf(cfg, name)}) in ${setRootOf(cfg, name)}`;
	ctx.ui.notify([head, ...lines, l.error ?? l.text].join("\n"), l.error ? "warning" : "info");
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
	ctx.ui.notify(await listText(progress.wrap(makeGit(pi)), cfg, editors), "info");
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
	const l = await launch(cfg, name, p.cwd, p.folders, ["--continue"]);
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
		} catch {
			cachedParent = path.dirname(slash(ctx.cwd));
			session = null;
		}
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
	});
	pi.registerCommand("wt", {
		description: "Parallel pi sessions on git worktrees: new NAME, open NAME, list, update [NAME], remove NAME, done",
		getArgumentCompletions: async (prefix) => {
			const m = /^(remove|open|update)\s+(\S*)$/i.exec(prefix.trimStart());
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
				if (sub === "list") return await listCmd(pi, ctx, progress);
				if (sub === "update") return await updateCmd(pi, ctx, rest[0] ?? "", progress);
				if (sub === "remove") return await removeCmd(pi, ctx, rest[0] ?? "", progress);
				if (sub === "done") return await doneCmd(pi, ctx, progress);
				ctx.ui.notify("Usage: /wt new NAME | /wt open NAME | /wt list | /wt update [NAME] | /wt remove NAME | /wt done", "info");
			} catch (e) {
				ctx.ui.notify(`/wt ${sub ?? ""} failed: ${(e as Error).message}`, "error");
			} finally {
				progress.done();
			}
		},
	});
}
