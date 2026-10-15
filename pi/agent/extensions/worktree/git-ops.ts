/** Every git step of /wt, behind an injected runner so tests can use a fake. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WtConfig } from "./config.ts";
import { isLink, unlinkLink } from "./files.ts";
import { baseName, branchOf, setRootOf, targetOf } from "./layout.ts";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type Git = (cwd: string, args: string[]) => Promise<GitResult>;

export interface RepoInfo {
	top: string;
	remote: string;
	baseRef: string;
	mainRepo: string;
	warning?: string;
}

export interface Planned {
	info: RepoInfo;
	target: string;
}

const slash = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const firstLine = (r: GitResult) => (r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? "";

export async function repoInfo(git: Git, dir: string): Promise<RepoInfo | { error: string }> {
	const topR = await git(dir, ["rev-parse", "--show-toplevel"]);
	if (topR.code !== 0) return { error: `${dir}: not a git repo` };
	const top = slash(topR.stdout.trim());
	const remotes = (await git(top, ["remote"])).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : remotes[0];
	if (!remote) return { error: `${top}: no git remote` };
	const fetch = await git(top, ["fetch", remote, "--quiet"]);
	const warning = fetch.code === 0 ? undefined : `${top}: fetch failed (${firstLine(fetch)}), using the last known ${remote}`;
	const baseRef = await findBase(git, top, remote);
	if (!baseRef) return { error: `${top}: no ${remote}/HEAD, ${remote}/main or ${remote}/master` };
	const common = await git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const mainRepo = common.code === 0 ? slash(path.dirname(common.stdout.trim())) : top;
	return { top, remote, baseRef, mainRepo, warning };
}

async function findBase(git: Git, top: string, remote: string): Promise<string | null> {
	const head = await git(top, ["rev-parse", "--abbrev-ref", `${remote}/HEAD`]);
	const name = head.stdout.trim();
	if (head.code === 0 && name && name !== `${remote}/HEAD`) return name;
	for (const b of ["main", "master"]) {
		if ((await git(top, ["rev-parse", "--verify", "--quiet", `${remote}/${b}`])).code === 0) return `${remote}/${b}`;
	}
	return null;
}

export interface PreflightResult {
	plan: Planned[];
	errors: string[];
	warnings: string[];
}

/** All checks before anything is created; returns every problem found, not only the first. */
export async function preflight(git: Git, dirs: string[], cfg: WtConfig, name: string): Promise<PreflightResult> {
	const res: PreflightResult = { plan: [], errors: [], warnings: [] };
	const branch = branchOf(cfg, name);
	const names = new Map<string, string>();
	const bad = await git(process.cwd(), ["check-ref-format", "--branch", branch]);
	if (bad.code !== 0) res.errors.push(`"${branch}" is not a valid branch name`);
	for (const dir of dirs) {
		const info = await repoInfo(git, dir);
		if ("error" in info) {
			res.errors.push(info.error);
			continue;
		}
		if (info.warning) res.warnings.push(info.warning);
		const base = baseName(info.top).toLowerCase();
		if (names.has(base)) res.errors.push(`${info.top} and ${names.get(base)} have the same folder name "${base}"`);
		names.set(base, info.top);
		const target = targetOf(cfg, name, info.top);
		if (fs.existsSync(target)) res.errors.push(`${target} already exists`);
		const ref = await git(info.top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
		if (ref.code === 0) res.errors.push(`${info.top}: branch ${branch} already exists`);
		res.plan.push({ info, target });
	}
	return res;
}

/** Create the worktrees in order; throws on the first failure, after reporting each created one. */
export async function createAll(git: Git, plan: Planned[], branch: string, onCreated: (p: Planned) => void): Promise<void> {
	for (const p of plan) {
		const r = await git(p.info.top, ["worktree", "add", "--no-track", "-b", branch, p.target, p.info.baseRef]);
		if (r.code !== 0) {
			// `-b` creates the branch before the worktree; preflight proved it did not exist, so this run owns it.
			const left = await git(p.info.top, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
			if (left.code === 0) await git(p.info.top, ["branch", "-D", branch]);
			throw new Error(`${p.info.top}: worktree add failed: ${firstLine(r)}`);
		}
		onCreated(p);
	}
}

/**
 * A link is not a directory to git, so a pattern such as `.pi/git/` does not ignore it. Add an anchored
 * entry to the repo's info/exclude for each linked path that git does not already ignore.
 */
export async function excludeLinks(git: Git, wt: string, rels: string[]): Promise<string[]> {
	const added: string[] = [];
	let exclude: string | null = null;
	for (const rel of rels) {
		if ((await git(wt, ["check-ignore", "-q", rel])).code === 0) continue;
		if (!exclude) {
			const common = await git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
			if (common.code !== 0) throw new Error(`${wt}: cannot find the git dir: ${firstLine(common)}`);
			exclude = path.join(common.stdout.trim(), "info", "exclude");
		}
		const line = `/${rel}`;
		const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
		if (current.split("\n").map((l) => l.trim()).includes(line)) continue;
		fs.mkdirSync(path.dirname(exclude), { recursive: true });
		fs.appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
		added.push(rel);
	}
	return added;
}

/** Undo a failed run: only worktrees and branches this run created. Links go first, never their targets. */
export async function rollback(git: Git, created: Planned[], cfg: WtConfig, name: string): Promise<string[]> {
	const branch = branchOf(cfg, name);
	const problems: string[] = [];
	for (const p of [...created].reverse()) {
		try {
			for (const rel of cfg.link) {
				const at = path.join(p.target, rel);
				if (isLink(at)) unlinkLink(at);
			}
		} catch (e) {
			problems.push(`${p.target}: ${(e as Error).message}`);
			continue;
		}
		const rm = await git(p.info.top, ["worktree", "remove", "--force", p.target]);
		if (rm.code !== 0) problems.push(`${p.target}: ${firstLine(rm)}`);
		const br = await git(p.info.top, ["branch", "-D", branch]);
		if (br.code !== 0) problems.push(`${p.info.top}: branch ${branch}: ${firstLine(br)}`);
	}
	const set = setRootOf(cfg, name);
	try {
		if (fs.existsSync(set) && fs.readdirSync(set).length === 0) fs.rmdirSync(set);
	} catch {
		// leave a folder we could not remove; the report mentions the other problems
	}
	return problems;
}
