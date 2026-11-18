/** `/wt rename`: move a set's worktrees to a new set folder and rename its branches. Local and unpushed sets only. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WtConfig } from "./config.ts";
import { mainRepoOf, type Git } from "./git-ops.ts";
import { baseName, branchOf, checkName, setRootOf } from "./layout.ts";
import { readMeta, writeMeta } from "./meta.ts";
import { repoDirsIn } from "./manage.ts";

export interface RenameEnv {
	git: Git;
	cfg: WtConfig;
	/** Why a set cannot be renamed because someone uses it (this session included), or null. */
	inUse: (setRoot: string) => string | null;
}

export interface RenameResult {
	error: boolean;
	text: string;
}

const slash = (p: string) => p.split(String.fromCharCode(92)).join("/");

async function branchExists(git: Git, main: string, branch: string): Promise<boolean> {
	return (await git(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export async function renameSet(env: RenameEnv, oldName: string, newName: string): Promise<RenameResult> {
	const { git, cfg } = env;
	const fail = (text: string): RenameResult => ({ error: true, text });
	const bad = checkName(newName);
	if (bad) return fail(bad);
	const oldRoot = setRootOf(cfg, oldName);
	const newRoot = setRootOf(cfg, newName);
	if (!fs.existsSync(oldRoot)) return fail(`no worktree set "${oldName}" in ${cfg.root}`);
	if (fs.existsSync(newRoot)) return fail(`"${newName}" already exists in ${cfg.root}`);
	const holder = env.inUse(oldRoot);
	if (holder) return fail(`${oldName} is ${holder}; nothing was renamed`);

	const oldBranch = branchOf(cfg, oldName);
	const newBranch = branchOf(cfg, newName);
	const repos: { main: string; from: string; to: string; hasBranch: boolean }[] = [];
	for (const wt of repoDirsIn(oldRoot)) {
		const main = await mainRepoOf(git, wt);
		if (!main) return fail(`${wt}: not a git worktree; nothing was renamed`);
		const dir = baseName(wt);
		const hasBranch = await branchExists(git, main, oldBranch);
		if (hasBranch) {
			const up = await git(main, ["rev-parse", "--abbrev-ref", `${oldBranch}@{upstream}`]);
			const remote = await git(main, ["ls-remote", "--heads", "origin", oldBranch]);
			if (remote.code !== 0 && up.code !== 0) return fail(`${dir}: could not check origin for ${oldBranch} (${remote.stderr.trim()}); nothing was renamed`);
			if (up.code === 0 || remote.stdout.trim()) return fail(`${dir}: branch is pushed; renaming would break its pull request`);
		}
		if (await branchExists(git, main, newBranch)) return fail(`${dir}: branch ${newBranch} already exists; nothing was renamed`);
		repos.push({ main, from: slash(wt), to: `${slash(newRoot)}/${dir}`, hasBranch });
	}
	if (!repos.length) return fail(`${oldName} holds no worktree; nothing to rename`);

	fs.mkdirSync(newRoot, { recursive: true });
	const done: typeof repos = [];
	/** Puts the finished repos back; returns what could not be undone. */
	const undo = async (): Promise<string[]> => {
		const left: string[] = [];
		for (const r of [...done].reverse()) {
			if (r.hasBranch) {
				const b = await git(r.main, ["branch", "-m", newBranch, oldBranch]);
				if (b.code !== 0) left.push(`${baseName(r.from)}: still on branch ${newBranch} (${(b.stderr || b.stdout).trim()})`);
			}
			const m = await git(r.main, ["worktree", "move", r.to, r.from]);
			if (m.code !== 0) left.push(`${baseName(r.from)}: still at ${r.to} (${(m.stderr || m.stdout).trim()})`);
		}
		try {
			fs.rmdirSync(newRoot);
		} catch {
			// not empty: leave it
		}
		return left;
	};
	const putBack = (left: string[]) => (left.length ? `could not undo everything: ${left.join("; ")}` : "everything was put back");
	for (const r of repos) {
		const mv = await git(r.main, ["worktree", "move", r.from, r.to]);
		if (mv.code !== 0) {
			return fail(`${baseName(r.from)}: ${(mv.stderr || mv.stdout).trim()}; ${putBack(await undo())}`);
		}
		done.push(r);
		if (r.hasBranch) {
			const br = await git(r.main, ["branch", "-m", oldBranch, newBranch]);
			if (br.code !== 0) {
				const back = await git(r.main, ["worktree", "move", r.to, r.from]);
				done.pop();
				const left = back.code === 0 ? [] : [`${baseName(r.from)}: still at ${r.to} (${(back.stderr || back.stdout).trim()})`];
				return fail(`${baseName(r.from)}: ${(br.stderr || br.stdout).trim()}; ${putBack([...left, ...(await undo())])}`);
			}
		}
	}

	const meta = readMeta(oldRoot);
	if (meta) {
		writeMeta(newRoot, { ...meta, branch: newBranch });
		try {
			fs.rmSync(path.join(oldRoot, ".pi-set.json"));
		} catch {
			// stays behind with the old folder
		}
	}
	let kept = "";
	try {
		fs.rmdirSync(oldRoot);
	} catch {
		kept = ` (${oldName} still holds other files and was kept)`;
	}
	return { error: false, text: `Renamed ${oldName} to ${newName}${kept}` };
}
