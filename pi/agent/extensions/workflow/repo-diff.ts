import * as fs from "node:fs";
import * as path from "node:path";

export interface RepoDiff {
	full: string;
	files: number;
	names: string[];
	checkNames: string[];
	/** `names` with every path relative to the repo root. */
	rootNames: string[];
}

export type RunGit = (cwd: string, ...args: string[]) => Promise<{ code: number; stdout: string }>;

/** The entries of `changed` that no finding cites as `path:line` (paths compared with `/`); all of them when in doubt. */
export function uncitedFiles(findings: string, changed: string[]): string[] {
	const text = findings.replace(/\\/g, "/");
	return changed.filter((name) => {
		const esc = name.replace(/\\/g, "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return !new RegExp(`${esc}:\\d`).test(text);
	});
}

/**
 * The names `uncitedFiles` looks for, one per changed file. Findings cite paths relative to their repo, so a path
 * changed in one repo stays bare (it matches `rel:` and `repo/rel:`); a path changed in several repos gets its repo
 * folder in front, so a finding about one repo doesn't count for the other.
 */
export function citeNames(parts: { root: string; names: string[] }[], multi: boolean): string[] {
	if (!multi) return parts.flatMap((p) => p.names);
	const count = new Map<string, number>();
	for (const p of parts) for (const n of p.names) count.set(n, (count.get(n) ?? 0) + 1);
	return parts.flatMap((p) => p.names.map((n) => (count.get(n)! > 1 ? `${path.basename(p.root)}/${n}` : n)));
}

/** Whether a passing re-review gets the final full review: always when `newFilesOnly` is off, else only if a changed file is uncited. */
export function needsFinalFullReview(newFilesOnly: boolean, findings: string, changed: string[]): boolean {
	return !newFilesOnly || uncitedFiles(findings, changed).length > 0;
}

/** Tracked changes against `base` plus untracked files of one repo (untruncated), or null outside a git work tree. */
export async function collectRepoDiff(git: RunGit, cwd: string, base = "HEAD"): Promise<RepoDiff | null> {
	const inside = await git(cwd, "rev-parse", "--is-inside-work-tree", "--show-prefix");
	if (inside.code !== 0) return null;
	const prefix = (inside.stdout.split("\n")[1] ?? "").replace(/[\r\n]/g, "");
	const [tracked, current, rootList] = await Promise.all([
		git(cwd, "diff", "--no-color", base).then((r) => (r.code !== 0 ? git(cwd, "diff", "--no-color") : r)), // no commits yet
		git(cwd, "diff", "--name-only", "-z", "--diff-filter=d", base).then((r) => (r.code !== 0 ? git(cwd, "diff", "--name-only", "-z", "--diff-filter=d") : r)),
		git(cwd, "ls-files", "--others", "--exclude-standard", "--full-name", "-z"),
	]);
	const parts = [tracked.stdout];
	let files = (tracked.stdout.match(/^diff --git /gm) ?? []).length;

	// Root-relative names; `ls-files` from a subfolder lists only files below it.
	const rootUntracked = rootList.stdout.split("\0").filter(Boolean);
	const untracked = rootUntracked.map((n) => (prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n));
	for (const rel of untracked) {
		files++;
		try {
			const buf = fs.readFileSync(path.join(cwd, rel));
			if (buf.length > 200_000 || buf.includes(0)) {
				parts.push(`\n=== new file: ${rel} (${buf.length} bytes, binary or too large, not shown) ===\n`);
				continue;
			}
			const numbered = buf
				.toString("utf8")
				.split("\n")
				.map((l, i) => `+${i + 1}: ${l}`)
				.join("\n");
			parts.push(`\n=== new file: ${rel} ===\n${numbered}\n`);
		} catch {
			parts.push(`\n=== new file: ${rel} (unreadable) ===\n`);
		}
	}

	const full = parts.join("").trim();
	const trackedNames = [...tracked.stdout.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]);
	const names = [...trackedNames, ...untracked];
	const checkNames = [...current.stdout.split("\0").filter(Boolean), ...untracked];
	return { full, files, names, checkNames, rootNames: [...trackedNames, ...rootUntracked] };
}
