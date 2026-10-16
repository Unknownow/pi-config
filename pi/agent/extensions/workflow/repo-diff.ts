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
