/**
 * `## Files` enforcement. A brief with a Files section limits the job to those globs (relative to each job repo's
 * root), plus the paths of the lead's snapshot commit (per repo: a path snapshotted in repo A is not allowed in repo B),
 * plus every approved `files` item. Dispatch writes `files.json` in the job dir; the worker guard and the judge step read it on every check, with the approvals
 * from job.json, so an approval applies at once. No Files section: no file, no limit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { matchesAny, normPath, splitScope } from "./glob.ts";
import type { Approval, Job } from "./job.ts";

export const FILES_GUARD = "files.json";

export interface FilesGuard {
	/** The brief's `## Files` globs. */
	files: string[];
	/** Snapshot paths (repo-relative) by repo key: the worker is never failed for files it did not change. `"*"` means every repo (an old flat-array guard). */
	snapshot: Record<string, string[]>;
}

/** The `snapshot` key that applies to every repo. */
export const ALL_REPOS = "*";

/** Writes the job's Files guard; removes it when the brief has no Files section (`files` undefined). */
export function writeFilesGuard(dir: string, files: string[] | undefined, snapshot: Record<string, string[]>): void {
	const file = path.join(dir, FILES_GUARD);
	if (!files) {
		fs.rmSync(file, { force: true });
		return;
	}
	const g: FilesGuard = { files, snapshot: Object.fromEntries(Object.entries(snapshot).map(([k, ps]) => [k, [...new Set(ps.map(normPath))]])) };
	fs.writeFileSync(file, JSON.stringify(g, null, 2));
}

/** The guard as written, or undefined without one. An old flat-array `snapshot` applies to every repo. */
export function readFilesGuard(dir: string): FilesGuard | undefined {
	try {
		const g = JSON.parse(fs.readFileSync(path.join(dir, FILES_GUARD), "utf8"));
		const snapshot: Record<string, string[]> = Array.isArray(g.snapshot)
			? { [ALL_REPOS]: g.snapshot.map(String) }
			: Object.fromEntries(Object.entries(g.snapshot ?? {}).map(([k, ps]) => [k, Array.isArray(ps) ? ps.map(String) : []]));
		return { files: Array.isArray(g.files) ? g.files.map(String) : [], snapshot };
	} catch {
		return undefined;
	}
}

/** The snapshot paths by repo key: each repo that has a lead's snapshot commit (`leadEdits`). */
export function snapshotByRepo(repos: Job["repos"]): Record<string, string[]> {
	return Object.fromEntries(repos.flatMap((r) => (r.leadEdits ? [[r.key, r.leadEdits.paths.map((p) => p.path)] as const] : [])));
}

const slash = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** The glob of a Files entry for repo `key`: a plain entry applies to every repo, a `<repo>: <glob>` entry only to the repo whose key or key's folder name is `<repo>`. */
function scopedGlob(entry: string, key: string | undefined): string[] {
	const s = splitScope(entry);
	if (s.repo === undefined) return [s.glob];
	if (key === undefined) return [];
	const k = slash(key);
	const r = slash(s.repo);
	return r === k || r === k.slice(k.lastIndexOf("/") + 1) ? [s.glob] : [];
}

/** The globs of one repo (`key`; undefined: the base list): Files, its snapshot paths, the `"*"` snapshot paths, the approved `files` items. Undefined without a guard. */
export function globsFor(g: FilesGuard | undefined, approvals: Approval[], key: string | undefined): string[] | undefined {
	if (!g) return undefined;
	return [...g.files.flatMap((f) => scopedGlob(f, key)), ...(key === undefined ? [] : (g.snapshot[key] ?? [])), ...(g.snapshot[ALL_REPOS] ?? []), ...approvals.filter((a) => a.category === "files").map((a) => a.item)];
}

/** The job's current globs for repo `key`; undefined when the job has no Files section. */
export function fileGlobs(dir: string, approvals: Approval[], key: string | undefined): string[] | undefined {
	return globsFor(readFilesGuard(dir), approvals, key);
}

/** The repo-relative paths that no glob covers. */
export function outsideFiles(paths: string[], globs: string[]): string[] {
	return [...new Set(paths.map(normPath))].filter((p) => !matchesAny(globs, p));
}

/** How a worker asks for more paths. */
export const FILES_HINT = 'ask_lead with approval {category: "files", item: "<glob>", why} to have it added to the job\'s Files';

/** Changed paths of a `git status --porcelain` text (renames give the new path; quotes removed). */
export function porcelainPaths(text: string): string[] {
	return text
		.split("\n")
		.filter((l) => l.length > 3)
		.map((l) => {
			const p = l.slice(3);
			const to = p.includes(" -> ") ? p.slice(p.indexOf(" -> ") + 4) : p;
			return to.replace(/^"(.*)"$/, "$1");
		});
}
