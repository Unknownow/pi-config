/** Repo keys for multi-repo runs. Pure. A key names a repo in `owns`/`forbids` (`api:src/**`); a glob with no key means the working repo. */

export interface Repo {
	key: string;
	top: string;
}

const KEYED = /^([a-z0-9._-]+):(.*)$/i;
const slash = (p: string) => p.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "");

/** Lowercased basename of a repo top level, characters outside [a-z0-9._-] replaced by `-`. */
export function repoKey(top: string): string {
	const base = slash(top).split("/").pop() ?? "";
	return base.toLowerCase().replace(/[^a-z0-9._-]/g, "-") || "repo";
}

/** The working repo first, then the added repos; duplicate tops are dropped; two tops with one key are an error. */
export function buildRepos(workingTop: string, addedTops: string[]): { repos: Repo[]; error?: string } {
	const ci = process.platform === "win32";
	const same = (a: string, b: string) => (ci ? slash(a).toLowerCase() === slash(b).toLowerCase() : slash(a) === slash(b));
	const repos: Repo[] = [];
	for (const t of [workingTop, ...addedTops]) {
		if (repos.some((r) => same(r.top, t))) continue;
		const key = repoKey(t);
		const clash = repos.find((r) => r.key === key);
		if (clash) return { repos, error: `repos ${clash.top} and ${slash(t)} would both get the key "${key}"; rename one folder or leave one out of /folders` };
		repos.push({ key, top: slash(t) });
	}
	return { repos };
}

/** `key:glob` or `glob` (the working repo) to the canonical form; an empty working key (legacy run) keeps globs bare. */
export function canonical(glob: string, repos: Repo[], workingKey: string): { value: string } | { error: string } {
	const g = glob.trim();
	const m = KEYED.exec(g);
	if (m && !/^[a-z]:[\\/]/i.test(g)) {
		const key = m[1].toLowerCase();
		if (!repos.some((r) => r.key === key)) return { error: `unknown repo "${m[1]}" in "${glob}" (repos: ${repos.map((r) => r.key).join(", ") || "none"})` };
		return { value: key === workingKey ? (workingKey ? `${key}:${m[2]}` : m[2]) : `${key}:${m[2]}` };
	}
	return { value: workingKey ? `${workingKey}:${g}` : g };
}

/** The key and the path of a canonical glob or file; key "" for a bare one. */
export function split(canon: string): { key: string; path: string } {
	const m = KEYED.exec(canon);
	return m ? { key: m[1].toLowerCase(), path: m[2] } : { key: "", path: canon };
}

/** Whether a glob starts with a repo key (`api:src/**`); a drive letter does not count. */
export function hasKeyPrefix(glob: string): boolean {
	return KEYED.test(glob.trim()) && !/^[a-z]:[\\/]/i.test(glob.trim());
}

/** The repo keys a package needs: the working key, the keys in its owns, and its extra repos. */
export function subRepos(pkg: { owns?: string[]; repos?: string[] }, workingKey: string): string[] {
	const keys = new Set<string>([workingKey]);
	for (const g of pkg.owns ?? []) keys.add(split(g).key || workingKey);
	for (const k of pkg.repos ?? []) keys.add(k.toLowerCase());
	return [...keys];
}

export interface Worktree {
	key: string;
	cwd: string;
	base?: string;
}

/** The worktrees of a sub: the recorded ones, or the single working one of a legacy sub. */
export function worktreesOf(sub: { cwd?: string; base?: string; worktrees?: Worktree[] }, run: { repos?: Repo[] }): Worktree[] {
	if (sub.worktrees?.length) return sub.worktrees;
	return sub.cwd ? [{ key: run.repos?.[0]?.key ?? "", cwd: sub.cwd, base: sub.base }] : [];
}

/** Of the added folders: plain folders (`keyOfFolder` gives null) and folders of the sub's repos stay; other repos go. */
export function foldersFor(sub: { repos?: string[] }, added: string[], keyOfFolder: (folder: string) => string | null): string[] {
	const need = new Set(sub.repos ?? []);
	return added.filter((f) => {
		const k = keyOfFolder(f);
		return k === null || need.has(k);
	});
}
