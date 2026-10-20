/**
 * Pure helpers for flows that span several git repos: path keys, the combined diff format, and
 * which repo a shell command targets. No I/O, so repos.test.ts covers them.
 */

import * as path from "node:path";
import { KEYWORDS, parseCommands } from "./readonly-bash.ts";

/** A comparable form of a path: forward slashes, no trailing slash, lowercase and `D:/` style on Windows. */
export function repoKey(p: string, platform: NodeJS.Platform = process.platform): string {
	let k = p.trim().replace(/\\/g, "/");
	const win = platform === "win32";
	if (win) {
		const m = k.match(/^\/([a-zA-Z])(\/|$)/);
		if (m) k = `${m[1].toUpperCase()}:/${k.slice(m[0].length)}`;
	}
	if (k.length > 1 && k.endsWith("/") && !/^[a-zA-Z]:\/$/.test(k)) k = k.replace(/\/+$/, "") || "/";
	return win ? k.toLowerCase() : k;
}

/** `roots` without repeats (by key), first occurrence kept, original strings returned. */
export function uniqueRoots(roots: string[], platform: NodeJS.Platform = process.platform): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const r of roots) {
		const k = repoKey(r, platform);
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(r);
	}
	return out;
}

export function repoHeader(root: string): string {
	return `=== repo: ${root} ===`;
}

/** Each non-empty part under its repo header, parts separated by a blank line. */
export function combineRepoTexts(parts: { root: string; text: string }[]): string {
	return parts
		.filter((p) => p.text.trim().length > 0)
		.map((p) => `${repoHeader(p.root)}\n${p.text}`)
		.join("\n\n");
}

const SAFE_WORD = /^[A-Za-z0-9_./:@=+,-]+$/;

function quoteWord(w: string): string {
	return SAFE_WORD.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
}

/** PowerShell has no `\` escapes, so there `\` is a path separator. */
export function shellText(text: string, powershell: boolean): string {
	return powershell ? text.replace(/\\/g, "/") : text;
}

/** The texts the push guard checks for an unattributed command: `\` as a separator, plus as written for PowerShell (a `bash -c` script keeps bash escapes). */
export function fallbackTexts(text: string, powershell: boolean): string[] {
	const converted = shellText(text, powershell);
	return powershell && converted !== text ? [converted, text] : [converted];
}

/**
 * Splits shell text by the repo each command runs in: the one named by `git -C <p>` (that command only)
 * or by the last `cd`/`pushd`/`Set-Location`, else `undefined` (the working folder's). Commands are
 * rebuilt from their words, quoted so they parse the same again; groups keep order of first appearance.
 * With `powershell`, `\` is read as a path separator.
 */
export function repoTexts(rawText: string, roots: string[], cwd: string, platform: NodeJS.Platform = process.platform, opts: { powershell?: boolean } = {}): { root: string | undefined; text: string }[] {
	const text = shellText(rawText, !!opts.powershell);
	const cwdKey = repoKey(cwd, platform);
	const resolve = (arg: string, base: string): string => {
		if (!arg || arg === "-" || /[$`~]/.test(arg)) return cwdKey;
		let k = repoKey(arg, platform);
		if (!(k.startsWith("/") || /^[a-zA-Z]:\//.test(k))) k = `${base}/${k}`;
		k = path.posix.normalize(k);
		return k.length > 1 && k.endsWith("/") && !/^[a-zA-Z]:\/$/.test(k) ? k.slice(0, -1) : k;
	};
	const inside = (k: string, base: string) => k === base || k.startsWith(base.endsWith("/") ? base : `${base}/`);
	// The working folder's own commands stay `undefined`, like a text that names no repo.
	const rootOf = (k: string): string | undefined => (inside(k, cwdKey) ? undefined : roots.find((r) => inside(k, repoKey(r, platform))));
	// parseCommands marks no subshell boundaries, so after a subshell or substitution a cd must not carry over to later commands.
	// $( and backticks substitute even inside double quotes; bare parentheses count only outside quotes.
	const unquoted = text.replace(/\\.|'[^']*'|"(?:\\.|[^"\\])*"/g, "");
	const nested = /\$\(|`/.test(text) || /[()]/.test(unquoted);
	let current = cwdKey;
	const groups: { root: string | undefined; cmds: string[] }[] = [];
	for (const cmd of parseCommands(text)) {
		let i = 0;
		while (i < cmd.words.length && (KEYWORDS.has(cmd.words[i]) || /^[A-Za-z_]\w*=/.test(cmd.words[i]))) i++;
		const name = cmd.words[i]?.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
		const args = cmd.words.slice(i + 1);
		let folder = current;
		if (name === "cd" || name === "pushd" || name === "set-location") {
			folder = resolve(args.find((a) => !a.startsWith("-")) ?? "", current);
			if (!nested) current = folder;
		} else if (name === "popd") {
			folder = cwdKey;
			if (!nested) current = folder;
		} else if (name === "git") {
			for (let j = 0; j < args.length && args[j].startsWith("-"); j++) {
				if (args[j] === "-C" && args[j + 1] !== undefined) folder = resolve(args[j + 1], folder);
				if (["-C", "-c", "--config-env", "--git-dir", "--work-tree"].includes(args[j])) j++;
			}
		}
		const root = rootOf(folder);
		let g = groups.find((x) => x.root === root);
		if (!g) groups.push((g = { root, cmds: [] }));
		g.cmds.push(cmd.words.map(quoteWord).join(" "));
	}
	return groups.map((g) => ({ root: g.root, text: g.cmds.join("; ") }));
}

/** The `--add-dir` flag value as a list of paths; anything but a non-empty string gives none. */
export function parseAddDir(flag: unknown, platform: NodeJS.Platform = process.platform): string[] {
	if (typeof flag !== "string") return [];
	return flag
		.split(platform === "win32" ? ";" : ":")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** The worktree paths of `git worktree list --porcelain` output, forward slashes. */
export function parseWorktreeList(porcelain: string): string[] {
	return porcelain
		.split(/\r?\n/)
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length).trim().replace(/\\/g, "/"))
		.filter(Boolean);
}

/**
 * Moves added folders along when the working folder moved to another checkout of the same projects.
 * `lookup(folder)` gives the git top of the folder and that repo's worktrees (null for a plain folder).
 * A folder inside repo `T` becomes `W/<relative path>` when exactly one worktree `W` of `T` sits next to
 * `newTop` (same parent folder) and the target exists; anything else stays. A result equal to `cwd` is
 * dropped and repeats are removed.
 */
export function followFolders(
	folders: string[],
	cwd: string,
	newTop: string,
	lookup: (folder: string) => { top: string; worktrees: string[] } | null,
	exists: (p: string) => boolean = () => true,
	platform: NodeJS.Platform = process.platform,
): { folders: string[]; changes: { from: string; to: string }[] } {
	const parent = repoKey(path.posix.dirname(repoKey(newTop, platform)), platform);
	const out: string[] = [];
	const changes: { from: string; to: string }[] = [];
	for (const f of folders) {
		let next = f;
		const info = lookup(f);
		if (info) {
			const top = repoKey(info.top, platform);
			const key = repoKey(f, platform);
			const cands = info.worktrees.filter((w) => repoKey(path.posix.dirname(repoKey(w, platform)), platform) === parent);
			if (cands.length === 1 && (key === top || key.startsWith(`${top}/`))) {
				const norm = f.trim().replace(/\\/g, "/").replace(/\/+$/, "");
				const rel = key.slice(top.length).replace(/^\//, "");
				const base = cands[0].replace(/\\/g, "/").replace(/\/+$/, "");
				const target = rel ? `${base}/${norm.slice(norm.length - rel.length)}` : base;
				if (exists(target)) next = target;
			}
		}
		if (next !== f) changes.push({ from: f, to: next });
		if (repoKey(next, platform) === repoKey(cwd, platform)) continue;
		if (out.some((o) => repoKey(o, platform) === repoKey(next, platform))) continue;
		out.push(next);
	}
	return { folders: out, changes };
}
