/** /wt clean: plan what is safe to remove (delivered sets, stale entries, merged branches, old backups), then do it. */

import * as path from "node:path";
import { baseRefOf, mainRepoOf, type Gh, type Git } from "./git-ops.ts";
import type { WtConfig } from "./config.ts";
import { branchOf, checkName } from "./layout.ts";
import { classifySet, listSets, removeWorkspace, repoDirsIn, type WorkspaceEnv } from "./manage.ts";
import { readMeta } from "./meta.ts";

export interface CleanEnv extends WorkspaceEnv {
	now: Date;
}

export type CleanItem =
	| { kind: "set"; name: string; why: string; heads: Record<string, string> }
	| { kind: "prune"; main: string }
	| { kind: "branch"; main: string; branch: string; tip: string; why: string }
	| { kind: "backup"; main: string; ref: string; tip: string };

export interface CleanPlan {
	remove: CleanItem[];
	/** "w3: game has 2 unpushed commits; /wt remove w3 to discard". */
	kept: string[];
	/** The original repos that were looked at. */
	mains: string[];
}

export interface RemoteItem {
	main: string;
	branch: string;
	/** Tip seen by the plan; the delete is refused when the remote branch moved on. */
	tip: string;
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

/** Runs `fn` over `items`, at most `n` at a time; results keep the input order. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}

/** The original repos behind every set (from .pi-set.json, else from each worktree) plus `extra` repo folders, deduplicated. */
export async function discoverMains(git: Git, cfg: WtConfig, extra: string[]): Promise<string[]> {
	const found = new Map<string, string>();
	const add = (m: string | null) => {
		if (m && !found.has(fold(m))) found.set(fold(m), m);
	};
	for (const name of listSets(cfg).filter((n) => !checkName(n))) {
		const set = `${cfg.root}/${name}`;
		const meta = readMeta(set);
		if (meta) for (const r of meta.repos) add(r.main);
		for (const wt of repoDirsIn(set)) add(await mainRepoOf(git, wt));
	}
	for (const e of extra) add(await mainRepoOf(git, e));
	return [...found.values()];
}

/** `git fetch --prune` once per repo, four at a time; returns one warning per failure. */
export async function fetchAll(git: Git, mains: string[]): Promise<string[]> {
	const res = await pool(mains, 4, async (m) => ({ m, r: await git(m, ["fetch", "--prune", "--quiet"]) }));
	return res.filter((x) => x.r.code !== 0).map((x) => `${x.m}: fetch failed (${(x.r.stderr || x.r.stdout).trim().split("\n")[0]}); using the last known state`);
}

/** Branch names checked out in any worktree of `main`, and the entries git marks prunable. */
async function worktreeInfo(git: Git, main: string): Promise<{ checkedOut: Set<string>; prunable: number }> {
	const r = await git(main, ["worktree", "list", "--porcelain"]);
	const checkedOut = new Set<string>();
	let prunable = 0;
	for (const l of r.code === 0 ? r.stdout.split(/\r?\n/) : []) {
		if (l.startsWith("branch refs/heads/")) checkedOut.add(l.slice("branch refs/heads/".length).trim());
		if (l.startsWith("prunable")) prunable++;
	}
	return { checkedOut, prunable };
}

/** A for-each-ref pattern for all refs below `dir` that start with `prefix`: a literal folder prefix when it ends in a slash (a `*` would not cross slashes). */
const pattern = (dir: string, prefix: string) => (prefix.endsWith("/") ? `${dir}${prefix}` : `${dir}${prefix}*`);

async function refs(git: Git, main: string, pattern: string): Promise<{ ref: string; tip: string }[]> {
	const r = await git(main, ["for-each-ref", "--format=%(refname) %(objectname)", pattern]);
	if (r.code !== 0) return [];
	return r.stdout.split(/\r?\n/).filter(Boolean).map((l) => {
		const [ref, tip] = l.trim().split(" ");
		return { ref, tip };
	});
}

/** Whether a merged PR of `branch` has `tip` as its head commit (gh failures count as no). */
async function mergedHead(gh: Gh, main: string, branch: string, tip: string): Promise<boolean> {
	const r = await gh(main, ["pr", "list", "--head", branch, "--state", "merged", "--json", "number,headRefOid", "--limit", "20"]);
	if (r.code !== 0) return false;
	try {
		return (JSON.parse(r.stdout) as { headRefOid: string }[]).some((p) => p.headRefOid === tip);
	} catch {
		return false;
	}
}

/** Local time `yyyymmdd-hhmmss` (optionally followed by `-wip` or `-branch`) at the end of a backup ref; null when it has none. */
export function backupTime(ref: string): Date | null {
	const m = /\/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(-wip|-branch)?$/.exec(ref);
	return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : null;
}

/** Sorts every set and every original repo into "will remove" and "kept". Fetch first (`fetchAll`). */
export async function planClean(env: CleanEnv, mains: string[]): Promise<CleanPlan> {
	const { git, cfg } = env;
	const plan: CleanPlan = { remove: [], kept: [], mains };
	const names = listSets(cfg).filter((n) => !checkName(n));
	const states = await pool(names, 4, async (name) => ({ name, st: await classifySet(env, name) }));
	for (const { name, st } of states) {
		if (st.kind === "delivered" || st.kind === "leftover") plan.remove.push({ kind: "set", name, why: st.kind === "leftover" ? "nothing left in it" : st.reason, heads: Object.fromEntries(st.repos.map((r) => [r.dir, r.head])) });
		else plan.kept.push(`${name}: ${st.reason}${st.kind === "has-work" ? `; /wt remove ${name} to discard` : ""}`);
	}
	const maxAge = cfg.backupDays * 86400000;
	for (const main of mains) {
		const info = await worktreeInfo(git, main);
		if (info.prunable > 0) plan.remove.push({ kind: "prune", main });
		const baseRef = await baseRefOf(git, main);
		for (const { ref, tip } of await refs(git, main, pattern("refs/heads/", cfg.branchPrefix))) {
			const branch = ref.slice("refs/heads/".length);
			if (!branch.startsWith(cfg.branchPrefix) || info.checkedOut.has(branch)) continue;
			// the set removal deletes its own branch
			if (plan.remove.some((i) => i.kind === "set" && branchOf(cfg, i.name) === branch)) continue;
			const inBase = baseRef ? (await git(main, ["merge-base", "--is-ancestor", tip, baseRef])).code === 0 : false;
			if (inBase) plan.remove.push({ kind: "branch", main, branch, tip, why: "in the base branch" });
			else if (await mergedHead(env.gh, main, branch, tip)) plan.remove.push({ kind: "branch", main, branch, tip, why: "merged PR" });
		}
		if (maxAge > 0) {
			for (const { ref, tip } of await refs(git, main, "refs/wt-backup/")) {
				const t = backupTime(ref);
				if (t && env.now.getTime() - t.getTime() > maxAge) plan.remove.push({ kind: "backup", main, ref, tip });
			}
		}
	}
	return plan;
}

export function describeItem(i: CleanItem): string {
	switch (i.kind) {
		case "set":
			return `set ${i.name} (${i.why})`;
		case "prune":
			return `stale worktree entries in ${i.main} (git worktree prune)`;
		case "branch":
			return `branch ${i.branch} in ${path.basename(i.main)} (${i.why})`;
		case "backup":
			return `backup ${i.ref} in ${path.basename(i.main)} (older than the keep time)`;
	}
}

export interface CleanResult {
	done: string[];
	failed: string[];
	leftovers: string[];
}

/** Does the items one by one and goes on after a failure. A branch or backup ref is deleted only while it still points where the plan saw it. */
export async function runClean(env: { git: Git; cfg: WtConfig; inUse?: (setRoot: string) => string | null }, items: CleanItem[]): Promise<CleanResult> {
	const { git } = env;
	const out: CleanResult = { done: [], failed: [], leftovers: [] };
	for (const i of items) {
		try {
			if (i.kind === "set") {
				const r = await removeWorkspace(env, i.name, { discard: false, heads: i.heads });
				(r.error ? out.failed : out.done).push(r.error ? `set ${i.name}: ${r.text}` : describeItem(i));
				out.leftovers.push(...r.leftovers);
				continue;
			}
			const r =
				i.kind === "prune"
					? await git(i.main, ["worktree", "prune"])
					: await git(i.main, ["update-ref", "-d", i.kind === "branch" ? `refs/heads/${i.branch}` : i.ref, i.tip]);
			if (r.code === 0 && i.kind === "branch") await git(i.main, ["config", "--remove-section", `branch.${i.branch}`]);
			if (r.code === 0) out.done.push(describeItem(i));
			else out.failed.push(`${describeItem(i)}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
		} catch (e) {
			out.failed.push(`${describeItem(i)}: ${(e as Error).message}`);
		}
	}
	return out;
}

export type CleanStatus = "nothing" | "no-ui" | "cancelled" | "ran";

/** Shows the plan, asks once, and runs it. Without a UI (`hasUI` false) nothing is asked and nothing is removed. */
export async function cleanFlow(
	env: { git: Git; cfg: WtConfig; inUse?: (setRoot: string) => string | null },
	plan: CleanPlan,
	warnings: string[],
	ui: { hasUI: boolean; confirm: (title: string, message: string) => Promise<boolean>; stage: (text: string) => void },
): Promise<{ status: CleanStatus; text: string; leftovers: string[] }> {
	const report = (head: string, items: string[]) => (items.length ? [head, ...items.map((i) => `  ${i}`)] : []);
	const kept = [...report("Kept:", plan.kept), ...report("Warnings:", warnings)];
	if (!plan.remove.length) return { status: "nothing", text: ["Nothing to remove.", ...kept].join("\n"), leftovers: [] };
	const preview = [...report("Will remove:", plan.remove.map(describeItem)), ...kept];
	if (!ui.hasUI) return { status: "no-ui", text: [...preview, "No UI to confirm; nothing was removed."].join("\n"), leftovers: [] };
	if (!(await ui.confirm("Clean up worktrees?", preview.join("\n")))) return { status: "cancelled", text: "Cancelled.", leftovers: [] };
	ui.stage("cleaning up");
	const res = await runClean(env, plan.remove);
	return { status: "ran", text: [...report("Removed:", res.done), ...report("Failed:", res.failed), ...kept].join("\n"), leftovers: res.leftovers };
}

/** Remote branches `origin/<prefix>*` whose tip is the head of a merged PR and which no worktree has checked out. */
export async function remoteCandidates(env: CleanEnv, mains: string[]): Promise<RemoteItem[]> {
	const out: RemoteItem[] = [];
	for (const main of mains) {
		const { checkedOut } = await worktreeInfo(env.git, main);
		for (const { ref, tip } of await refs(env.git, main, pattern("refs/remotes/origin/", env.cfg.branchPrefix))) {
			const branch = ref.slice("refs/remotes/origin/".length);
			if (!branch.startsWith(env.cfg.branchPrefix) || checkedOut.has(branch)) continue;
			if (await mergedHead(env.gh, main, branch, tip)) out.push({ main, branch, tip });
		}
	}
	return out;
}

/** `git push origin --delete <branch>` per item (no force flag), only while `ls-remote` still shows the planned tip; returns report lines. */
export async function deleteRemotes(git: Git, items: RemoteItem[]): Promise<{ done: string[]; failed: string[] }> {
	const res = { done: [] as string[], failed: [] as string[] };
	for (const i of items) {
		const where = `origin/${i.branch} in ${path.basename(i.main)}`;
		const now = await git(i.main, ["ls-remote", "--heads", "origin", `refs/heads/${i.branch}`]);
		if (now.code !== 0) {
			res.failed.push(`${where}: ${(now.stderr || now.stdout).trim().split("\n")[0]}`);
			continue;
		}
		const tip = now.stdout.trim().split(/\s+/)[0] ?? "";
		if (tip !== i.tip) {
			res.failed.push(`${where}: ${tip ? "moved since the check; kept" : "no longer on origin"}`);
			continue;
		}
		const r = await git(i.main, ["push", "origin", "--delete", i.branch]);
		if (r.code === 0) res.done.push(`origin/${i.branch} in ${path.basename(i.main)}`);
		else res.failed.push(`origin/${i.branch} in ${path.basename(i.main)}: ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
	}
	return res;
}
