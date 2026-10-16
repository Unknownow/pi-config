/** /wt list and /wt remove. */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LINK, loadConfig, type WtConfig } from "./config.ts";
import { isLink, unlinkLink } from "./files.ts";
import { baseRefOf, mainRepoOf, removeChecks, repoStatus, type Git } from "./git-ops.ts";
import { baseName, branchOf, checkName, setRootOf } from "./layout.ts";

const caseFold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
const norm = (p: string) => caseFold(p.split(String.fromCharCode(92)).join("/").replace(/\/+$/, ""));
const inside = (p: string, dir: string) => norm(p) === norm(dir) || norm(p).startsWith(`${norm(dir)}/`);

function dirs(p: string): string[] {
	try {
		return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
	} catch {
		return [];
	}
}

export const listSets = (cfg: WtConfig) => dirs(cfg.root);

/** Repo worktrees of a set: subfolders that contain a `.git` entry. */
export function repoDirsIn(set: string): string[] {
	return dirs(set).filter((d) => fs.existsSync(path.join(set, d, ".git"))).map((d) => `${set}/${d}`);
}

export const reposOf = (cfg: WtConfig, name: string): string[] => repoDirsIn(setRootOf(cfg, name));

export type OpenPlan = { cwd: string; folders: string[] } | { choose: string[] } | { error: string };

/** Where /wt open starts pi: the working repo of set NAME and the other repos as added folders. */
export function openPlan(cfg: WtConfig, name: string, preferred: string | null): OpenPlan {
	if (!name) return { error: "give a name: /wt open <name>" };
	const bad = checkName(name);
	if (bad) return { error: bad };
	const repos = reposOf(cfg, name);
	if (!repos.length) {
		const sets = listSets(cfg);
		return { error: `no worktree set "${name}" in ${cfg.root}${sets.length ? `; sets: ${sets.join(", ")}` : ""}` };
	}
	if (repos.length === 1) return { cwd: repos[0], folders: [] };
	if (preferred !== null) {
		const hit = repos.filter((r) => caseFold(baseName(r)) === caseFold(preferred));
		if (hit.length === 1) return { cwd: hit[0], folders: repos.filter((r) => r !== hit[0]) };
	}
	return { choose: repos.map(baseName) };
}

export function quitReminder(setRoot: string): string {
	const name = baseName(setRoot);
	return `Worktree set "${name}" is still on disk: ${setRoot}\n  reopen: /wt open ${name}   remove: /wt done (inside it) or /wt remove ${name}\n`;
}

/** Open Editor projects from `unity status --format json`; null when unknown. */
export function parseEditors(stdout: string): string[] | null {
	try {
		const inst = JSON.parse(stdout)?.data?.instances;
		return Array.isArray(inst) ? inst.map((i: { project?: string }) => i.project ?? "").filter(Boolean) : null;
	} catch {
		return null;
	}
}

export async function listText(git: Git, cfg: WtConfig, editors: string[] | null): Promise<string> {
	const sets = listSets(cfg);
	if (!sets.length) return `No worktree sets in ${cfg.root}`;
	const out: string[] = [];
	for (const name of sets) {
		out.push(`${name}:`);
		for (const wt of reposOf(cfg, name)) {
			const st = await repoStatus(git, wt, await baseRefOf(git, wt));
			const sync = st.upstream ? `ahead ${st.ahead}, behind ${st.behind}` : `not pushed: ${st.unpushed} commits`;
			const lib = fs.existsSync(`${wt}/unity/Library`) ? "yes" : "no";
			const open = editors ? (editors.some((e) => inside(e, wt)) ? "yes" : "no") : "unknown";
			out.push(`  ${path.basename(wt)}: ${st.branch}, ${st.dirty} changed, ${sync}, Library: ${lib}, Editor open: ${open}`);
		}
	}
	return out.join("\n");
}

export interface RemoveEnv {
	git: Git;
	cfg: WtConfig;
	cwd: string;
	added: string[];
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
}

const libraryLines = (wts: string[]) => wts.map((w) => `${w}${fs.existsSync(`${w}/unity/Library`) ? " (its Library/ will be deleted)" : ""}`);

/** Returns the report text; `error` marks a refusal or failure. */
export async function removeSet(env: RemoveEnv, name: string): Promise<{ text: string; error: boolean }> {
	const { git, cfg } = env;
	const bad = checkName(name);
	if (bad) return { text: bad, error: true };
	const set = setRootOf(cfg, name);
	if ( !fs.existsSync(set)) return { text: `No worktree set "${name}" in ${cfg.root}`, error: true };
	if ([env.cwd, ...env.added].some((p) => inside(p, set))) return { text: `This session uses ${set}; run /wt remove from another session.`, error: true };
	if (!env.hasUI) return { text: "/wt remove needs a UI to confirm.", error: true };
	const wts = reposOf(cfg, name);
	const checks = await removeChecks(git, wts);
	if (checks.problems.length) return { text: `Nothing removed:\n${checks.problems.join("\n")}`, error: true };
	const ok = await env.confirm(`Remove worktree set "${name}"?`, [...checks.warnings, ...libraryLines(wts)].join("\n"));
	if (!ok) return { text: "Cancelled.", error: false };
	const r = await removeAll(env, name, set, wts, false);
	return { text: r.text, error: r.error };
}

/** True when `p` is missing or holds only real directories, recursively (no files, no links). */
function onlyEmptyDirs(p: string): boolean {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(p);
	} catch {
		return true;
	}
	if (!st.isDirectory()) return false;
	return fs.readdirSync(p).every((e) => onlyEmptyDirs(path.join(p, e)));
}

async function isRegistered(git: Git, main: string, wt: string): Promise<boolean> {
	const r = await git(main, ["worktree", "list", "--porcelain"]);
	if (r.code !== 0) return true;
	return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && norm(l.slice(9).trim()) === norm(wt));
}

/** Removes the worktrees in the given order. Folders git could not delete (in use) go to `leftovers`. */
async function removeAll(env: RemoveEnv, name: string, set: string, wts: string[], allowInUse: boolean): Promise<{ text: string; error: boolean; leftovers: string[] }> {
	const { git, cfg } = env;
	const done: string[] = [];
	const leftovers: string[] = [];
	for (const wt of wts) {
		try {
			const main = await mainRepoOf(git, wt);
			const branch = branchOf(cfg, name);
			const current = (await repoStatus(git, wt, null)).branch;
			if (!main) return { text: `Stopped at ${wt}: cannot find its main repo. Removed: ${done.join(", ") || "nothing"}`, error: true, leftovers };
			for (const rel of new Set([...cfg.link, ...DEFAULT_LINK])) {
				const at = path.join(wt, rel);
				if (isLink(at)) unlinkLink(at);
			}
			const rm = await git(main, ["worktree", "remove", wt]);
			let inUse = false;
			if (rm.code !== 0) {
				if (allowInUse && !(await isRegistered(git, main, wt)) && onlyEmptyDirs(wt)) {
					inUse = true;
					leftovers.push(wt);
				} else {
					return { text: `Stopped at ${wt}: ${(rm.stderr || rm.stdout).trim()}\nRemoved: ${done.join(", ") || "nothing"}`, error: true, leftovers };
				}
			}
			const br = current === branch ? await git(main, ["branch", "-d", branch]) : { code: 1, stdout: "", stderr: `worktree was on ${current}` };
			const kept = br.code === 0 ? "" : ` (branch ${branch} kept: ${(br.stderr || br.stdout).trim().split("\n")[0]})`;
			done.push(inUse ? `${wt} (folder in use: deleted after pi exits)${kept}` : br.code === 0 ? wt : `${wt}${kept}`);
		} catch (e) {
			return { text: `Stopped at ${wt}: ${(e as Error).message}
Removed: ${done.join(", ") || "nothing"}`, error: true, leftovers };
		}
	}
	try {
		if (fs.readdirSync(set).length === 0) fs.rmdirSync(set);
	} catch {
		// leave a folder we could not remove
	}
	if (allowInUse && fs.existsSync(set) && onlyEmptyDirs(set)) {
		leftovers.push(set);
		done.push(`${set} (deleted after pi exits)`);
	}
	return { text: `Removed set "${name}":\n${done.join("\n")}`, error: false, leftovers };
}

export interface DoneEnv extends RemoveEnv {
	session: WtSession | null;
	editors: string[] | null;
	leave: (to: string) => void;
}
export interface DoneResult {
	text: string;
	error: boolean;
	removed: boolean;
	leftovers: string[];
}

/** /wt done: removes the set this session runs in; the working repo goes last. */
export async function finishSet(env: DoneEnv): Promise<DoneResult> {
	const { git, cfg, session } = env;
	const refuse = (text: string): DoneResult => ({ text, error: true, removed: false, leftovers: [] });
	if (!session) return refuse("/wt done runs inside a worktree session; use /wt remove NAME from another session.");
	const set = session.setRoot;
	const name = baseName(set);
	const bad = checkName(name);
	if (bad) return refuse(bad);
	if (!fs.existsSync(set)) return refuse(`No worktree set "${name}" in ${cfg.root}`);
	if (!env.hasUI) return refuse("/wt done needs a UI to confirm.");
	let wts = reposOf(cfg, name);
	if (!wts.length) return refuse(`No worktrees in ${set}`);
	const open = env.editors?.find((e) => inside(e, set));
	if (open) return refuse(`Nothing removed:\nUnity Editor open for ${open}; close it first`);
	const checks = await removeChecks(git, wts);
	if (checks.problems.length) return refuse(`Nothing removed:\n${checks.problems.join("\n")}`);
	const warnings = [...checks.warnings, ...(env.editors ? [] : ["Unity Editor state unknown (unity status failed)"])];
	const ok = await env.confirm(`Finish worktree set "${name}"?`, [...warnings, ...libraryLines(wts)].join("\n"));
	if (!ok) return { text: "Cancelled.", error: false, removed: false, leftovers: [] };
	wts = [...wts.filter((w) => !inside(env.cwd, w)), ...wts.filter((w) => inside(env.cwd, w))];
	const main = (await mainRepoOf(git, wts[wts.length - 1])) ?? path.posix.dirname(norm(cfg.root));
	env.leave(main);
	const r = await removeAll(env, name, set, wts, true);
	return { text: r.text, error: r.error, removed: !r.error, leftovers: r.leftovers };
}

/** Run as `node -e SWEEP_SCRIPT <tries> <intervalMs> <dir>...`. Only rmdirs empty folders; never deletes a file. */
export const SWEEP_SCRIPT = `
const fs = require("fs"), path = require("path");
const [tries, wait, ...dirs] = process.argv.slice(1);
const sweep = (p) => {
	let st;
	try { st = fs.lstatSync(p); } catch { return; }
	if (!st.isDirectory()) return;
	for (const e of fs.readdirSync(p)) sweep(path.join(p, e));
	try { fs.rmdirSync(p); } catch {}
};
for (let i = 0; i < Number(tries); i++) {
	for (const d of dirs) { try { sweep(d); } catch {} }
	if (!dirs.some((d) => fs.existsSync(d))) break;
	if (i + 1 < Number(tries)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(wait));
}
`;

export interface WtSession {
	setRoot: string;
	branch: string;
	unityProject: string | null;
}

function plainFolderSession(cfg: WtConfig, cwd: string, root: string): WtSession | null {
	const here = norm(cwd);
	if (!here.startsWith(`${root}/`)) return null;
	const first = here.slice(root.length + 1).split("/")[0];
	return { setRoot: `${cfg.root.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "")}/${first}`, branch: "", unityProject: null };
}

/** The worktree set this session runs in, or null when it runs in an original folder. */
export async function detectSession(git: Git, cfg: WtConfig, cwd: string): Promise<WtSession | null> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	const root = norm(cfg.root);
	if (top.code !== 0) return plainFolderSession(cfg, cwd, root);
	const here = norm(top.stdout.trim());
	if (!here.startsWith(`${root}/`)) return null;
	const dirs = await git(cwd, ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"]);
	const [gitDir, common] = dirs.stdout.split(String.fromCharCode(10)).map((l) => l.trim());
	if (dirs.code !== 0 || !gitDir || !common) return null;
	const commonAbs = norm(common);
	if (norm(gitDir) === commonAbs) return null;
	const first = here.slice(root.length + 1).split("/")[0];
	const setRoot = `${cfg.root.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "")}/${first}`;
	const br = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const proj = `${top.stdout.trim().split(String.fromCharCode(92)).join("/")}/unity`;
	return {
		setRoot,
		branch: br.stdout.trim(),
		unityProject: fs.existsSync(`${proj}/ProjectSettings`) ? proj : null,
	};
}

export function worktreePrompt(s: WtSession): string {
	const unity = s.unityProject ? ` This set's Unity project: \`${s.unityProject}\`.` : "";
	return `This session runs in the git worktree set \`${s.setRoot}\` (branch \`${s.branch}\`). The open Unity Editor belongs to another session: do not drive it. Unity commands that drive an Editor or run a project are refused unless \`--project-path\` is an absolute path inside \`${s.setRoot}\`. For Unity checks, commit and ask the user to run them in the Editor session.${unity}`;
}

/** Parent folder of the main repo (not of a worktree), so the default root is the same everywhere. */
export async function mainParent(git: Git, cwd: string): Promise<string> {
	const r = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const common = r.stdout.trim().split(String.fromCharCode(92)).join("/").replace(/\/+$/, "");
	if (r.code !== 0 || !common.endsWith("/.git")) {
		const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
		const base = top.code === 0 ? top.stdout.trim() : cwd;
		return path.posix.dirname(base.split(String.fromCharCode(92)).join("/"));
	}
	return path.posix.dirname(path.posix.dirname(common));
}

/** The config every command and the session check use: the default root is next to the main repo. */
export async function sessionConfig(git: Git, agentDir: string, cwd: string): Promise<{ cfg: WtConfig; warning?: string; parent: string }> {
	const parent = await mainParent(git, cwd);
	return { ...loadConfig(agentDir, parent), parent };
}
