/** Plan files on disk: one folder per flow inside the repo's git folder, so they never show in a working tree. */

import * as fs from "node:fs";
import * as os from "node:os";
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

/** The remote plan refs go to (`origin`, else the first listed) with its normalised URL; null when the repo has none. */
export async function remoteOf(git: Git, root: string): Promise<{ name: string; url: string } | null> {
	const r = await git(root, ["remote"]).catch(() => null);
	const names = r && r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
	const name = names.includes("origin") ? "origin" : names[0];
	if (!name) return null;
	const u = await git(root, ["remote", "get-url", name]).catch(() => null);
	if (!u || u.code !== 0 || !u.stdout.trim()) return null;
	return { name, url: normalizeRemote(u.stdout.trim()) };
}

/** The branch (none on a detached HEAD) and the normalised URL of the repo's remote. */
export async function repoInfo(git: Git, root: string): Promise<{ branch?: string; remote?: string }> {
	const out: { branch?: string; remote?: string } = {};
	const b = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
	const branch = b && b.code === 0 ? b.stdout.trim() : "";
	if (branch && branch !== "HEAD") out.branch = branch;
	const remote = await remoteOf(git, root);
	if (remote) out.remote = remote.url;
	return out;
}

const IDENT = ["-c", "user.name=pi-workflow", "-c", "user.email=workflow@pi.invalid"];
const ZERO = "0".repeat(40);
const ref = (ns: "plans" | "remote-plans", flowId: string) => `refs/pi/${ns}/${flowId}`;

async function resolveRef(git: Git, root: string, name: string): Promise<string | null> {
	const r = await git(root, ["rev-parse", "--verify", "-q", `${name}^{commit}`]).catch(() => null);
	return r && r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Adds a commit holding plan.md and status.json to `refs/pi/plans/<flowId>`, built with a temporary index so the repo's own index and
 * work tree stay untouched. `parent` replaces the ref's current value as the commit's parent. Returns the commit, or null on any failure.
 */
export async function commitRef(git: Git, root: string, flowId: string, planMd: string, statusJson: string, parent?: string): Promise<string | null> {
	if (!isFlowId(flowId)) return null;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-"));
	try {
		const gd = await git(root, ["rev-parse", "--absolute-git-dir"]);
		if (gd.code !== 0) return null;
		const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
		const old = await resolveRef(git, root, ref("plans", flowId));
		const entries: [string, string][] = [["plan.md", planMd], ["status.json", statusJson]];
		for (const [name, text] of entries) {
			const file = path.join(tmp, name);
			fs.writeFileSync(file, text);
			const h = await git(root, ["hash-object", "-w", file]);
			const sha = h.stdout.trim();
			if (h.code !== 0 || !sha) return null;
			const u = await git(root, ["update-index", "--add", "--cacheinfo", `100644,${sha},${name}`], env);
			if (u.code !== 0) return null;
		}
		const w = await git(root, ["write-tree"], env);
		const tree = w.stdout.trim();
		if (w.code !== 0 || !tree) return null;
		const par = parent ?? old;
		const msg = `plan ${flowId} rev ${(JSON.parse(statusJson) as { rev?: number }).rev ?? 0}`;
		const c = await git(root, [...IDENT, "commit-tree", tree, ...(par ? ["-p", par] : []), "-m", msg]);
		const commit = c.stdout.trim();
		if (c.code !== 0 || !commit) return null;
		const up = await git(root, ["update-ref", ref("plans", flowId), commit, old ?? ZERO]);
		return up.code === 0 ? commit : null;
	} catch {
		return null;
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

/** Pushes the plan ref without force. "rejected" is a non-fast-forward; "failed" is anything else (no access, a host that refuses the ref, ...). */
export async function pushRef(git: Git, root: string, remote: string, flowId: string): Promise<"ok" | "rejected" | "failed"> {
	if (!isFlowId(flowId)) return "failed";
	const r = await git(root, ["push", remote, `${ref("plans", flowId)}:${ref("plans", flowId)}`]).catch(() => null);
	if (!r) return "failed";
	if (r.code === 0) return "ok";
	return /non-fast-forward|fetch first|\[rejected\]|stale info/i.test(r.stderr) ? "rejected" : "failed";
}

/** Copies the remote's plan refs into the mirror namespace `refs/pi/remote-plans/*` (forced: it is only a mirror). */
export async function fetchMirror(git: Git, root: string, remote: string): Promise<boolean> {
	const r = await git(root, ["fetch", "--quiet", remote, "+refs/pi/plans/*:refs/pi/remote-plans/*"]).catch(() => null);
	return !!r && r.code === 0;
}

export interface RefEntry {
	flowId: string;
	commit: string;
	status: PlanStatus | null;
	/** Commit date, ms. */
	date: number;
}

/** status.json text per plan commit; commits are immutable, so a SHA's text never changes. */
const statusCache = new Map<string, string>();

async function statusAt(git: Git, root: string, commit: string): Promise<PlanStatus | null> {
	const cacheable = /^[0-9a-f]{40,64}$/.test(commit);
	const hit = cacheable ? statusCache.get(commit) : undefined;
	if (hit !== undefined) return parseStatus(hit);
	const r = await git(root, ["show", `${commit}:status.json`]).catch(() => null);
	if (!r || r.code !== 0) return null;
	if (cacheable) {
		if (statusCache.size >= 1000) statusCache.clear();
		statusCache.set(commit, r.stdout);
	}
	return parseStatus(r.stdout);
}

/** The rev stored in the local plan ref, or null when there is no readable ref. */
export async function refRev(git: Git, root: string, flowId: string): Promise<number | null> {
	if (!isFlowId(flowId)) return null;
	const commit = await resolveRef(git, root, ref("plans", flowId));
	const status = commit ? await statusAt(git, root, commit) : null;
	return status ? status.rev : null;
}

/** The plan refs of a namespace with their statuses. */
export async function listRefs(git: Git, root: string, ns: "plans" | "remote-plans"): Promise<RefEntry[]> {
	const r = await git(root, ["for-each-ref", "--format=%(refname)\t%(objectname)\t%(committerdate:unix)", `refs/pi/${ns}/`]).catch(() => null);
	if (!r || r.code !== 0) return [];
	const rows: { flowId: string; commit: string; date: number }[] = [];
	for (const line of r.stdout.split("\n")) {
		const [name, commit, unix] = line.trim().split("\t");
		const flowId = name?.slice(`refs/pi/${ns}/`.length);
		if (flowId && commit && isFlowId(flowId)) rows.push({ flowId, commit, date: Number(unix) * 1000 || 0 });
	}
	const out: RefEntry[] = [];
	for (let i = 0; i < rows.length; i += 8) {
		out.push(...(await Promise.all(rows.slice(i, i + 8).map(async (row) => ({ ...row, status: await statusAt(git, root, row.commit) })))));
	}
	return out;
}

/** plan.md as stored at a ref or commit; null when missing. */
export async function readPlanMd(git: Git, root: string, at: string): Promise<string | null> {
	const r = await git(root, ["show", `${at}:plan.md`]).catch(() => null);
	return r && r.code === 0 ? r.stdout : null;
}

/** Removes the plan ref locally (both namespaces) and, with a remote, there too. A ref that is already gone is not an error. */
export async function deleteRef(git: Git, root: string, flowId: string, remote?: string): Promise<void> {
	if (!isFlowId(flowId)) return;
	for (const ns of ["plans", "remote-plans"] as const) {
		if (await resolveRef(git, root, ref(ns, flowId))) await git(root, ["update-ref", "-d", ref(ns, flowId)]).catch(() => null);
	}
	if (remote) await git(root, ["push", remote, "--delete", ref("plans", flowId)]).catch(() => null);
}

/** Points `refs/pi/plans/<flowId>` at the higher-rev commit of the local ref and the mirror. Returns the winner's rev, or null when neither exists. */
export async function adoptHigher(git: Git, root: string, flowId: string): Promise<{ rev: number; commit: string; fromRemote: boolean } | null> {
	if (!isFlowId(flowId)) return null;
	const pick = async (ns: "plans" | "remote-plans") => {
		const commit = await resolveRef(git, root, ref(ns, flowId));
		if (!commit) return null;
		const status = await statusAt(git, root, commit);
		return { commit, rev: status ? status.rev : -1 };
	};
	const local = await pick("plans");
	const remote = await pick("remote-plans");
	if (!local && !remote) return null;
	if (remote && (!local || remote.rev > local.rev)) {
		const r = await git(root, ["update-ref", ref("plans", flowId), remote.commit]);
		return r.code === 0 ? { ...remote, fromRemote: true } : null;
	}
	return local ? { ...local, fromRemote: false } : null;
}

/** Who is working on an unfinished flow: written next to its plan file so other sessions on this machine can see it. */
export interface Claim {
	v: 1;
	pid: number;
	host: string;
	cwd: string;
	updated: string;
}

export const CLAIM_LIVE_MS = 180_000;

export function writeClaim(dir: string, flowId: string, claim: Claim): void {
	if (!isFlowId(flowId)) return;
	const folder = path.join(dir, flowId);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "claim.json"), `${JSON.stringify(claim)}\n`);
}

export function readClaim(dir: string, flowId: string): Claim | null {
	if (!isFlowId(flowId)) return null;
	try {
		const c = JSON.parse(fs.readFileSync(path.join(dir, flowId, "claim.json"), "utf8")) as Partial<Claim>;
		if (c.v !== 1 || typeof c.pid !== "number" || typeof c.host !== "string" || typeof c.cwd !== "string" || typeof c.updated !== "string") return null;
		return c as Claim;
	} catch {
		return null;
	}
}

export function dropClaim(dir: string, flowId: string): void {
	if (!isFlowId(flowId)) return;
	try {
		fs.rmSync(path.join(dir, flowId, "claim.json"), { force: true });
	} catch {}
}

/** True when the claim was written on this host by a process that is still alive, less than 180 s ago. */
export function claimLive(claim: Claim | null, now: number, host: string, isAlive: (pid: number) => boolean): boolean {
	if (!claim || claim.host !== host) return false;
	const t = Date.parse(claim.updated);
	if (!Number.isFinite(t) || now - t >= CLAIM_LIVE_MS) return false;
	return isAlive(claim.pid);
}

/** Whether a process exists (`EPERM` means it does, but is not ours). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string }).code === "EPERM";
	}
}
