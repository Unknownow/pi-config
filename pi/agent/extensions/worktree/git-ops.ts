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
/** Runs the gh CLI in a folder; same shape as `Git`. */
export type Gh = (cwd: string, args: string[]) => Promise<GitResult>;

const LOCK_RE = /cannot lock ref|Unable to create '.*\.lock'|index\.lock/;

/** A `Git` that retries a call refused for a git lock held by another process: after 1 s, then after 3 s, then returns the last result. */
export function withLockRetry(git: Git, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Git {
	return async (cwd, args) => {
		let r = await git(cwd, args);
		for (const wait of [1000, 3000]) {
			if (r.code === 0 || !LOCK_RE.test(r.stderr)) break;
			await sleep(wait);
			r = await git(cwd, args);
		}
		return r;
	};
}

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

export interface RepoStatus {
	branch: string;
	dirty: number;
	upstream: string | null;
	ahead: number;
	behind: number;
	/** Commits not pushed: ahead of the upstream, or of the base ref when there is no upstream. */
	unpushed: number;
	/** Set when a git call failed, so the counts cannot be trusted. */
	error?: string;
}

const count = (r: GitResult) => (r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) || 0 : 0);

/** The remote and base ref of an existing worktree (no fetch); null when the repo has no usable remote branch. */
export async function baseOf(git: Git, wt: string): Promise<{ remote: string; ref: string } | null> {
	const remotes = (await git(wt, ["remote"])).stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : remotes[0];
	const ref = remote ? await findBase(git, wt, remote) : null;
	return remote && ref ? { remote, ref } : null;
}

/** The base ref of an existing worktree (no fetch); null when the repo has no usable remote branch. */
export async function baseRefOf(git: Git, wt: string): Promise<string | null> {
	return (await baseOf(git, wt))?.ref ?? null;
}

export async function repoStatus(git: Git, wt: string, baseRef: string | null): Promise<RepoStatus> {
	const branch = (await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "?";
	const stat = await git(wt, ["status", "--porcelain"]);
	const dirty = stat.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
	const error = stat.code === 0 ? undefined : `git status failed: ${firstLine(stat)}`;
	const up = await git(wt, ["rev-parse", "--abbrev-ref", "@{u}"]);
	const upstream = up.code === 0 && up.stdout.trim() ? up.stdout.trim() : null;
	if (upstream) {
		const lr = await git(wt, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
		const [behind = 0, ahead = 0] = lr.code === 0 ? lr.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0) : [];
		return { branch, dirty, upstream, ahead, behind, unpushed: ahead, error: error ?? (lr.code === 0 ? undefined : `rev-list failed: ${firstLine(lr)}`) };
	}
	const cnt = baseRef ? await git(wt, ["rev-list", "--count", `${baseRef}..HEAD`]) : null;
	const noBase = !cnt || cnt.code !== 0 ? "cannot tell whether commits are pushed" : undefined;
	return { branch, dirty, upstream: null, ahead: 0, behind: 0, unpushed: cnt ? count(cnt) : 0, error: error ?? noBase };
}

export interface DeliveredState {
	/** "base": HEAD is contained in the base ref; "pr": a merged PR of the branch has HEAD as its head commit. */
	delivered: "base" | "pr" | null;
	pr?: number;
	/** Commits in HEAD that the base ref does not have. */
	own: number;
	dirty: number;
	ghError?: string;
	/** Set when a git call failed, so the counts cannot be trusted. */
	error?: string;
}

/** The merged PR whose head commit is HEAD (covers squash and rebase merges done on GitHub); null when none. */
export async function mergedPrOf(git: Git, gh: Gh, wt: string, branch: string, sha?: string): Promise<{ pr: number | null; ghError?: string }> {
	const head = sha ?? (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
	const r = await gh(wt, ["pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid", "--limit", "20"]);
	if (r.code !== 0 || !head) return { pr: null, ghError: "gh unavailable" };
	try {
		const list = JSON.parse(r.stdout) as { number: number; headRefOid: string }[];
		const hit = list.find((p) => p.headRefOid === head);
		return { pr: hit ? hit.number : null };
	} catch {
		return { pr: null, ghError: "gh unavailable" };
	}
}

/** Whether the work in a worktree is already in the base branch: by ancestry, else by a merged PR (gh). */
export async function deliveredState(git: Git, gh: Gh, wt: string, baseRef: string, branch: string): Promise<DeliveredState> {
	const stat = await git(wt, ["status", "--porcelain"]);
	const dirty = stat.stdout.split(/\r?\n/).filter((l) => l.trim()).length;
	const ahead = await git(wt, ["rev-list", "--count", `${baseRef}..HEAD`]);
	const own = count(ahead);
	if (stat.code !== 0 || ahead.code !== 0) return { delivered: null, own, dirty, error: `git ${stat.code !== 0 ? "status" : "rev-list"} failed: ${firstLine(stat.code !== 0 ? stat : ahead)}` };
	if (dirty > 0) return { delivered: null, own, dirty };
	if ((await git(wt, ["merge-base", "--is-ancestor", "HEAD", baseRef])).code === 0) return { delivered: "base", own, dirty };
	const { pr, ghError } = await mergedPrOf(git, gh, wt, branch);
	return pr !== null ? { delivered: "pr", pr, own, dirty } : { delivered: null, own, dirty, ghError };
}

export interface RemoveChecks {
	problems: string[];
	warnings: string[];
}

/** Every reason /wt remove must refuse, for all worktrees; fetches first so "unpushed" is current. */
export async function removeChecks(git: Git, wts: string[]): Promise<RemoveChecks> {
	const out: RemoveChecks = { problems: [], warnings: [] };
	for (const wt of wts) {
		const fetch = await git(wt, ["fetch", "--quiet"]);
		if (fetch.code !== 0) out.warnings.push(`${wt}: fetch failed (${firstLine(fetch)})`);
		const st = await repoStatus(git, wt, await baseRefOf(git, wt));
		if (st.error) out.problems.push(`${wt}: ${st.error}`);
		if (st.dirty) out.problems.push(`${wt}: ${st.dirty} uncommitted change(s)`);
		if (st.unpushed) {
			const where = st.upstream ? `upstream ${st.upstream}` : "the base branch (no upstream)";
			out.problems.push(`${wt}: ${st.unpushed} commit(s) not pushed to ${where}`);
		}
	}
	return out;
}

/** The repo a worktree belongs to: the parent of its absolute git common dir. */
export async function mainRepoOf(git: Git, wt: string): Promise<string | null> {
	const r = await git(wt, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return r.code === 0 ? slash(path.dirname(r.stdout.trim())) : null;
}
