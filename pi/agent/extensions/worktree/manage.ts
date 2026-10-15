/** /wt list and /wt remove. */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LINK, type WtConfig } from "./config.ts";
import { isLink, unlinkLink } from "./files.ts";
import { baseRefOf, mainRepoOf, removeChecks, repoStatus, type Git } from "./git-ops.ts";
import { branchOf, checkName, setRootOf } from "./layout.ts";

const norm = (p: string) => p.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();
const inside = (p: string, dir: string) => norm(p) === norm(dir) || norm(p).startsWith(`${norm(dir)}/`);

function dirs(p: string): string[] {
	try {
		return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
	} catch {
		return [];
	}
}

export const listSets = (cfg: WtConfig) => dirs(cfg.root);

/** Repo worktrees of a set: subfolders that contain a `.git` entry. */
export function reposOf(cfg: WtConfig, name: string): string[] {
	const set = setRootOf(cfg, name);
	return dirs(set).filter((d) => fs.existsSync(path.join(set, d, ".git"))).map((d) => `${set}/${d}`);
}

/** Open Editor projects from `unity status --format json`; null when unknown. */
export function parseEditors(stdout: string): string[] | null {
	try {
		const inst = JSON.parse(stdout)?.data?.instances;
		return Array.isArray(inst) ? inst.map((i: { project?: string }) => i.project ?? "").filter(Boolean) : null;
	} catch {
		return null;
	}
}

export async function listText(git: Git, cfg: WtConfig, editors: string[] | null): Promise<string> {
	const sets = listSets(cfg);
	if (!sets.length) return `No worktree sets in ${cfg.root}`;
	const out: string[] = [];
	for (const name of sets) {
		out.push(`${name}:`);
		for (const wt of reposOf(cfg, name)) {
			const st = await repoStatus(git, wt, await baseRefOf(git, wt));
			const sync = st.upstream ? `ahead ${st.ahead}, behind ${st.behind}` : `not pushed: ${st.unpushed} commits`;
			const lib = fs.existsSync(`${wt}/unity/Library`) ? "yes" : "no";
			const open = editors ? (editors.some((e) => inside(e, wt)) ? "yes" : "no") : "unknown";
			out.push(`  ${path.basename(wt)}: ${st.branch}, ${st.dirty} changed, ${sync}, Library: ${lib}, Editor open: ${open}`);
		}
	}
	return out.join("\n");
}

export interface RemoveEnv {
	git: Git;
	cfg: WtConfig;
	cwd: string;
	added: string[];
	hasUI: boolean;
	confirm: (title: string, message: string) => Promise<boolean>;
}

/** Returns the report text; `error` marks a refusal or failure. */
export async function removeSet(env: RemoveEnv, name: string): Promise<{ text: string; error: boolean }> {
	const { git, cfg } = env;
	const bad = checkName(name);
	if (bad) return { text: bad, error: true };
	const set = setRootOf(cfg, name);
	if ( !fs.existsSync(set)) return { text: `No worktree set "${name}" in ${cfg.root}`, error: true };
	if ([env.cwd, ...env.added].some((p) => inside(p, set))) return { text: `This session uses ${set}; run /wt remove from another session.`, error: true };
	if (!env.hasUI) return { text: "/wt remove needs a UI to confirm.", error: true };
	const wts = reposOf(cfg, name);
	const checks = await removeChecks(git, wts);
	if (checks.problems.length) return { text: `Nothing removed:\n${checks.problems.join("\n")}`, error: true };
	const lines = wts.map((w) => `${w}${fs.existsSync(`${w}/unity/Library`) ? " (its Library/ will be deleted)" : ""}`);
	const ok = await env.confirm(`Remove worktree set "${name}"?`, [...checks.warnings, ...lines].join("\n"));
	if (!ok) return { text: "Cancelled.", error: false };
	return removeAll(env, name, set, wts);
}

async function removeAll(env: RemoveEnv, name: string, set: string, wts: string[]): Promise<{ text: string; error: boolean }> {
	const { git, cfg } = env;
	const done: string[] = [];
	for (const wt of wts) {
		const main = await mainRepoOf(git, wt);
		const branch = branchOf(cfg, name);
		const current = (await repoStatus(git, wt, null)).branch;
		if (!main) return { text: `Stopped at ${wt}: cannot find its main repo. Removed: ${done.join(", ") || "nothing"}`, error: true };
		for (const rel of new Set([...cfg.link, ...DEFAULT_LINK])) {
			const at = path.join(wt, rel);
			if (isLink(at)) unlinkLink(at);
		}
		const rm = await git(main, ["worktree", "remove", wt]);
		if (rm.code !== 0) return { text: `Stopped at ${wt}: ${(rm.stderr || rm.stdout).trim()}\nRemoved: ${done.join(", ") || "nothing"}`, error: true };
		const br = current === branch ? await git(main, ["branch", "-d", branch]) : { code: 1, stdout: "", stderr: `worktree was on ${current}` };
		done.push(br.code === 0 ? wt : `${wt} (branch ${branch} kept: ${(br.stderr || br.stdout).trim().split("\n")[0]})`);
	}
	try {
		if (fs.readdirSync(set).length === 0) fs.rmdirSync(set);
	} catch {
		// leave a folder we could not remove
	}
	return { text: `Removed set "${name}":\n${done.join("\n")}`, error: false };
}
