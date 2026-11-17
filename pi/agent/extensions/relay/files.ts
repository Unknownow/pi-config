/**
 * `## Files` enforcement. A brief with a Files section limits the job to those globs (relative to each job repo's
 * root), plus the paths of the lead's snapshot commit, plus every approved `files` item. Dispatch writes
 * `files.json` in the job dir; the worker guard and the judge step read it on every check, with the approvals
 * from job.json, so an approval applies at once. No Files section: no file, no limit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { matchesAny, normPath } from "./glob.ts";
import type { Approval } from "./job.ts";

export const FILES_GUARD = "files.json";

export interface FilesGuard {
	/** The brief's `## Files` globs. */
	files: string[];
	/** Paths of the lead's snapshot commit (repo-relative): the worker is never failed for files it did not change. */
	snapshot: string[];
}

/** Writes the job's Files guard; removes it when the brief has no Files section (`files` undefined). */
export function writeFilesGuard(dir: string, files: string[] | undefined, snapshot: string[]): void {
	const file = path.join(dir, FILES_GUARD);
	if (!files) {
		fs.rmSync(file, { force: true });
		return;
	}
	const g: FilesGuard = { files, snapshot: [...new Set(snapshot.map(normPath))] };
	fs.writeFileSync(file, JSON.stringify(g, null, 2));
}

/** The guard as written, or undefined without one. */
export function readFilesGuard(dir: string): FilesGuard | undefined {
	try {
		const g = JSON.parse(fs.readFileSync(path.join(dir, FILES_GUARD), "utf8"));
		return { files: Array.isArray(g.files) ? g.files.map(String) : [], snapshot: Array.isArray(g.snapshot) ? g.snapshot.map(String) : [] };
	} catch {
		return undefined;
	}
}

/** The job's current globs (Files, snapshot paths, approved `files` items); undefined when the job has no Files section. */
export function fileGlobs(dir: string, approvals: Approval[]): string[] | undefined {
	const g = readFilesGuard(dir);
	if (!g) return undefined;
	return [...g.files, ...g.snapshot, ...approvals.filter((a) => a.category === "files").map((a) => a.item)];
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
