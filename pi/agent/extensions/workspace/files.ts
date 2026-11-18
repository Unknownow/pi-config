/** File-system steps: junction links, copies, and removing a link without touching its target. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WtConfig } from "./config.ts";

export function isLink(at: string): boolean {
	try {
		return fs.lstatSync(at).isSymbolicLink();
	} catch {
		return false;
	}
}

/** A junction on Windows (no admin rights needed), a directory symlink elsewhere. */
export function linkDir(target: string, at: string): void {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.symlinkSync(path.resolve(target), at, process.platform === "win32" ? "junction" : "dir");
}

export function copyPath(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
}

/** Remove only the link itself. Throws when `at` is not a link, so a real folder is never deleted. */
export function unlinkLink(at: string): void {
	if (!isLink(at)) throw new Error(`${at} is not a link`);
	try {
		fs.unlinkSync(at);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EISDIR") throw e;
		fs.rmdirSync(at);
	}
}

export interface FilesResult {
	linked: string[];
	copied: string[];
	warnings: string[];
}

/** Link and copy the configured gitignored paths from the original repo into its new worktree. */
export function setupFiles(repoTop: string, wt: string, cfg: Pick<WtConfig, "link" | "copy">): FilesResult {
	const out: FilesResult = { linked: [], copied: [], warnings: [] };
	for (const rel of cfg.link) {
		const src = path.join(repoTop, rel);
		const dst = path.join(wt, rel);
		if (!fs.existsSync(src) || fs.existsSync(dst) || isLink(dst)) continue;
		if (!fs.statSync(src).isDirectory()) {
			out.warnings.push(`${rel}: only folders can be linked, skipped`);
			continue;
		}
		linkDir(src, dst);
		out.linked.push(rel);
	}
	for (const rel of cfg.copy) {
		const src = path.join(repoTop, rel);
		const dst = path.join(wt, rel);
		if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
		copyPath(src, dst);
		out.copied.push(rel);
	}
	return out;
}
