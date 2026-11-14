/** Moves the lead's uncommitted edits into a job (D5): a snapshot commit over a temporary index, a cherry-pick into the job's worktree, a hash-checked revert. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitOut, identityEnv, type Run } from "./sh.ts";

export interface Snapshot {
	sha: string;
	paths: { status: string; path: string }[];
}

export const snapshotBranch = (jobId: string) => `relay/${jobId}/lead-edits`;

/** A commit (parent: HEAD) holding every uncommitted change, new files included; null when there is nothing to move. The index and the work tree are left as they are. */
export async function snapshotEdits(run: Run, repoDir: string, jobId: string): Promise<Snapshot | null> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-snap-"));
	const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
	try {
		await gitOut(run, repoDir, ["read-tree", "HEAD"], { env });
		await gitOut(run, repoDir, ["add", "-A"], { env });
		const tree = await gitOut(run, repoDir, ["write-tree"], { env });
		const headTree = await gitOut(run, repoDir, ["rev-parse", "HEAD^{tree}"]);
		if (tree === headTree) return null;
		const ident = await identityEnv(run, repoDir);
		const sha = await gitOut(run, repoDir, ["commit-tree", tree, "-p", "HEAD", "-m", `relay: lead edits for ${jobId}`], { env: ident });
		await gitOut(run, repoDir, ["branch", "-f", snapshotBranch(jobId), sha]);
		const diff = await gitOut(run, repoDir, ["diff", "--name-status", "--no-renames", "-z", "HEAD", sha]);
		const parts = diff.split("\0").filter(Boolean);
		const paths: Snapshot["paths"] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) paths.push({ status: parts[i][0], path: parts[i + 1] });
		return { sha, paths };
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

export interface RevertResult {
	reverted: string[];
	skipped: { path: string; reason: string }[];
}

/** Reverts the snapshotted paths in the lead's checkout, but only those still exactly as snapshotted. */
export async function revertSnapshotted(run: Run, repoDir: string, snap: Snapshot): Promise<RevertResult> {
	const reverted: string[] = [];
	const skipped: RevertResult["skipped"] = [];
	for (const { status, path: p } of snap.paths) {
		const file = path.join(repoDir, p);
		if (status === "D") {
			if (fs.existsSync(file)) {
				skipped.push({ path: p, reason: "was deleted, exists again" });
				continue;
			}
			const r = await run("git", ["checkout", "HEAD", "--", p], repoDir);
			if (r.code === 0) reverted.push(p);
			else skipped.push({ path: p, reason: r.stderr.trim().slice(0, 200) });
			continue;
		}
		if (!fs.existsSync(file)) {
			skipped.push({ path: p, reason: "was removed after the snapshot" });
			continue;
		}
		const now = (await run("git", ["hash-object", `--path=${p}`, "--", p], repoDir)).stdout.trim();
		const snapBlob = (await run("git", ["rev-parse", `${snap.sha}:${p}`], repoDir)).stdout.trim();
		if (!now || now !== snapBlob) {
			skipped.push({ path: p, reason: "changed after the snapshot" });
			continue;
		}
		if (status === "A") {
			try {
				fs.rmSync(file, { force: true });
				reverted.push(p);
			} catch (e) {
				skipped.push({ path: p, reason: (e as Error).message.slice(0, 200) });
			}
		} else {
			const r = await run("git", ["checkout", "HEAD", "--", p], repoDir);
			if (r.code === 0) reverted.push(p);
			else skipped.push({ path: p, reason: r.stderr.trim().slice(0, 200) });
		}
	}
	if (reverted.length) await run("git", ["reset", "-q", "HEAD", "--", ...reverted], repoDir);
	return { reverted, skipped };
}

/** Applies the snapshot as one commit in the job's worktree. On a conflict the cherry-pick is aborted and the conflicting paths come back. */
export async function applySnapshot(run: Run, worktree: string, sha: string): Promise<{ ok: true } | { ok: false; conflicts: string[]; error: string }> {
	const ident = await identityEnv(run, worktree);
	const r = await run("git", ["cherry-pick", "--allow-empty", "--keep-redundant-commits", sha], worktree, { env: ident });
	if (r.code === 0) return { ok: true };
	const conflicts = (await run("git", ["diff", "--name-only", "--diff-filter=U"], worktree)).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
	await run("git", ["cherry-pick", "--abort"], worktree);
	return { ok: false, conflicts, error: (r.stderr || r.stdout).trim().slice(0, 500) };
}

/** Drops the snapshot branch (after delivery). */
export async function dropSnapshotBranch(run: Run, repoDir: string, jobId: string): Promise<void> {
	await run("git", ["branch", "-D", snapshotBranch(jobId)], repoDir);
}
