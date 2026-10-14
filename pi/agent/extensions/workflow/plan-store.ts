/** Plan files on disk: one folder per flow inside the repo's git folder, so they never show in a working tree. */

import * as fs from "node:fs";
import * as path from "node:path";
import { isFlowId, normalizeRemote, parseStatus, type PlanStatus } from "./plan-doc.ts";

export type Git = (cwd: string, args: string[], env?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `<git common dir>/pi/plans` of the repo, or `<agentDir>/workflow/plans` without one. */
export async function plansDir(git: Git, root: string | null, agentDir: string): Promise<string> {
	if (!root) return path.join(agentDir, "workflow", "plans");
	const r = await git(root, ["rev-parse", "--git-common-dir"]).catch(() => null);
	const common = r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : ".git";
	return path.join(path.resolve(root, common), "pi", "plans");
}

/** Writes plan.md and status.json of a flow; returns the plan.md path. */
export function writeLocal(dir: string, flowId: string, planMd: string, status: PlanStatus): string {
	const folder = path.join(dir, flowId);
	fs.mkdirSync(folder, { recursive: true });
	const file = path.join(folder, "plan.md");
	fs.writeFileSync(file, planMd);
	fs.writeFileSync(path.join(folder, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
	return file;
}

export function planFileExists(dir: string, flowId: string): boolean {
	return fs.existsSync(path.join(dir, flowId, "plan.md"));
}

/** Every plan folder: its status (null when unreadable) and the folder's modification time. */
export function readLocalStatuses(dir: string): { flowId: string; status: PlanStatus | null; mtime: number }[] {
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const out: { flowId: string; status: PlanStatus | null; mtime: number }[] = [];
	for (const flowId of names.filter(isFlowId)) {
		const folder = path.join(dir, flowId);
		try {
			const mtime = fs.statSync(folder).mtimeMs;
			let status: PlanStatus | null = null;
			try {
				status = parseStatus(fs.readFileSync(path.join(folder, "status.json"), "utf8"));
			} catch {}
			out.push({ flowId, status, mtime });
		} catch {}
	}
	return out;
}

export function deleteLocal(dir: string, flowId: string): void {
	if (!isFlowId(flowId)) return;
	fs.rmSync(path.join(dir, flowId), { recursive: true, force: true });
}

/** The branch (none on a detached HEAD) and the normalised URL of the repo's remote (`origin`, else the first listed). */
export async function repoInfo(git: Git, root: string): Promise<{ branch?: string; remote?: string }> {
	const out: { branch?: string; remote?: string } = {};
	const b = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
	const branch = b && b.code === 0 ? b.stdout.trim() : "";
	if (branch && branch !== "HEAD") out.branch = branch;
	const r = await git(root, ["remote"]).catch(() => null);
	const names = r && r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
	const name = names.includes("origin") ? "origin" : names[0];
	if (name) {
		const u = await git(root, ["remote", "get-url", name]).catch(() => null);
		if (u && u.code === 0 && u.stdout.trim()) out.remote = normalizeRemote(u.stdout.trim());
	}
	return out;
}
