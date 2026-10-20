/** /wt list, set states and the one removal path behind /wt remove, /wt clean and /wt done. */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LINK, loadConfig, type WtConfig } from "./config.ts";
import { isLink, unlinkLink } from "./files.ts";
import { baseRefOf, deliveredState, mainRepoOf, mergedPrOf, repoStatus, type Gh, type Git } from "./git-ops.ts";
import { baseName, branchOf, checkName, setRootOf } from "./layout.ts";
import { readMeta, writeMeta } from "./meta.ts";

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

/** `usage` adds a note about who uses a set to its heading line. */
export async function listText(git: Git, cfg: WtConfig, editors: string[] | null, usage?: (name: string) => string): Promise<string> {
	const sets = listSets(cfg);
	if (!sets.length) return `No worktree sets in ${cfg.root}`;
	const out: string[] = [];
	for (const name of sets) {
		out.push(usage ? `${name}: (${usage(name)})` : `${name}:`);
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

export const libraryLines = (wts: string[]) => wts.map((w) => `${w}${fs.existsSync(`${w}/unity/Library`) ? " (its Library/ will be deleted)" : ""}`);

/** What the removal engine needs: git, gh, the config, who uses a set, and the open Unity Editors. */
export interface WorkspaceEnv {
	git: Git;
	gh: Gh;
	cfg: WtConfig;
	/** The reason a set is in use by another live pi session, or null. */
	inUse: (setRoot: string) => string | null;
	editors: string[] | null;
}

export type SetKind = "delivered" | "in-use" | "has-work" | "broken" | "leftover";

export interface RepoState {
	dir: string;
	wt: string;
	main: string | null;
	branch: string;
	dirty: number;
	own: number;
	/** HEAD when the state was read; a removal refuses a repo whose HEAD moved since. */
	head: string;
	delivered: "base" | "pr" | null;
	pr?: number;
	error?: string;
	ghError?: string;
	/** The set's branch when it is not what HEAD points to and holds commits that are neither in the base branch nor in a merged PR. */
	spare?: { branch: string; tip: string };
}

export interface SetState {
	kind: SetKind;
	repos: RepoState[];
	reason: string;
}

/** True when `p` is missing or holds only real directories, recursively (no files, no links). */
export function onlyEmptyDirs(p: string): boolean {
	let st: fs.Stats;
	try {
		st = fs.lstatSync(p);
	} catch {
		return true;
	}
	if (!st.isDirectory()) return false;
	return fs.readdirSync(p).every((e) => onlyEmptyDirs(path.join(p, e)));
}

export async function isRegistered(git: Git, main: string, wt: string): Promise<boolean> {
	const r = await git(main, ["worktree", "list", "--porcelain"]);
	if (r.code !== 0) return true;
	return r.stdout.split("\n").some((l) => l.startsWith("worktree ") && norm(l.slice(9).trim()) === norm(wt));
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The set's branch when it exists, is not HEAD and is neither in the base branch nor the head of a merged PR; undefined otherwise. */
async function spareBranch(git: Git, gh: Gh, wt: string, baseRef: string, branch: string): Promise<{ branch: string; tip: string } | undefined> {
	const tip = await git(wt, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (tip.code !== 0 || !tip.stdout.trim()) return undefined;
	const sha = tip.stdout.trim();
	if (sha === (await git(wt, ["rev-parse", "HEAD"])).stdout.trim()) return undefined;
	if ((await git(wt, ["merge-base", "--is-ancestor", sha, baseRef])).code === 0) return undefined;
	if ((await mergedPrOf(git, gh, wt, branch, sha)).pr !== null) return undefined;
	return { branch, tip: sha };
}

/**
 * The state of a set: in-use (another live pi or an open Unity Editor) beats broken, broken beats has-work,
 * has-work beats delivered. `leftover` is a set with no repo folders and only empty folders. No fetch here; callers fetch first.
 */
export async function classifySet(env: WorkspaceEnv, name: string): Promise<SetState> {
	const { git, gh, cfg } = env;
	const set = setRootOf(cfg, name);
	const state = (kind: SetKind, reason: string, repos: RepoState[] = []): SetState => ({ kind, repos, reason });
	const holder = env.inUse(set);
	if (holder) return state("in-use", holder);
	const open = env.editors?.find((e) => inside(e, set));
	if (open) return state("in-use", `Unity Editor open for ${open}`);

	const repoDirs = repoDirsIn(set);
	const repoNames = repoDirs.map(baseName);
	const meta = readMeta(set);
	let strays: string[] = [];
	try {
		strays = fs.readdirSync(set, { withFileTypes: true }).filter((e) => !e.isDirectory() && e.name !== ".pi-set.json").map((e) => e.name);
	} catch {}
	const others = dirs(set).filter((d) => !repoNames.includes(d));
	if (!repoDirs.length) {
		if (!strays.length && others.every((d) => onlyEmptyDirs(path.join(set, d)))) return state("leftover", "no worktrees left, only empty folders");
		return state("broken", `${set} holds no worktree but is not empty`);
	}

	const branch = branchOf(cfg, name);
	const repos: RepoState[] = [];
	for (const wt of repoDirs) {
		const dir = baseName(wt);
		const main = await mainRepoOf(git, wt);
		if (!main) return state("broken", `${dir}: cannot find the original repo`, repos);
		if (!(await isRegistered(git, main, wt))) return state("broken", `${dir}: not registered in ${main} (git worktree prune)`, repos);
		const cur = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "?";
		const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
		const baseRef = await baseRefOf(git, wt);
		if (!baseRef) {
			// Without a base branch nothing is provably delivered: count what no remote has, so a discard still backs it up.
			const st = await git(wt, ["status", "--porcelain"]);
			const ahead = await git(wt, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
			const own = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 1;
			repos.push({ dir, wt, main, branch: cur, head, dirty: st.stdout.split(/\r?\n/).filter((l) => l.trim()).length, own, delivered: null, error: "no base branch to compare with" });
			continue;
		}
		const d = await deliveredState(git, gh, wt, baseRef, branch);
		const repo: RepoState = { dir, wt, main, branch: cur, head, dirty: d.dirty, own: d.own, delivered: d.delivered, pr: d.pr, ghError: d.ghError, error: d.error };
		repo.spare = await spareBranch(git, gh, wt, baseRef, branch);
		repos.push(repo);
	}
	const missing = (meta?.repos ?? []).filter((r) => !repoNames.includes(r.dir));
	if (missing.length) return state("broken", `${missing.map((r) => r.dir).join(", ")} listed in .pi-set.json but missing`, repos);

	const work = repos.filter((r) => r.error || r.dirty || r.delivered === null || r.spare);
	if (work.length) {
		const parts = work.map((r) => {
			const what = [
				r.dirty ? plural(r.dirty, "uncommitted change") : "",
				r.own ? plural(r.own, "unpushed commit") : "",
				r.spare ? `branch ${r.spare.branch} with commits not in HEAD` : "",
			].filter(Boolean).join(" and ");
			if (r.error) return `${r.dir}: ${r.error}${what ? ` (${what})` : ""}`;
			return `${r.dir} has ${what || "undelivered work"}${r.ghError && r.own ? " (gh unavailable, so a squash merge cannot be recognised)" : ""}`;
		});
		return state("has-work", parts.join("; "), repos);
	}
	return state("delivered", repos.map((r) => `${r.dir}: ${r.delivered === "pr" ? `PR #${r.pr} merged` : "in the base branch"}`).join("; "), repos);
}

export interface RemoveResult {
	text: string;
	error: boolean;
	/** True when the set folder is gone or only empty folders are left for the sweeper. */
	removed: boolean;
	leftovers: string[];
}

/**
 * The one removal path. Per repo: unlink links, `git worktree remove` (`--force` when `discard`), delete the set's branch.
 * Safe to run twice. A folder git could not delete because it is in use goes to `leftovers`.
 * `heads` (dir to HEAD, from `classifySet`) makes a non-discard removal refuse a repo that got new commits after it was checked.
 */
export async function removeWorkspace(env: { git: Git; cfg: WtConfig; inUse?: (setRoot: string) => string | null }, name: string, opts: { discard: boolean; heads?: Record<string, string> }): Promise<RemoveResult> {
	const { git, cfg } = env;
	const bad = checkName(name);
	if (bad) return { text: bad, error: true, removed: false, leftovers: [] };
	const set = setRootOf(cfg, name);
	const branch = branchOf(cfg, name);
	const done: string[] = [];
	const leftovers: string[] = [];
	const stop = (text: string): RemoveResult => ({ text: `Stopped at ${text}\nRemoved: ${done.join(", ") || "nothing"}`, error: true, removed: false, leftovers });
	const holder = env.inUse?.(set);
	if (holder) return stop(`${set}: it is ${holder} now; nothing was removed`);
	for (const wt of repoDirsIn(set)) {
		try {
			const main = await mainRepoOf(git, wt);
			if (!main) return stop(`${wt}: cannot find its main repo`);
			// Without a discard, a branch that holds commits HEAD does not have is kept (nothing proved them delivered).
			const tip = (await git(wt, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).stdout.trim();
			const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
			const seen = opts.heads?.[baseName(wt)];
			if (seen !== undefined && seen !== head) return stop(`${wt}: it has new commits since it was checked; run the command again`);
			const ahead = !opts.discard && tip !== "" && tip !== head && (await git(wt, ["merge-base", "--is-ancestor", tip, "HEAD"])).code !== 0;
			const removedLinks: string[] = [];
			for (const rel of new Set([...cfg.link, ...DEFAULT_LINK])) {
				const at = path.join(wt, rel);
				if (isLink(at)) {
					unlinkLink(at);
					removedLinks.push(rel);
				}
			}
			const rm = await git(main, opts.discard ? ["worktree", "remove", "--force", wt] : ["worktree", "remove", wt]);
			let inUse = false;
			if (rm.code !== 0) {
				if (!(await isRegistered(git, main, wt)) && onlyEmptyDirs(wt)) {
					inUse = true;
					leftovers.push(wt);
				} else {
					return stop(`${wt}: ${(rm.stderr || rm.stdout).trim()}${removedLinks.length ? ` (links already removed: ${removedLinks.join(", ")})` : ""}`);
				}
			}
			let kept = ahead ? ` (branch ${branch} kept: it has commits that were not in the worktree's HEAD)` : "";
			if (!ahead && (await git(main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0) {
				const br = await git(main, ["branch", "-D", branch]);
				if (br.code !== 0) kept = ` (branch ${branch} kept: ${(br.stderr || br.stdout).trim().split("\n")[0]})`;
			}
			done.push(`${wt}${inUse ? " (folder in use: deleted after pi exits)" : ""}${kept}`);
			// A later run must not see this repo as "listed but missing".
			const meta = readMeta(set);
			if (meta) writeMeta(set, { ...meta, repos: meta.repos.filter((r) => r.dir !== baseName(wt)) });
		} catch (e) {
			return stop(`${wt}: ${(e as Error).message}`);
		}
	}
	try {
		fs.rmSync(path.join(set, ".pi-set.json"), { force: true });
		if (fs.readdirSync(set).length === 0) fs.rmdirSync(set);
	} catch {
		// leave a folder we could not remove
	}
	if (fs.existsSync(set) && onlyEmptyDirs(set)) {
		leftovers.push(set);
		done.push(`${set} (deleted after pi exits)`);
	}
	return { text: `Removed set "${name}":\n${done.join("\n") || "nothing left to remove"}`, error: false, removed: !fs.existsSync(set) || leftovers.includes(set), leftovers };
}

/** Local time as yyyymmdd-hhmmss, the suffix of backup refs. */
export function stamp(d: Date): string {
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** What a discard would throw away: up to 10 commits and the changed-file count per repo with work. */
export async function discardPreview(git: Git, state: SetState): Promise<string> {
	const out: string[] = [];
	for (const r of state.repos) {
		if (!r.own && !r.dirty && !r.spare && !r.error) continue;
		out.push(`${r.dir}:`);
		if (r.error) out.push(`  ${r.error}; HEAD is backed up`);
		if (r.own) {
			const base = await baseRefOf(git, r.wt);
			const log = base ? (await git(r.wt, ["log", "--oneline", "-n", "11", `${base}..HEAD`])).stdout.split(/\r?\n/).filter(Boolean) : [];
			for (const l of log.slice(0, 10)) out.push(`  ${l}`);
			if (r.own > 10 || log.length > 10) out.push(`  ... ${r.own} commits in all`);
			else if (!log.length) out.push(`  ${plural(r.own, "commit")}`);
		}
		if (r.dirty) out.push(`  ${plural(r.dirty, "uncommitted change")}`);
		if (r.spare) out.push(`  branch ${r.spare.branch}: commits that HEAD does not have`);
	}
	return out.join("\n");
}

/** Refs that keep the commits (and the tracked changes) of a repo before it is discarded. Fails when a ref cannot be written. */
export async function backupRepo(git: Git, main: string, set: string, dir: string, ts: string, wt: string, st: Pick<RepoState, "own" | "dirty" | "spare" | "error">): Promise<{ lines: string[]; error?: string }> {
	const lines: string[] = [];
	const base = `refs/wt-backup/${set}/${dir}/${ts}`;
	if (st.own > 0 || st.error) {
		const r = await git(wt, ["update-ref", base, "HEAD"]);
		if (r.code !== 0) return { lines, error: `${dir}: could not write ${base}: ${(r.stderr || r.stdout).trim()}` };
		lines.push(`${dir}: commits kept in ${base}; restore: git -C ${main} switch -c <branch> ${base}`);
	}
	if (st.spare) {
		const r = await git(wt, ["update-ref", `${base}-branch`, st.spare.tip]);
		if (r.code !== 0) return { lines, error: `${dir}: could not write ${base}-branch: ${(r.stderr || r.stdout).trim()}` };
		lines.push(`${dir}: branch ${st.spare.branch} kept in ${base}-branch; restore: git -C ${main} switch -c <branch> ${base}-branch`);
	}
	if (st.dirty > 0) {
		const s = await git(wt, ["stash", "create"]);
		const sha = s.code === 0 ? s.stdout.trim() : "";
		if (sha) {
			const r = await git(wt, ["update-ref", `${base}-wip`, sha]);
			if (r.code !== 0) return { lines, error: `${dir}: could not write ${base}-wip: ${(r.stderr || r.stdout).trim()}` };
			lines.push(`${dir}: uncommitted changes kept in ${base}-wip; restore: git -C ${main} stash apply ${base}-wip`);
		}
	}
	return { lines };
}

/** Backs up every repo of a set; stops at the first failure so nothing is discarded without its backup. */
export async function backupSet(git: Git, set: string, state: SetState, ts: string): Promise<{ lines: string[]; error?: string }> {
	const lines: string[] = [];
	for (const r of state.repos) {
		if (!r.main || (!r.own && !r.dirty && !r.spare && !r.error)) continue;
		const b = await backupRepo(git, r.main, set, r.dir, ts, r.wt, r);
		lines.push(...b.lines);
		if (b.error) return { lines, error: b.error };
	}
	return { lines };
}

export interface FlowEnv extends WorkspaceEnv {
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
	stage: (text: string) => void;
	now: () => Date;
}

export interface RemoveOutcome {
	removed: boolean;
	error: boolean;
	text: string;
	leftovers: string[];
}

/**
 * The flow behind `/wt remove` and `/wt done`: fetch, classify, refuse in-use and broken sets, confirm, and for a set with work
 * ask to discard it, back it up first and remove it with `--force`. Nothing is removed without a UI.
 */
export async function removeWithConfirm(env: FlowEnv, name: string): Promise<RemoveOutcome> {
	const { git, cfg } = env;
	const fail = (text: string): RemoveOutcome => ({ removed: false, error: true, text, leftovers: [] });
	const bad = checkName(name);
	if (bad) return fail(bad);
	const set = setRootOf(cfg, name);
	if (!fs.existsSync(set)) return fail(`No worktree set "${name}" in ${cfg.root}`);
	if (!env.hasUI) return fail("/wt remove needs a UI to confirm.");
	env.stage(`checking ${name} (fetching)`);
	const warnings: string[] = [];
	for (const wt of repoDirsIn(set)) {
		const f = await git(wt, ["fetch", "--quiet"]);
		if (f.code !== 0) warnings.push(`${wt}: fetch failed (${(f.stderr || f.stdout).trim().split("\n")[0]})`);
	}
	const st = await classifySet(env, name);
	if (st.kind === "in-use") return fail(`Nothing removed: ${name} is ${st.reason}.`);
	if (st.kind === "broken") return fail(`Nothing removed: ${st.reason}.`);
	const notes = [...warnings, ...(env.editors ? [] : ["Unity Editor state unknown (unity status failed)"])];
	let backups: string[] = [];
	let discard = false;
	if (st.kind === "has-work") {
		const preview = await discardPreview(git, st);
		const keep = cfg.backupDays > 0 ? `Backups are kept ${cfg.backupDays} days.` : "Backups are kept until you delete them.";
		const ok = await env.confirm(`Discard work in "${name}"?`, [st.reason, preview, "Files git doesn't track are not backed up and will be lost.", keep, ...notes].filter(Boolean).join("\n"));
		if (!ok) return { removed: false, error: false, text: "Cancelled.", leftovers: [] };
		env.stage(`backing up ${name}`);
		const b = await backupSet(git, name, st, stamp(env.now()));
		if (b.error) return fail(`Nothing removed, backup failed: ${b.error}`);
		backups = b.lines;
		discard = true;
	} else if (st.kind === "delivered" || st.kind === "leftover") {
		const ok = await env.confirm(`Remove worktree set "${name}"?`, [...notes, st.reason, ...libraryLines(repoDirsIn(set))].join("\n"));
		if (!ok) return { removed: false, error: false, text: "Cancelled.", leftovers: [] };
	}
	env.stage(`removing ${name}`);
	const r = await removeWorkspace({ git, cfg, inUse: env.inUse }, name, { discard, heads: Object.fromEntries(st.repos.map((x) => [x.dir, x.head])) });
	return { removed: r.removed && !r.error, error: r.error, text: [r.text, ...backups].join("\n"), leftovers: r.leftovers };
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
