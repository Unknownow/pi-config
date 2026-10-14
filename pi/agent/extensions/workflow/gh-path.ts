/**
 * Pure helpers for finding the GitHub CLI when it is installed but not on PATH. No I/O, so
 * gh-path.test.ts covers them.
 */

import * as path from "node:path";

type Env = Record<string, string | undefined>;

/** Where gh.exe is usually installed on Windows, most likely first; none elsewhere. */
export function ghCandidates(env: Env, platform: string): string[] {
	if (platform !== "win32") return [];
	const out: string[] = [];
	const add = (root: string | undefined, ...rest: string[]) => {
		if (!root) return;
		const p = path.win32.join(root, ...rest, "GitHub CLI", "gh.exe");
		if (!out.includes(p)) out.push(p);
	};
	add(env.ProgramFiles ?? "C:\\Program Files");
	add(env.ProgramW6432);
	add(env.LOCALAPPDATA, "Programs");
	return out;
}

/** The PATH variable's key in `env` and its value with `dir` in front (unchanged when `dir` is already listed). */
export function withPathDir(env: Env, dir: string, delimiter: string): { key: string; value: string } {
	const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
	const old = env[key] ?? "";
	const listed = old.split(delimiter).some((e) => e.toLowerCase() === dir.toLowerCase());
	return { key, value: listed ? old : old ? dir + delimiter + old : dir };
}
