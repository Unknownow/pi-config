/**
 * /wt: run several pi sessions on the same repos without copying them. `/wt new <name>` makes a git
 * worktree for the working repo and every added folder, links or copies the gitignored files, and opens
 * a new terminal window running pi there. See README.md.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, type WtConfig } from "./config.ts";
import { setupFiles } from "./files.ts";
import { createAll, excludeLinks, preflight, rollback, type Git, type Planned } from "./git-ops.ts";
import { branchOf, checkName, launchSpec, rootProblem, setRootOf } from "./layout.ts";

const STATE_ENTRY = "workflow-state";
const SUBCOMMANDS = ["new", "list", "remove"];

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

function makeGit(pi: ExtensionAPI): Git {
	return async (cwd, args) => {
		const r = await pi.exec("git", args, { cwd, timeout: 60000 });
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

async function launch(cfg: WtConfig, name: string, cwd: string, folders: string[]): Promise<{ text: string; error?: string }> {
	const spec = launchSpec({
		platform: process.platform,
		launch: cfg.launch,
		wtPath: findWt(),
		piCommand: piCommandOf(cfg),
		cwd,
		name,
		folders,
	});
	if ("print" in spec) return { text: `Start it with: ${spec.print}` };
	const child = spawn(spec.file, spec.args, { detached: true, stdio: "ignore", cwd });
	const failure = await new Promise<string | null>((resolve) => {
		child.once("error", (e) => resolve(e.message));
		child.once("spawn", () => resolve(null));
	});
	if (failure) return { text: "", error: `could not open the terminal (${spec.file}): ${failure}` };
	child.unref();
	return { text: `Opened a new ${cfg.launch === "tab" ? "tab" : "window"} running pi in ${cwd}` };
}

/** Create the worktrees and their files; on any failure undo what this run created. */
async function build(git: Git, plan: Planned[], cfg: WtConfig, name: string): Promise<string[]> {
	const created: Planned[] = [];
	const lines: string[] = [];
	try {
		await createAll(git, plan, branchOf(cfg, name), (p) => created.push(p));
		for (const p of plan) {
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

async function newSet(pi: ExtensionAPI, ctx: ExtensionCommandContext, name: string): Promise<void> {
	const bad = checkName(name);
	if (bad) return ctx.ui.notify(bad, "error");
	const git = makeGit(pi);
	const found = await collect(git, ctx);
	if (typeof found === "string") return ctx.ui.notify(found, "error");
	const loaded = loadConfig(getAgentDir(), path.dirname(found.workingTop));
	const cfg = loaded.cfg;
	if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
	const rootBad = rootProblem(cfg.root);
	if (rootBad) return ctx.ui.notify(rootBad, "error");

	const pre = await preflight(git, found.repos, cfg, name);
	for (const w of pre.warnings) ctx.ui.notify(w, "warning");
	if (pre.errors.length) return ctx.ui.notify(`Nothing created:\n${pre.errors.join("\n")}`, "error");

	let lines: string[];
	try {
		lines = await build(git, pre.plan, cfg, name);
	} catch (e) {
		return ctx.ui.notify((e as Error).message, "error");
	}
	const targetOf = (top: string) => pre.plan.find((p) => p.info.top === top)?.target ?? top;
	const rel = path.relative(found.workingTop, ctx.cwd).replace(/\\/g, "/");
	const cwd = rel && !rel.startsWith("..") ? `${targetOf(found.workingTop)}/${rel}` : targetOf(found.workingTop);
	const folders = found.order.map(targetOf);
	const l = await launch(cfg, name, cwd, folders);
	const head = `Worktree set "${name}" (branch ${branchOf(cfg, name)}) in ${setRootOf(cfg, name)}`;
	ctx.ui.notify([head, ...lines, l.error ?? l.text].join("\n"), l.error ? "warning" : "info");
}

export default function worktree(pi: ExtensionAPI) {
	pi.registerCommand("wt", {
		description: "Parallel pi sessions on git worktrees: new NAME, list, remove NAME",
		getArgumentCompletions: (prefix) => {
			if (/\s/.test(prefix.trim())) return null;
			const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim().toLowerCase())).map((s) => ({ value: s, label: s }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			try {
				if (sub === "new") return await newSet(pi, ctx, rest[0] ?? "");
				if (sub === "list" || sub === "remove") return ctx.ui.notify(`/wt ${sub} is not available yet`, "warning");
				ctx.ui.notify("Usage: /wt new NAME | /wt list | /wt remove NAME", "info");
			} catch (e) {
				ctx.ui.notify(`/wt ${sub ?? ""} failed: ${(e as Error).message}`, "error");
			}
		},
	});
}
