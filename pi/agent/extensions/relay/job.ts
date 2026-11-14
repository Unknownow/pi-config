/** job.json: types, ids, job folders. Writes go to a temp file, then a rename. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Size } from "./config.ts";
import { gitOut, type Run } from "./sh.ts";

export type JobState = "draft" | "critic" | "queued" | "working" | "paused" | "judging" | "delivering" | "done" | "stopped" | "failed";
export const FINISHED: JobState[] = ["done", "stopped", "failed"];

export interface RepoState {
	key: string;
	main: string;
	worktree: string;
	target: string;
	/** sha of origin/<target> at dispatch. */
	base: string;
	branch: string;
	remoteBranch?: string;
	/** The sha of the last push relay made to remoteBranch. */
	remotePushed?: string;
	leadEdits?: { sha: string; paths: { status: string; path: string }[] };
	followBase?: string;
	judgedTree?: string;
	acceptedTree?: string;
	passedViaRebase?: { from: string };
	pr?: string;
	merged?: boolean;
	/** A stacked job: the repo started at the head of a predecessor's branch (D17); its PR targets that branch until the predecessor merges. */
	stackedOn?: { job: string; branch: string; head: string };
	/** Set after the restack onto the target: the PR has to be retargeted before the next push. */
	retarget?: boolean;
}

/** Where a stacked repo stands: `none` (not stacked, or restacked already), `open` (the predecessor has not merged) or `merged` (the restack onto the target is due). */
export function stackState(repo: RepoState, pred: Job | undefined): "none" | "open" | "merged" {
	if (!repo.stackedOn) return "none";
	const pr = pred?.repos.find((x) => x.main.toLowerCase() === repo.main.toLowerCase());
	return pr?.merged ? "merged" : "open";
}

export interface Approval {
	at: string;
	item: string;
	category: string;
	by: "brief" | "lead";
	reason: string;
	/** The follow-up (1, 2, ...) it was given in; unset for the original job. */
	followup?: number;
}

export interface Job {
	v: 1;
	id: string;
	title: string;
	state: JobState;
	briefVersion: number;
	/** The brief version the worker was last given (its prompt or an amendment); the judge never reviews work done for an older one. */
	workerVersion?: number;
	set: string;
	/** The worker's working folder (the set root for a multi-repo job). */
	cwd?: string;
	repos: RepoState[];
	dependsOn?: string;
	size: Size;
	round: number;
	escalated: number;
	replans: number;
	followups: number;
	budget: { wallMs: number; tokens: number };
	used: { wallMs: number; tokens: number };
	grace?: { startedAt: number; tokensAt: number };
	worker?: { pid: number; model: string; sessionDir: string };
	approvals: Approval[];
	overrides: { decision: string; finding: string; reason: string }[];
	notes: string[];
	lastVerdict?: { round: number; briefVersion: number; verdict: "PASS" | "FAIL"; blockers: number; majors: number; minors: number };
	/** The worker's last report_done summary. */
	doneSummary?: string;
	/** Why a stopped or failed job ended. */
	endReason?: string;
	/** Set while the job is paused: where it came from and why (a pause, a crash, a stall, a re-plan wait, a judge that failed twice). */
	paused?: { from: "working" | "judging"; why: string };
	/** Automatic restarts of the worker since it last reported done (one is allowed). */
	restarts?: number;
	/** A follow-up waiting for its workspace (the "followup" step). */
	followupPending?: { n: number; text: string };
	/** What each follow-up asked for, by number (index n-1). */
	followupTexts?: string[];
	createdAt: number;
}

export const JOB_ID = /^r[0-9a-z]{6}(-f\d+)?$/;
export const DRAFT_ID = /^d[0-9a-z]{6}$/;

export function newId(prefix: "r" | "d", exists: (id: string) => boolean = () => false): string {
	for (;;) {
		const id = prefix + Array.from({ length: 6 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
		if (!exists(id)) return id;
	}
}

/** `<git common dir>/pi/relay` of the repo that holds `cwd`, or undefined outside a git repo. */
export async function jobRoot(run: Run, cwd: string): Promise<string | undefined> {
	try {
		const common = await gitOut(run, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		return common ? path.join(common, "pi", "relay") : undefined;
	} catch {
		return undefined;
	}
}

export const jobDir = (root: string, id: string) => path.join(root, id);
export const draftDir = (root: string, id: string) => path.join(root, "drafts", id);

const RETRY = ["EPERM", "EBUSY", "EACCES"];

/** Writes `file` through a temp file and a rename; a rename blocked by Windows is retried briefly. */
export function writeAtomic(file: string, data: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data);
	for (let i = 0; ; i++) {
		try {
			fs.renameSync(tmp, file);
			return;
		} catch (e) {
			if (i >= 4 || !RETRY.includes((e as NodeJS.ErrnoException).code ?? "")) {
				fs.rmSync(tmp, { force: true });
				throw e;
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (i + 1));
		}
	}
}

export function writeJob(dir: string, job: Job): void {
	writeAtomic(path.join(dir, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
}

/** The job, or undefined when job.json is missing or unreadable. */
export function readJob(dir: string): Job | undefined {
	try {
		const j = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
		return j && j.v === 1 && typeof j.id === "string" ? (j as Job) : undefined;
	} catch {
		return undefined;
	}
}

/** Every job under the root (drafts excluded), oldest first. */
export function listJobs(root: string): { dir: string; job: Job }[] {
	if (!fs.existsSync(root)) return [];
	const out: { dir: string; job: Job }[] = [];
	for (const e of fs.readdirSync(root, { withFileTypes: true })) {
		if (!e.isDirectory() || !JOB_ID.test(e.name)) continue;
		const dir = path.join(root, e.name);
		const job = readJob(dir);
		if (job) out.push({ dir, job });
	}
	return out.sort((a, b) => a.job.createdAt - b.job.createdAt);
}

export interface LogEntry {
	at?: string;
	kind: string;
	text: string;
}

export function appendLog(dir: string, e: LogEntry): void {
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
	} catch {
		// the log is best effort
	}
}

export function readLog(dir: string, n: number): LogEntry[] {
	try {
		const lines = fs.readFileSync(path.join(dir, "log.jsonl"), "utf8").split("\n").filter(Boolean);
		const out: LogEntry[] = [];
		for (const l of lines.slice(-n)) {
			try {
				out.push(JSON.parse(l));
			} catch {
				// a damaged line is skipped
			}
		}
		return out;
	} catch {
		return [];
	}
}

export function emptyJob(id: string, title: string, set: string, size: Size, budget: Job["budget"]): Job {
	return { v: 1, id, title, state: "draft", briefVersion: 1, set, repos: [], size, round: 0, escalated: 0, replans: 0, followups: 0, budget, used: { wallMs: 0, tokens: 0 }, approvals: [], overrides: [], notes: [], createdAt: Date.now() };
}
