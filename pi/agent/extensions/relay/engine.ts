/** The engine: runs the step modules of each job, the queue and the concurrency limit (D12). The lead's tools and the watcher call into it. */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { countTokens } from "../shared/tokens.ts";
import { APPROVAL, approvalPayload } from "./events.ts";
import { type Brief, appendAmendment, briefFiles, checkBrief, parseBrief, replaceBrief } from "./brief.ts";
import { filesOverlap } from "./glob.ts";
import { parseFindings } from "../shared/findings.ts";
import { budgetState, longToolWall, toolTimeoutMs } from "./budget.ts";
import { CATEGORIES, type Category, type RelayConfig, repoPolicy, type Size } from "./config.ts";
import { type Job, type JobState, type RepoState, stackState, appendLog, draftDir, emptyJob, FINISHED, jobDir, listJobs, newId, readJob, readLog, writeJob } from "./job.ts";
import { JobLock, type Me, pidAlive } from "./lock.ts";
import { append, inboxPath, outboxPath, takeNew, type OutMsg } from "./mailbox.ts";
import { forwardedServers, roleTools } from "./knowledge.ts";
import { type RpcCallbacks, type RpcWorker, startWorker as realStartWorker, type WorkerOpts } from "./rpc.ts";
import type { Run } from "./sh.ts";
import { runSubagent, type RunOptions, type RunResult } from "./subagent.ts";
import { applySnapshot } from "./snapshot.ts";
import { dispatchStep, resolveRepo, workerPrompt } from "./steps/dispatch.ts";
import { followupStep } from "./steps/followup.ts";
import { deliverStep } from "./steps/deliver.ts";
import { judgeStep, workStep } from "./steps/loop.ts";
import { cleanupStep, reportStep } from "./steps/report.ts";
import type { Shell, Step, StepCtx, StepName, Wt, WorkerState } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The steps, by name. A new step is one module plus one entry here. */
export const STEPS: Record<StepName, Step> = {
	dispatch: dispatchStep,
	followup: followupStep,
	work: workStep,
	judge: judgeStep,
	deliver: deliverStep,
	report: reportStep,
	cleanup: cleanupStep,
};

const STATE_OF: Partial<Record<StepName, JobState>> = { work: "working", judge: "judging", deliver: "delivering" };

export const defaultShell: Shell = (cmd, cwd, timeoutMs = 30 * 60_000) =>
	new Promise((resolve) => {
		const p = spawn(cmd, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		const t = setTimeout(() => p.kill(), timeoutMs);
		p.on("close", (code) => (clearTimeout(t), resolve({ code: code ?? 1, out })));
		p.on("error", (e) => (clearTimeout(t), resolve({ code: 1, out: String(e.message) })));
	});

/** The version the next amendment gets (1 plus the amendments so far). */
function parseBriefVersion(text: string, fallback: number): number {
	const p = parseBrief(text);
	return "errors" in p ? fallback : p.version;
}

/** Kills a worker the dead lead left behind (same host; a pid that is gone is ignored). */
function killSurvivor(pid: number): void {
	if (pid <= 0 || pid === process.pid || !pidAlive(pid)) return;
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
		else process.kill(pid, "SIGKILL");
	} catch {
		// it exited meanwhile
	}
}

export interface EngineDeps {
	cfg: () => RelayConfig;
	run: Run;
	/** `<git common dir>/pi/relay` */
	root: string;
	me: Me;
	/** The folder with prompts/ (relay itself). */
	relayDir?: string;
	trusted?: () => boolean | undefined;
	wt: Wt;
	startWorker?: (o: WorkerOpts, cb: RpcCallbacks) => RpcWorker;
	runReviewer?: (o: RunOptions) => Promise<RunResult>;
	/** The registered MCP servers (pi.getMcpServers()), for the knowledge tools. */
	mcpServers?: () => { name: string; config: object }[];
	shell?: Shell;
	notify: (line: string) => void;
	wake: (text: string) => void;
	emit: (name: string, payload: object) => void;
	now?: () => number;
	leadCwd: string;
	folders: () => string[];
	pollMs?: number;
	heartbeatMs?: number;
}

class JobRun {
	dir: string;
	job: Job;
	lock: JobLock;
	worker?: RpcWorker;
	ws: WorkerState = { alive: false, settled: false, exited: false, nudges: 0, openAsks: [] };
	asks = new Map<string, OutMsg>();
	driving = false;
	again = false;
	ended = false;
	lastTick = 0;
	lastBeat = 0;
	graceNotified = false;
	/** Bumped whenever the worker process is replaced or dropped: events of an older process are ignored. */
	gen = 0;
	lastActivity = 0;
	tools = new Map<string, { name: string; startedAt: number; timeoutMs: number }>();
	/** A steer sent to the running worker; if it is still queued when the worker settles it is sent as a prompt. */
	pendingSteer?: string;
	/** Another lead owns the job now: nothing of this lead may write, push or merge for it. */
	lost = false;
	/** The brief version of the pending steer; it becomes the worker's version only once the worker has taken it. */
	steerVersion?: number;
	/** A restart, a pause or a recovery is in progress: nothing else may start or prompt a worker. */
	recovering = false;
	/** Set by stop() and the budget: a running step must wind down, whatever state it sets. */
	stopRequested = false;
	abort = new AbortController();
	constructor(dir: string, job: Job, lock: JobLock) {
		this.dir = dir;
		this.job = job;
		this.lock = lock;
	}
}

/** The dependency gate applies only before the dependent first starts: after that it is built on the predecessor's pushed work. */
export const awaitingPred = (job: Job): boolean => !!job.dependsOn && job.repos.length === 0 && !job.followupPending;

/** A tool call as one short log line: the name and its first argument, shortened. */
export function toolSummary(name: string, args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? Object.values(a).find((x) => typeof x === "string");
	const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
	return s ? `${name}: ${s.length > 80 ? `${s.slice(0, 77)}...` : s}` : name;
}

export class Engine {
	readonly jobs = new Map<string, JobRun>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly d: EngineDeps;
	/** `<git common dir>/pi/relay` */
	readonly root: string;

	constructor(d: EngineDeps) {
		this.d = d;
		this.root = d.root;
	}

	private get cfg() {
		return this.d.cfg();
	}
	private now() {
		return (this.d.now ?? Date.now)();
	}
	private get relayDir() {
		return this.d.relayDir ?? here;
	}

	// ------------------------------------------------------------------------------------------------ lifecycle

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), this.d.pollMs ?? 1000);
		this.timer.unref?.();
	}

	async shutdown(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const jr of this.jobs.values()) {
			jr.gen++; // the lead is going away: the exits of its workers are not crashes
			jr.worker?.kill();
		}
	}

	/** Jobs that hold a slot: started and not finished. */
	runningCount(): number {
		return [...this.jobs.values()].filter((j) => !j.ended && ((j.job.state !== "queued" && j.job.state !== "draft") || j.driving)).length;
	}
	ownedRunning(): number {
		return [...this.jobs.values()].filter((j) => !j.ended && !FINISHED.includes(j.job.state)).length;
	}

	private save(jr: JobRun) {
		if (jr.lost) return;
		writeJob(jr.dir, jr.job);
	}

	// ------------------------------------------------------------------------------------------------ dispatch

	async dispatch(input: { brief: string; size?: Size; overrides?: Job["overrides"]; draft?: string }): Promise<{ id: string; state: JobState; queued: boolean } | { error: string }> {
		const checked = checkBrief(input.brief);
		if ("errors" in checked) return { error: `the brief is not complete:\n- ${checked.errors.join("\n- ")}` };
		const brief = checked.brief;
		if (brief.dependsOn) {
			const pred = this.peek(brief.dependsOn);
			if (!pred) return { error: `Depends on: job "${brief.dependsOn}" is unknown (a job id of this repo)` };
			const w = this.depState(brief.dependsOn);
			if (typeof w === "object") return { error: `Depends on: ${w.stop}` };
		}
		const id = newId("r", (x) => fs.existsSync(jobDir(this.d.root, x)));
		const dir = jobDir(this.d.root, id);
		fs.mkdirSync(dir, { recursive: true });
		const lock = new JobLock(dir, this.d.me);
		if (!lock.acquire()) return { error: `could not lock job ${id}` };
		fs.writeFileSync(path.join(dir, "brief.md"), input.brief);
		const cfg = this.cfg;
		const title = (brief.sections.Goal ?? "job").split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, "").trim().slice(0, 80) || "job";
		const job = emptyJob(id, title, id, input.size ?? brief.budget?.size ?? "normal", { wallMs: (brief.budget?.wallMin ?? cfg.budget.wallMin) * 60_000, tokens: brief.budget?.tokens ?? cfg.budget.tokens });
		job.briefVersion = brief.version;
		job.overrides = input.overrides ?? [];
		for (const c of CATEGORIES) {
			const a = brief.authority[c];
			if (a?.value === "yes") job.approvals.push({ at: new Date(this.now()).toISOString(), item: a.specifics ?? "*", category: c, by: "brief", reason: "Authority in the brief" });
		}
		const long = longToolWall(cfg, `${brief.sections.Verify ?? ""}\n${brief.sections.Design ?? ""}`, job.budget.wallMs);
		if (long) {
			job.budget.wallMs = long.wallMs;
			job.notes.push(long.note);
		}
		if (brief.dependsOn) {
			job.dependsOn = brief.dependsOn;
			job.notes.push(`stacked on job ${brief.dependsOn}: starts at the head of its branch once that job has passed`);
		}
		if (input.draft && /^d[0-9a-z]{6}$/.test(input.draft)) {
			const src = path.join(draftDir(this.d.root, input.draft), "critic");
			if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, "critic"), { recursive: true });
		}
		const jr = new JobRun(dir, job, lock);
		this.jobs.set(id, jr);
		for (const a of job.approvals) this.d.emit(APPROVAL, approvalPayload(id, a.category, a.item, "brief", a.reason));
		this.noteOverlaps(jr, brief);
		const waiting = brief.dependsOn && this.depState(brief.dependsOn) === "wait";
		if (waiting || this.runningCount() >= cfg.maxJobs) {
			job.state = "queued";
			this.save(jr);
			appendLog(dir, { kind: "queued", text: waiting ? `queued until job ${brief.dependsOn} has passed` : `queued behind ${cfg.maxJobs} running jobs` });
			return { id, state: "queued", queued: true };
		}
		job.state = "queued";
		this.save(jr);
		void this.drive(jr);
		return { id, state: job.state, queued: false };
	}

	/** Queued jobs start in creation order when a slot is free and their predecessor (if any) has passed. */
	private startQueued() {
		for (const jr of [...this.jobs.values()].sort((a, b) => a.job.createdAt - b.job.createdAt)) {
			if (this.runningCount() >= this.cfg.maxJobs) return;
			if (jr.job.state !== "queued" || jr.ended || jr.driving) continue;
			if (awaitingPred(jr.job) && this.depState(jr.job.dependsOn!) !== "go") continue;
			void this.drive(jr);
		}
	}

	/** Another job by id: this lead's own, or one on disk. */
	private peek(id: string): Job | undefined {
		return this.jobs.get(id)?.job ?? readJob(jobDir(this.d.root, id));
	}

	/** Whether a job that depends on `id` may start (the predecessor passed and pushed, or merged), must wait, or must stop. */
	private depState(id: string): "go" | "wait" | { stop: string } {
		const p = this.peek(id);
		if (!p) return { stop: `predecessor ${id} was not found` };
		if (p.state === "stopped" || p.state === "failed") return { stop: `predecessor ${id} ${p.state}${p.endReason ? `: ${p.endReason}` : ""}` };
		if (p.state === "done") return "go";
		if (p.state === "delivering" && p.repos.length && p.repos.every((r) => r.merged || r.remotePushed)) return "go";
		return "wait";
	}

	/** A job whose predecessor stopped or failed stops too, with the reason (D17). */
	private async cascade(): Promise<void> {
		for (const jr of [...this.jobs.values()]) {
			if (jr.ended || FINISHED.includes(jr.job.state) || !awaitingPred(jr.job)) continue;
			const d = this.depState(jr.job.dependsOn!);
			if (typeof d !== "object") continue;
			const r = await this.stop(jr.job.id, d.stop);
			if ("ok" in r) this.d.notify(`relay job ${jr.job.id}: stopped, ${d.stop}`);
		}
	}

	/** Two jobs whose files overlap get a notice and a log entry each (S30). */
	private noteOverlaps(jr: JobRun, brief: Brief): void {
		const mine = briefFiles(brief);
		if (!mine.length) return;
		const repoNames = brief.targets.map((t) => path.basename(t.repo).toLowerCase());
		for (const other of this.jobs.values()) {
			if (other === jr || other.ended || FINISHED.includes(other.job.state)) continue;
			let theirs: ReturnType<typeof parseBrief>;
			try {
				theirs = parseBrief(fs.readFileSync(path.join(other.dir, "brief.md"), "utf8"));
			} catch {
				continue;
			}
			if ("errors" in theirs || !theirs.targets.some((t) => repoNames.includes(path.basename(t.repo).toLowerCase()))) continue;
			if (!filesOverlap(mine, briefFiles(theirs))) continue;
			const text = `jobs ${jr.job.id} and ${other.job.id} name overlapping files; expect a rebase conflict in the second delivery`;
			appendLog(jr.dir, { kind: "overlap", text });
			appendLog(other.dir, { kind: "overlap", text });
			this.d.notify(`relay: ${text}`);
		}
	}

	// ------------------------------------------------------------------------------------------------ driving

	private initialStep(jr: JobRun): StepName | undefined {
		switch (jr.job.state) {
			case "queued":
				return jr.job.followupPending ? "followup" : "dispatch";
			case "working":
				return "work";
			case "judging":
				return "judge";
			case "paused":
				return undefined; // parked until relay_resume, relay_replan or relay_deliver
			case "delivering":
				return "deliver";
			case "done":
			case "stopped":
			case "failed":
				return fs.existsSync(path.join(jr.dir, "report.md")) ? undefined : "report";
			default:
				return undefined;
		}
	}

	async drive(jr: JobRun): Promise<void> {
		if (jr.ended) return;
		if (jr.recovering) return; // restart, pause and recover re-drive the job when they are done
		if (jr.driving) {
			jr.again = true;
			return;
		}
		jr.driving = true;
		try {
			do {
				jr.again = false;
				let step = this.initialStep(jr);
				while (step && !jr.ended) {
					// ownership is checked before every action that drives the job
					if (step !== "report" && step !== "cleanup" && !jr.lock.isOwner()) {
						appendLog(jr.dir, { kind: "lost", text: "this lead no longer owns the job" });
						this.letGo(jr);
						break;
					}
					// a worker's last message may not be read yet when its settle arrives
					if (step === "work") this.pump(jr);
					const s = STATE_OF[step];
					if (s && jr.job.state !== s) jr.job.state = s;
					if (jr.lost) break;
					this.save(jr);
					let next: StepName | "wait" | "end";
					try {
						next = await STEPS[step].run(jr.job, this.ctxFor(jr));
					} catch (e) {
						if (jr.lost) break; // another lead owns the job: no log line, no wake
						appendLog(jr.dir, { kind: "error", text: `${step}: ${(e as Error).message}` });
						if (step === "report" || step === "cleanup") next = "end";
						else {
							jr.job.endReason = `${step} step failed: ${(e as Error).message}`;
							jr.job.state = "failed";
							this.d.wake(`relay job ${jr.job.id}: the ${step} step failed: ${(e as Error).message}. The job is failed; its set is kept.`);
							next = "report";
						}
					}
					if (jr.lost) break; // never report, clean up or finish a job another lead owns
					// a stop that arrived while the step ran wins over whatever state the step set
					if (jr.stopRequested && step !== "report" && step !== "cleanup") {
						if (!FINISHED.includes(jr.job.state) || jr.job.state === "done") jr.job.state = "stopped";
						next = "report";
					}
					this.save(jr);
					if (next === "wait") break;
					if (next === "end") {
						this.finish(jr);
						break;
					}
					step = next;
				}
			} while (jr.again && !jr.ended);
		} finally {
			jr.driving = false;
		}
	}

	/** Another lead owns the job now: this one stops touching it (no save, no lock release) and kills its worker. */
	private letGo(jr: JobRun): void {
		jr.lost = true;
		jr.stopRequested = true;
		jr.abort.abort();
		jr.ended = true;
		this.jobs.delete(jr.job.id); // a later scan may adopt it again; restack and prCleanup read the job from disk
		jr.gen++;
		jr.worker?.kill();
	}

	private finish(jr: JobRun) {
		jr.ended = true;
		jr.lock.release();
		this.save(jr);
		this.startQueued();
		void this.cascade();
		void this.restack().catch(() => undefined);
	}

	// ------------------------------------------------------------------------------------------------ step context

	private ctxFor(jr: JobRun): StepCtx {
		const cfg = this.cfg;
		const d = this.d;
		return {
			dir: jr.dir,
			cfg,
			run: d.run,
			shell: d.shell ?? defaultShell,
			brief: () => fs.readFileSync(path.join(jr.dir, "brief.md"), "utf8"),
			save: () => this.save(jr),
			log: (kind, text) => appendLog(jr.dir, { kind, text }),
			notify: (line) => d.notify(line),
			wake: (text) => d.wake(text),
			isOwner: () => jr.lock.isOwner(),
			stopped: () => jr.stopRequested || jr.lost,
			wt: d.wt,
			job: (id) => this.peek(id),
			worker: jr.ws,
			startWorker: (job, o) => this.startWorker(jr, o),
			setWorkerModel: async (model) => {
				if (jr.lost) return false;
				const at = model.indexOf("/");
				if (at < 0 || !jr.worker) return false;
				const r = await jr.worker.setModel(model.slice(0, at), model.slice(at + 1));
				return r.success;
			},
			prompt: async (text) => {
				if (jr.recovering || jr.lost) return;
				// a worker that is not running is restarted (-c) with this prompt
				if (!jr.worker || jr.ws.exited) {
					await this.startWorker(jr, { prompt: text, resume: true });
					return;
				}
				// a prompt to a worker that is still streaming must say how to queue
				for (let i = 0; i < 300 && !jr.ws.settled && !jr.ws.exited; i++) await new Promise((r) => setTimeout(r, 100));
				const wasSettled = jr.ws.settled;
				jr.ws.settled = false;
				const r = await jr.worker?.prompt(text, wasSettled ? undefined : "followUp");
				if (r && !r.success) appendLog(jr.dir, { kind: "prompt-error", text: r.error ?? "prompt failed" });
			},
			stopWorker: async () => {
				await jr.worker?.stop(10_000);
				jr.ws.alive = false;
			},
			review: (role, task, cwd) => this.review(role, task, cwd, jr.abort.signal),
			emit: (n, p) => d.emit(n, p),
			now: () => this.now(),
			relayDir: this.relayDir,
			leadCwd: d.leadCwd,
			folders: d.folders,
		};
	}

	private async startWorker(jr: JobRun, o: { prompt: string; resume?: boolean }): Promise<void> {
		if (jr.lost) throw new Error("this lead no longer owns the job");
		const cfg = this.cfg;
		const job = jr.job;
		// an escalated job keeps its stronger model across a restart
		const spec = job.escalated > 0 ? cfg.roles.escalate : cfg.roles.worker[job.size];
		const sessionDir = path.join(jr.dir, "sessions", ...(job.followups ? [`f${job.followups}`] : []));
		fs.mkdirSync(sessionDir, { recursive: true });
		const k = this.knowledgeMcp("worker");
		const gen = ++jr.gen;
		const live = () => jr.gen === gen;
		const cb: RpcCallbacks = {
			onUsage: (u) => {
				if (live()) job.used.tokens += countTokens(u, cfg.tokenWeights).cost;
			},
			onActivity: () => {
				if (live()) jr.lastActivity = this.now();
			},
			onToolStart: (id, name, args) => {
				if (!live()) return;
				jr.tools.set(id, { name, startedAt: this.now(), timeoutMs: toolTimeoutMs(cfg, name, args) });
				appendLog(jr.dir, { kind: "tool", text: toolSummary(name, args) });
			},
			onToolEnd: (id) => {
				if (live()) jr.tools.delete(id);
			},
			onSettled: () => {
				if (live()) void this.settled(jr);
			},
			onExit: () => {
				if (!live()) return;
				jr.ws.exited = true;
				jr.ws.alive = false;
				if (!jr.ended && !jr.stopRequested && job.state === "working") void this.recover(jr, "its process exited");
			},
		};
		const start = this.d.startWorker ?? realStartWorker;
		jr.ws.exited = false;
		jr.ws.settled = false;
		jr.lastActivity = this.now();
		jr.tools.clear();
		jr.worker = start(
			{
				cwd: job.cwd ?? job.repos[0].worktree,
				model: spec.model,
				thinking: spec.thinking,
				sessionDir,
				resume: o.resume,
				trusted: this.d.trusted?.(),
				extensions: cfg.worker.extensions,
				mcp: k?.servers,
				env: { RELAY_JOB: job.id, RELAY_JOB_DIR: jr.dir },
			},
			cb,
		);
		jr.ws.alive = true;
		job.worker = { pid: jr.worker.pid ?? 0, model: spec.model, sessionDir };
		this.save(jr);
		const r = await jr.worker.prompt(o.prompt);
		if (!r.success) throw new Error(`the worker did not accept its first prompt: ${r.error ?? "no response"}`);
	}

	/** `agent_settled`: a steer that is still queued becomes a prompt; otherwise the work step looks at the job. */
	private async settled(jr: JobRun): Promise<void> {
		const steer = jr.pendingSteer;
		if (steer && jr.worker && jr.job.state !== "working") {
			// the job moved on (the judge runs): the steer is dropped; the judge sends the worker back with the amendment
			jr.pendingSteer = undefined;
			await jr.worker.clearQueue();
		}
		if (steer && jr.worker && jr.job.state === "working" && !jr.recovering) {
			jr.pendingSteer = undefined;
			const st = await jr.worker.getState();
			if (st.success && Number(st.data?.pendingMessageCount ?? 0) > 0) {
				await jr.worker.clearQueue();
				// what the worker said before this settle is stale: it will answer the steer
				this.pump(jr);
				jr.ws.done = undefined;
				jr.ws.settled = false;
				appendLog(jr.dir, { kind: "steer", text: "still queued when the worker settled; sent as a prompt" });
				jr.job.workerVersion = jr.steerVersion ?? jr.job.workerVersion;
				const r = await jr.worker.prompt(steer);
				if (!r.success) appendLog(jr.dir, { kind: "prompt-error", text: r.error ?? "prompt failed" });
				return;
			}
			// the worker took the steer itself
			jr.job.workerVersion = jr.steerVersion ?? jr.job.workerVersion;
		}
		jr.ws.settled = true;
		if (jr.job.state === "working") void this.drive(jr);
	}

	/** Drops the worker process; events of the old process are ignored from here on. */
	private dropWorker(jr: JobRun): void {
		this.pump(jr); // asks of the old worker are passed on; a done it sent is superseded by what follows
		jr.gen++;
		jr.worker?.kill();
		jr.ws.alive = false;
		jr.ws.settled = false;
		jr.ws.done = undefined;
		jr.ws.nudges = 0;
		jr.ws.openAsks = [];
		jr.asks.clear();
		jr.tools.clear();
		jr.pendingSteer = undefined;
	}

	private pauseJob(jr: JobRun, from: "working" | "judging", why: string): void {
		if (jr.lost) return;
		jr.job.state = "paused";
		jr.job.paused = { from, why };
		this.save(jr);
		appendLog(jr.dir, { kind: "paused", text: why });
	}

	/** The worker crashed, stalled or ran a tool past its timeout: one restart with `-c`, then the lead is woken and the job pauses. */
	async recover(jr: JobRun, why: string): Promise<void> {
		if (jr.recovering || jr.ended || jr.stopRequested || jr.job.state !== "working") return;
		this.pump(jr);
		if (jr.ws.done !== undefined) {
			// it reported before it went down: the result counts
			void this.drive(jr);
			return;
		}
		jr.recovering = true;
		try {
			appendLog(jr.dir, { kind: "recover", text: why });
			this.dropWorker(jr);
			if ((jr.job.restarts ?? 0) >= 1) {
				this.pauseJob(jr, "working", `the worker ${why}; it was restarted once already`);
				this.d.wake(`relay job ${jr.job.id}: the worker ${why} again after a restart. The job is paused (the set is kept; /wt open ${jr.job.set} to look). relay_resume ${jr.job.id} restarts it, or relay_stop.`);
				return;
			}
			jr.job.restarts = 1;
			this.save(jr);
			this.d.notify(`relay job ${jr.job.id}: the worker ${why}; restarting it`);
			await this.startWorker(jr, { resume: true, prompt: `Your session was restarted because ${why}. Continue the job where you stopped: check git status and git log in the worktree first. If the work is finished, call report_done.` });
		} catch (e) {
			this.pauseJob(jr, "working", `restart failed: ${(e as Error).message}`);
			this.d.wake(`relay job ${jr.job.id}: the worker ${why} and could not be restarted (${(e as Error).message}). The job is paused; relay_resume or relay_stop.`);
		} finally {
			jr.recovering = false;
			if (!jr.driving && !jr.ended) void this.drive(jr);
		}
	}

	private knowledgeMcp(role: string): { servers: Record<string, Record<string, unknown>>; tools: string[] } | undefined {
		const k = this.cfg.knowledge;
		if (!k.server || !this.d.mcpServers) return undefined;
		const servers = forwardedServers(this.d.mcpServers(), k);
		if (!servers[k.server]) return undefined;
		return { servers, tools: roleTools(role, k) };
	}

	async review(role: "critic" | "judge", task: string, cwd: string, signal?: AbortSignal): Promise<RunResult> {
		const spec = this.cfg.roles[role];
		const file = path.isAbsolute(spec.prompt) ? spec.prompt : path.join(this.relayDir, spec.prompt);
		const k = this.knowledgeMcp(role);
		const run = this.d.runReviewer ?? runSubagent;
		return run({
			role: { model: spec.model, thinking: spec.thinking },
			systemPrompts: [fs.readFileSync(file, "utf8")],
			tools: [...spec.tools, ...(k?.tools ?? [])],
			task,
			cwd,
			extensions: [...this.cfg.reviewer.extensions, path.join(this.relayDir, "reviewer.ts")],
			timeoutMs: 30 * 60_000,
			idleTimeoutMs: 10 * 60_000,
			mcp: k ? { servers: k.servers, extension: path.join(this.relayDir, "mcp-forward.ts") } : undefined,
			env: k?.tools.length ? { RELAY_REVIEW_ALLOW: k.tools.join(",") } : undefined,
			trusted: this.d.trusted?.(),
			signal,
		});
	}

	// ------------------------------------------------------------------------------------------------ the watcher

	/** One poll: heartbeat, the worker's outbox, the budget. Drives only jobs that are working. */
	async tick(): Promise<void> {
		const now = this.now();
		await this.cascade();
		this.startQueued();
		for (const jr of [...this.jobs.values()]) {
			if (jr.ended || FINISHED.includes(jr.job.state)) continue;
			const dt = jr.lastTick ? now - jr.lastTick : 0;
			jr.lastTick = now;
			if (now - jr.lastBeat >= (this.d.heartbeatMs ?? 30_000)) {
				jr.lastBeat = now;
				if ((await jr.lock.heartbeat()) === "lost") {
					appendLog(jr.dir, { kind: "lost", text: "heartbeat: this lead no longer owns the job" });
					this.letGo(jr);
					continue;
				}
			}
			// a queued job is heartbeated (another lead must not take it over) but not pumped or budgeted
			if (jr.job.state === "queued") continue;
			this.pump(jr);
			if (jr.job.state === "working" || jr.job.state === "judging") jr.job.used.wallMs += dt;
			const b = budgetState(jr.job, this.cfg, now);
			if (b.state === "grace" && !jr.graceNotified) {
				jr.job.grace = b.grace;
				jr.graceNotified = true;
				this.d.notify(`relay job ${jr.job.id}: ${b.why} budget used up; grace window opens`);
				appendLog(jr.dir, { kind: "grace", text: b.why });
			} else if (b.state === "over" && jr.job.state !== "delivering") {
				jr.job.endReason = `budget: ${b.why}`;
				jr.job.state = "stopped";
				jr.stopRequested = true;
				jr.abort.abort();
				await jr.worker?.abort();
				this.save(jr);
				this.d.wake(`relay job ${jr.job.id}: stopped, ${b.why}. The set is kept.`);
				void this.drive(jr);
				continue;
			}
			this.save(jr);
			if (jr.job.state === "working" && jr.ws.alive && !jr.recovering && !jr.stopRequested) {
				// a tool past its timeout counts as a crash; a stall is no events for stallMin with no tool running
				const late = [...jr.tools.values()].find((t) => t.timeoutMs > 0 && now - t.startedAt > t.timeoutMs);
				if (late) void this.recover(jr, `ran the tool "${late.name}" past its ${Math.round(late.timeoutMs / 60_000)} min timeout`);
				else if (!jr.ws.settled && jr.tools.size === 0 && now - jr.lastActivity >= this.cfg.stallMin * 60_000) void this.recover(jr, `stalled (no events for ${this.cfg.stallMin} min)`);
			}
			if (jr.job.state === "working" && !jr.driving) void this.drive(jr);
		}
	}

	/** Reads new outbox messages: asks and approvals wake the lead, `done` is kept for the work step. */
	pump(jr: JobRun): void {
		const msgs = takeNew<OutMsg>(outboxPath(jr.dir), (l) => appendLog(jr.dir, { kind: "bad-line", text: l.slice(0, 80) }));
		for (const m of msgs) {
			if (m.type === "done") jr.ws.done = m.summary;
			else if (m.type === "note") appendLog(jr.dir, { kind: "note", text: m.text });
			else if (m.type === "ask") {
				jr.asks.set(m.id, m);
				jr.ws.openAsks.push(m.id);
				this.d.wake(`relay job ${jr.job.id}: the worker asks (${m.id}): ${m.question}\nAnswer with relay_approve {job: "${jr.job.id}", askId: "${m.id}", approve: true, reason: "<your answer>"}.`);
			} else if (m.type === "approval") {
				jr.asks.set(m.id, m);
				jr.ws.openAsks.push(m.id);
				this.d.wake(`relay job ${jr.job.id}: the worker asks approval (${m.id}) for [${m.category}] ${m.item}: ${m.why}\nrelay_approve {job: "${jr.job.id}", askId: "${m.id}", approve: true|false, reason}.`);
			}
		}
		if (msgs.length && jr.job.state === "working" && !jr.driving && jr.ws.done !== undefined) void this.drive(jr);
	}

	// ------------------------------------------------------------------------------------------------ the lead's tools

	private find(id: string): JobRun | { error: string } {
		const jr = this.jobs.get(id);
		return jr ?? { error: `unknown job "${id}" (relay_status lists the jobs of this session)` };
	}

	/** Answers a worker's ask or approval request. */
	approve(id: string, askId: string, approve: boolean, reason: string): { ok: true; text: string } | { error: string } {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		const ask = jr.asks.get(askId);
		if (!ask) return { error: `job ${id} has no open ask "${askId}"` };
		const inbox = inboxPath(jr.dir);
		const open = () => {
			jr.ws.openAsks = jr.ws.openAsks.filter((x) => x !== askId);
			jr.asks.delete(askId);
		};
		if (ask.type === "ask") {
			append(inbox, { type: "answer", replyTo: askId, text: reason });
			open();
			return { ok: true, text: "answered" };
		}
		if (ask.type !== "approval") return { error: "not an ask" };
		if (!(CATEGORIES as readonly string[]).includes(ask.category)) {
			append(inbox, { type: "refuse", replyTo: askId, reason: `unknown category ${ask.category}` });
			open();
			return { error: `unknown category "${ask.category}"` };
		}
		if (approve && this.cfg.askUser.includes(ask.category as Category)) return { error: `"${ask.category}" is in askUser: ask the user first, then relay_approve` };
		if (!approve) {
			append(inbox, { type: "refuse", replyTo: askId, reason });
			open();
			return { ok: true, text: "refused" };
		}
		const briefFile = path.join(jr.dir, "brief.md");
		fs.writeFileSync(briefFile, appendAmendment(fs.readFileSync(briefFile, "utf8"), "approval", `[${ask.category}] ${ask.item} approved: ${reason}`));
		jr.job.approvals.push({ at: new Date(this.now()).toISOString(), item: ask.item, category: ask.category, by: "lead", reason, ...(jr.job.followups ? { followup: jr.job.followups } : {}) });
		const p = parseBrief(fs.readFileSync(briefFile, "utf8"));
		if (!("errors" in p)) jr.job.briefVersion = p.version;
		this.save(jr);
		append(inbox, { type: "approve", replyTo: askId, reason });
		open();
		this.d.emit(APPROVAL, approvalPayload(id, ask.category, ask.item, "lead", reason));
		appendLog(jr.dir, { kind: "approval", text: `[${ask.category}] ${ask.item}: ${reason}` });
		return { ok: true, text: "approved" };
	}

	async stop(id: string, reason?: string): Promise<{ ok: true } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		if (jr.ended || FINISHED.includes(jr.job.state)) return { error: `job ${id} is already ${jr.job.state}` };
		if (!jr.lock.isOwner()) return { error: `this lead no longer owns job ${id}` };
		jr.stopRequested = true;
		jr.job.endReason = reason ?? "stopped by the lead";
		jr.job.state = "stopped";
		this.save(jr);
		jr.abort.abort();
		await jr.worker?.abort();
		await this.drive(jr);
		// a step that was running winds down and writes the report before stop returns
		while (jr.driving || jr.recovering) await new Promise((r) => setTimeout(r, 20));
		return { ok: true };
	}

	/** Re-runs delivery (or the judge when the job is paused or judging), with the approvals as they are now. */
	async deliver(id: string): Promise<{ ok: true; state: JobState } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		if (jr.ended || !["delivering", "paused", "judging"].includes(jr.job.state)) return { error: `job ${id} is ${jr.job.state}: only a job that passed (delivering), is paused or is judging can be delivered` };
		if (jr.job.state === "paused") {
			if (jr.job.paused && jr.job.paused.from !== "judging") return { error: `job ${id} is paused (${jr.job.paused.why}): ${jr.job.paused.why === "replan" ? "relay_replan" : "relay_resume"} continues it` };
			jr.job.state = "judging";
			delete jr.job.paused;
		}
		this.save(jr);
		await this.drive(jr);
		return { ok: true, state: jr.job.state };
	}

	// ------------------------------------------------------------------------------------------------ mid-run input (D9)

	private setBrief(jr: JobRun, text: string): void {
		fs.writeFileSync(path.join(jr.dir, "brief.md"), text);
		const p = parseBrief(text);
		if (!("errors" in p)) jr.job.briefVersion = p.version;
	}

	/** The critic reads only an amendment (a restart, a follow-up): `{ok}` unless it finds a blocker or major problem. */
	private async checkAmendment(dir: string, proposed: string, amendment: string, label: string): Promise<{ ok: true } | { error: string }> {
		const task = `Review only this amendment to a brief that is already running (do not re-review the rest of the brief).\n\n## Amendment\n\n${amendment}\n\n## The brief with the amendment\n\n${proposed}\n\nEnd with a VERDICT line.`;
		let res = await this.review("critic", task, this.d.leadCwd);
		if (!res.ok) res = await this.review("critic", task, this.d.leadCwd);
		if (!res.ok) return { error: `the critic failed twice (${res.error ?? "no output"}); nothing was changed` };
		fs.mkdirSync(path.join(dir, "critic"), { recursive: true });
		fs.writeFileSync(path.join(dir, "critic", `${label}.md`), `${res.text}\n`);
		const hard = parseFindings(res.text).filter((f) => f.severity === "blocker" || f.severity === "major");
		if (hard.length) return { error: `the critic found ${hard.length} blocker/major problem(s) in the amendment; nothing was changed. Revise the text and send it again:\n${hard.map((f) => `- ${f.head}`).join("\n")}` };
		return { ok: true };
	}

	/**
	 * An amendment to a running job: `steer` reaches a running worker (a prompt when it is idle; a steer still queued when it
	 * settles is sent as a prompt), `follow_up` is queued behind its current turn, `restart` drops the worker's approach.
	 */
	async send(id: string, text: string, mode: "steer" | "follow_up" | "restart", o: { reset?: "base" | "keep"; by?: "user" | "lead" } = {}): Promise<{ ok: true; version: number; how: string } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		if (jr.ended || FINISHED.includes(jr.job.state)) return { error: `job ${id} is ${jr.job.state}: relay_followup continues a finished job` };
		if (!text.trim()) return { error: "the text is empty" };
		if (mode === "restart") return this.restart(jr, text, o);
		const by = o.by ?? "user";
		const briefFile = path.join(jr.dir, "brief.md");
		const n = parseBriefVersion(fs.readFileSync(briefFile, "utf8"), jr.job.briefVersion);
		this.setBrief(jr, appendAmendment(fs.readFileSync(briefFile, "utf8"), by, text));
		this.save(jr);
		appendLog(jr.dir, { kind: "amendment", text: `${by} (${mode}): ${text.slice(0, 200)}` });
		const msg = `Amendment ${n} (${by}) to the brief: ${text}\nApply it, then finish with report_done.`;
		const gave = jr.job.briefVersion;
		const state = jr.job.state;
		if (state !== "working") {
			// judging and delivering notice the new version themselves; a paused or queued job reads it when it (re)starts
			if ((state === "judging" || state === "delivering") && !jr.driving) void this.drive(jr);
			return { ok: true, version: jr.job.briefVersion, how: state === "paused" || state === "queued" ? "held until the job continues" : "held: the verdict on the old version is discarded and the worker is sent back" };
		}
		this.pump(jr);
		if (jr.ws.done !== undefined) return { ok: true, version: jr.job.briefVersion, how: "held: the worker had just reported done; the judge's verdict on the old version is discarded and the worker is sent back" };
		if (!jr.worker || jr.ws.exited || !jr.ws.alive) {
			await this.ctxFor(jr).prompt(msg);
			jr.job.workerVersion = gave;
			return { ok: true, version: jr.job.briefVersion, how: "sent to a restarted worker" };
		}
		if (jr.ws.settled) {
			await this.ctxFor(jr).prompt(msg);
			jr.job.workerVersion = gave;
			return { ok: true, version: jr.job.briefVersion, how: "sent as a prompt (the worker was idle)" };
		}
		if (mode === "steer") {
			const r = await jr.worker.steer(msg);
			if (!r.success) return { error: `the worker did not accept the steer: ${r.error ?? "no response"}` };
			jr.pendingSteer = jr.pendingSteer ? `${jr.pendingSteer}\n\n${msg}` : msg;
			jr.steerVersion = gave;
			return { ok: true, version: jr.job.briefVersion, how: "steered (reaches the worker at its next step)" };
		}
		const r = await jr.worker.followUp(msg);
		if (!r.success) return { error: `the worker did not accept the follow-up: ${r.error ?? "no response"}` };
		jr.job.workerVersion = gave;
		return { ok: true, version: jr.job.briefVersion, how: "queued behind the worker's current turn" };
	}

	private async restart(jr: JobRun, text: string, o: { reset?: "base" | "keep"; by?: "user" | "lead" }): Promise<{ ok: true; version: number; how: string } | { error: string }> {
		const job = jr.job;
		if (job.state !== "working" && job.state !== "paused") return { error: `job ${job.id} is ${job.state}: a restart needs a working or paused job (send a steer instead, or relay_stop)` };
		if (job.paused?.why === "replan") return { error: `job ${job.id} waits for a re-plan: relay_replan {job, brief}, or relay_stop` };
		if (jr.recovering) return { error: `job ${job.id} is being restarted already` };
		const reset = o.reset ?? "keep";
		const briefFile = path.join(jr.dir, "brief.md");
		const old = fs.readFileSync(briefFile, "utf8");
		const body = `${text}\n(restart: the previous approach is dropped${reset === "base" ? ", the branch is reset to its base" : ""})`;
		const proposed = appendAmendment(old, o.by ?? "user", body);
		const n = parseBriefVersion(old, job.briefVersion);
		jr.recovering = true;
		try {
			const checked = await this.checkAmendment(jr.dir, proposed, body, `amendment-${n}`);
			if ("error" in checked) return checked;
			// the critic took a while: the job may have moved on (a stop, the end of the job)
			if (jr.ended || jr.stopRequested || (job.state !== "working" && job.state !== "paused") || job.paused?.why === "replan") return { error: `job ${job.id} moved on while the critic checked the amendment (now ${job.state}); send it again` };
			this.dropWorker(jr);
			if (reset === "base") {
				for (const r of job.repos) {
					// a follow-up resets to where the follow-up began, never into the job's earlier work
					await this.d.run("git", ["rebase", "--abort"], r.worktree);
					await this.d.run("git", ["reset", "-q", "--hard", r.followBase ?? r.base], r.worktree);
					await this.d.run("git", ["clean", "-fdq"], r.worktree);
					// the lead's edits are part of the job's base: they come back (a follow-up's base already holds them)
					if (r.leadEdits && !r.followBase) {
						const ap = await applySnapshot(this.d.run, r.worktree, r.leadEdits.sha);
						if (!ap.ok) job.notes.push(`restart: the lead's edits did not re-apply in ${r.key} (${ap.conflicts.join(", ") || ap.error})`);
					}
				}
			}
			this.setBrief(jr, proposed);
			job.restarts = 0;
			delete job.paused;
			job.state = "working";
			this.save(jr);
			appendLog(jr.dir, { kind: "restart", text: `${o.by ?? "user"}: ${text.slice(0, 200)} (reset ${reset})` });
			this.d.notify(`relay job ${job.id}: restarted on amendment ${n}`);
			await this.startWorker(jr, { prompt: workerPrompt(this.ctxFor(jr), job, `Restart: the previous approach is dropped. ${text}\n${reset === "base" ? "The branch was reset to its base (the lead's edits are applied again)." : "Your earlier commits are still on the branch: keep what still fits."}`) });
			return { ok: true, version: job.briefVersion, how: `restarted (${reset})` };
		} catch (e) {
			return { error: `restart failed: ${(e as Error).message}` };
		} finally {
			jr.recovering = false;
			if (!jr.driving && !jr.ended) void this.drive(jr);
		}
	}

	/** Pauses a working job: the worker is aborted and stopped, the set is the user's (`/wt open`). */
	async pause(id: string): Promise<{ ok: true } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		if (jr.job.state !== "working") return { error: `job ${id} is ${jr.job.state}: only a working job can be paused` };
		if (jr.recovering) return { error: `job ${id} is being restarted; try again in a moment` };
		jr.recovering = true;
		try {
			const w = jr.worker;
			await w?.abort();
			this.dropWorker(jr);
			await w?.stop(5000);
			this.pauseJob(jr, "working", "paused by the lead");
			return { ok: true };
		} finally {
			jr.recovering = false;
			if (!jr.driving && !jr.ended) void this.drive(jr);
		}
	}

	/** Continues a paused job: a worker is restarted with `-c`, or the judge runs again. */
	async resume(id: string): Promise<{ ok: true; state: JobState } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		const job = jr.job;
		if (jr.ended || job.state !== "paused") return { error: `job ${id} is ${job.state}, not paused` };
		const p = job.paused ?? { from: "judging" as const, why: "" };
		if (p.why === "replan") return { error: `job ${id} waits for a re-plan: relay_replan {job, brief}, or relay_stop` };
		delete job.paused;
		if (p.from === "judging") {
			job.state = "judging";
			this.save(jr);
			await this.drive(jr);
			return { ok: true, state: job.state };
		}
		job.state = "working";
		job.restarts = 0;
		this.save(jr);
		appendLog(jr.dir, { kind: "resume", text: p.why });
		try {
			this.dropWorker(jr);
			await this.startWorker(jr, { resume: true, prompt: workerPrompt(this.ctxFor(jr), job, "The job was paused and is resumed; your session continues. Check git status and git log first, and read the brief again: it may have been amended while paused.") });
		} catch (e) {
			this.pauseJob(jr, "working", `resume failed: ${(e as Error).message}`);
			return { error: `could not restart the worker: ${(e as Error).message}` };
		}
		return { ok: true, state: job.state };
	}

	/** A re-plan after the judge and escalated rounds ran out: a revised brief, a new session on the same worktree. */
	async replan(id: string, newBrief: string): Promise<{ ok: true; version: number } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		const job = jr.job;
		if (jr.ended || job.state !== "paused" || job.paused?.why !== "replan") return { error: `job ${id} is not waiting for a re-plan` };
		if (job.replans >= this.cfg.caps.replans) return { error: `job ${id} used its ${this.cfg.caps.replans} re-plan(s)` };
		const checked = checkBrief(newBrief);
		if ("errors" in checked) return { error: `the brief is not complete:\n- ${checked.errors.join("\n- ")}` };
		const briefFile = path.join(jr.dir, "brief.md");
		const old = fs.readFileSync(briefFile, "utf8");
		const was = parseBrief(old);
		const key = (t: { repo: string; branch: string }[]) => t.map((x) => `${x.repo}:${x.branch}`).join("|");
		if (!("errors" in was) && key(was.targets) !== key(checked.brief.targets)) return { error: "the Targets of a job cannot change in a re-plan (dispatch a new job for other repos)" };
		fs.writeFileSync(path.join(jr.dir, `brief.before-replan-${job.replans + 1}.md`), old);
		this.setBrief(jr, replaceBrief(old, newBrief, `re-plan ${job.replans + 1}: the brief was revised after ${job.round} failed rounds`));
		for (const c of CATEGORIES) {
			const a = checked.brief.authority[c];
			if (a?.value === "yes" && !job.approvals.some((x) => x.category === c && x.item === (a.specifics ?? "*"))) job.approvals.push({ at: new Date(this.now()).toISOString(), item: a.specifics ?? "*", category: c, by: "lead", reason: "Authority in the re-planned brief", ...(job.followups ? { followup: job.followups } : {}) });
		}
		job.replans++;
		job.round = 0;
		job.escalated = 0;
		job.restarts = 0;
		delete job.paused;
		job.state = "working";
		this.save(jr);
		appendLog(jr.dir, { kind: "replan", text: `re-plan ${job.replans}` });
		this.d.notify(`relay job ${job.id}: re-planned (${job.replans}/${this.cfg.caps.replans}); a new worker session starts on the same worktree`);
		this.dropWorker(jr);
		try {
			await this.startWorker(jr, { prompt: workerPrompt(this.ctxFor(jr), job, `Re-plan: the previous approach failed the judge repeatedly. The worktree holds the last attempt; rework it as the revised brief says. The judge's last findings are in ${path.join(jr.dir, "judge")}.`) });
		} catch (e) {
			this.pauseJob(jr, "working", `re-plan start failed: ${(e as Error).message}`);
			return { error: `could not start the worker: ${(e as Error).message}` };
		}
		return { ok: true, version: job.briefVersion };
	}

	// ------------------------------------------------------------------------------------------------ follow-ups (S29)

	/** A follow-up on a done, stopped or failed job: an amendment of the same job, with a workspace chosen by the followup step. */
	async followup(id: string, text: string): Promise<{ ok: true; n: number; queued: boolean } | { error: string }> {
		const known = this.jobs.get(id);
		const dir = jobDir(this.d.root, id);
		const job = known?.job ?? readJob(dir);
		if (!job) return { error: `unknown job "${id}"` };
		if (!FINISHED.includes(job.state)) return { error: `job ${id} is ${job.state}: relay_send amends a running job` };
		if (known && !known.ended) return { error: `job ${id} is still finishing; try again in a moment` };
		if (!text.trim()) return { error: "the text is empty" };
		if (job.repos.some((r) => r.merged) && !job.repos.every((r) => r.merged)) return { error: `job ${id} merged only some of its repos; start a new job for the follow-up` };
		const lock = new JobLock(dir, this.d.me);
		if (!(lock.acquire() || (await lock.takeOver()))) return { error: `job ${id} is driven by another lead` };
		const briefFile = path.join(dir, "brief.md");
		const old = fs.readFileSync(briefFile, "utf8");
		const n = (job.followups ?? 0) + 1;
		const proposed = appendAmendment(old, "user", text);
		const checked = await this.checkAmendment(dir, proposed, text, `followup-${n}`);
		if ("error" in checked) {
			lock.release();
			return checked;
		}
		fs.writeFileSync(briefFile, proposed);
		const p = parseBrief(proposed);
		if (!("errors" in p)) job.briefVersion = p.version;
		const report = path.join(dir, "report.md");
		if (fs.existsSync(report)) fs.renameSync(report, path.join(dir, `report.before-followup-${n}.md`));
		job.followupPending = { n, text };
		job.followupTexts = [...(job.followupTexts ?? [])];
		job.followupTexts[n - 1] = text;
		job.state = "queued";
		const jr = new JobRun(dir, job, lock);
		this.jobs.set(id, jr);
		this.save(jr);
		appendLog(dir, { kind: "followup", text: `follow-up ${n}: ${text.slice(0, 200)}` });
		if (this.runningCount() >= this.cfg.maxJobs) return { ok: true, n, queued: true };
		void this.drive(jr);
		return { ok: true, n, queued: false };
	}

	// ------------------------------------------------------------------------------------------------ resume, adoption, PR-only cleanup (S27)

	/** Unfinished jobs under the root that no live lead drives: re-attached (same session) or taken over (stale lock), then continued. */
	async adopt(): Promise<string[]> {
		const adopted: string[] = [];
		for (const { dir, job } of listJobs(this.root)) {
			if (FINISHED.includes(job.state) || this.jobs.has(job.id)) continue;
			const lock = new JobLock(dir, this.d.me);
			let how: string;
			if (lock.attach()) how = "re-attached";
			else if (await lock.takeOver()) how = "taken over";
			else continue; // a live lead owns it
			const jr = new JobRun(dir, job, lock);
			this.jobs.set(job.id, jr);
			const was = job.state;
			if (how === "taken over" && job.worker?.pid && lock.previous && lock.previous !== "unreadable" && lock.previous.host === this.d.me.host) killSurvivor(job.worker.pid);
			job.restarts = 0;
			appendLog(dir, { kind: "adopted", text: `${how}; was ${was}` });
			try {
				if (was === "working") {
					this.pump(jr);
					if (jr.ws.done !== undefined) void this.drive(jr);
					else await this.startWorker(jr, { resume: true, prompt: workerPrompt(this.ctxFor(jr), job, "The lead was restarted and took this job over; your session continues. Check git status and git log first. If the work is finished, call report_done (again).") });
				} else if (was === "queued" && !job.followupPending && (job.repos.length > 0 || job.cwd)) {
					job.endReason = "the lead went away while the job was being set up";
					job.state = "failed";
					this.save(jr);
					void this.drive(jr);
				} else if (was === "queued") {
					// startQueued decides: it honours maxJobs and a predecessor that has not passed (D17)
				} else if (was !== "paused") void this.drive(jr);
				this.d.notify(`relay job ${job.id}: ${how} after the lead went away (was ${was}); ${was === "paused" ? "still paused" : "continuing"}`);
				adopted.push(job.id);
			} catch (e) {
				this.pauseJob(jr, "working", `adoption failed: ${(e as Error).message}`);
				this.d.wake(`relay job ${job.id}: ${how}, but its worker could not be restarted (${(e as Error).message}). The job is paused; relay_resume or relay_stop.`);
			}
		}
		this.startQueued();
		return adopted;
	}

	/** Done PR-only jobs whose pull request has merged since: mark them merged and remove their kept set (W2, no force). */
	async prCleanup(): Promise<string[]> {
		const out: string[] = [];
		for (const { dir, job: onDisk } of listJobs(this.root)) {
			const jr = this.jobs.get(onDisk.id);
			if (jr && !jr.ended) continue;
			const job = jr?.job ?? onDisk;
			if (job.state !== "done" || job.repos.every((r) => r.merged || !r.pr) || !job.repos.some((r) => r.pr && !r.merged)) continue;
			const mergedNow: typeof job.repos = [];
			for (const r of job.repos) {
				if (!r.pr || r.merged) continue;
				const v = await this.d.run("gh", ["pr", "view", r.pr, "--json", "state,mergeCommit"], r.main);
				if (v.code !== 0) {
					appendLog(dir, { kind: "pr-check", text: `gh pr view failed in ${r.key}: ${v.stderr.trim().split("\n")[0]}` });
					continue;
				}
				let state = "";
				try {
					state = String(JSON.parse(v.stdout).state ?? "");
				} catch {
					// not JSON: try again next tick
				}
				if (state !== "MERGED") continue;
				mergedNow.push(r);
				appendLog(dir, { kind: "pr-merged", text: `${r.key}: ${r.pr}` });
			}
			if (!mergedNow.length) continue;
			// another lead may have started a follow-up on this job while gh was asked
			const cur = readJob(dir);
			if (!cur || cur.state !== "done" || (cur.followups ?? 0) !== (job.followups ?? 0)) continue;
			for (const r of mergedNow) r.merged = true;
			if (job.repos.every((r) => r.merged || !r.pr)) {
				const rm = await this.d.wt.remove({ name: job.set });
				const msg = "error" in rm ? `set ${job.set} kept: ${rm.error}` : rm.kept.length ? `set ${job.set} removed, branches kept: ${rm.kept.join(", ")}` : `set ${job.set} removed (the PR merged)`;
				job.notes.push(msg);
				appendLog(dir, { kind: "cleanup", text: msg });
				if ("error" in rm || rm.kept.length) this.d.notify(`relay job ${job.id}: ${msg}`);
			}
			writeJob(dir, job);
			out.push(job.id);
		}
		return out;
	}

	/** Stacked jobs whose predecessor merged since they were delivered: delivery runs again, which restacks them onto the target, retargets the PR and pushes with the lease (D17). */
	async restack(): Promise<string[]> {
		const out: string[] = [];
		for (const { dir, job } of listJobs(this.root)) {
			if (job.state !== "done" || !job.repos.some((r) => r.stackedOn)) continue;
			const known = this.jobs.get(job.id);
			if (known && !known.ended) continue;
			const cur = known?.job ?? job;
			if (!cur.repos.some((r) => stackState(r, r.stackedOn ? this.peek(r.stackedOn.job) : undefined) === "merged")) continue;
			const lock = new JobLock(dir, this.d.me);
			if (!(lock.acquire() || (await lock.takeOver()))) continue;
			cur.state = "delivering";
			cur.notes.push("the predecessor merged: restacking onto the target");
			const jr = new JobRun(dir, cur, lock);
			this.jobs.set(cur.id, jr);
			this.save(jr);
			appendLog(dir, { kind: "restack", text: "the predecessor merged: rebase --onto the target, retarget the PR, push with the lease" });
			await this.drive(jr);
			out.push(cur.id);
		}
		return out;
	}

	/** W3 mid-job (S32): another repo joins the set; the judge diff and delivery include it from now on, and the worker is told. */
	async addRepo(id: string, folder: string, target: string, askId?: string): Promise<{ ok: true; key: string; path: string; branch: string } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		const job = jr.job;
		if (jr.ended || (job.state !== "working" && job.state !== "paused")) return { error: `job ${id} is ${job.state}: a repo can be added to a working or paused job` };
		const ctx = this.ctxFor(jr);
		const main = await resolveRepo(ctx, folder);
		if (!main) return { error: `"${folder}" is not a git repo` };
		if (job.repos.some((r) => r.main.toLowerCase() === main.toLowerCase())) return { error: `repo ${folder} is already in job ${id}` };
		await this.d.run("git", ["fetch", "origin"], main);
		const base = (await this.d.run("git", ["rev-parse", `origin/${target}`], main)).stdout.trim();
		if (!base) return { error: `origin/${target} not found in ${folder}` };
		const r = await this.d.wt.addRepo({ name: job.set, folder: main, base: `origin/${target}` });
		if ("error" in r) return { error: r.error };
		const state: RepoState = { key: folder, main, worktree: r.path.split("\\").join("/"), target, base, branch: r.branch };
		job.repos.push(state);
		// the worker guard's sensitive paths cover the new repo too
		try {
			const gf = path.join(jr.dir, "guard.json");
			const g = JSON.parse(fs.readFileSync(gf, "utf8"));
			g.sensitivePaths = [...new Set([...(g.sensitivePaths ?? []), ...repoPolicy(this.cfg, main).sensitivePaths])];
			fs.writeFileSync(gf, JSON.stringify(g, null, 2));
		} catch {
			// the guard keeps the paths it has
		}
		this.save(jr);
		appendLog(jr.dir, { kind: "add-repo", text: `${folder} -> ${target} at ${state.worktree} (branch ${r.branch})` });
		const ask = askId ? jr.asks.get(askId) : undefined;
		if (askId && ask) {
			// answers the ask without granting anything: an approval request is not approved by adding a repo
			if (ask.type === "ask") this.approve(id, askId, true, `repo ${folder} added at ${state.worktree}`);
			else {
				append(inboxPath(jr.dir), { type: "answer", replyTo: askId, text: `repo ${folder} added at ${state.worktree}; nothing was approved` });
				jr.ws.openAsks = jr.ws.openAsks.filter((x) => x !== askId);
				jr.asks.delete(askId);
			}
		}
		const told = await this.send(id, `Repo ${folder} is part of this job now: work in ${state.worktree} (branch ${r.branch}, target ${target}). It is judged and delivered with the rest.`, "steer", { by: "lead" });
		if ("error" in told) appendLog(jr.dir, { kind: "error", text: `add-repo: the worker was not told: ${told.error}` });
		return { ok: true, key: folder, path: state.worktree, branch: r.branch };
	}

	/** `/relay log`: the last n summarised log lines and the job's paths. */
	logText(id: string, n = 20): string {
		const jr = this.jobs.get(id);
		const dir = jr?.dir ?? jobDir(this.d.root, id);
		const job = jr?.job ?? readJob(dir);
		if (!job) return `unknown job "${id}"`;
		const lines = readLog(dir, Math.max(1, n)).map((e) => `${(e.at ?? "").slice(11, 19)} ${e.kind}: ${e.text}`);
		const paths = [`job folder: ${dir}`, `log: ${path.join(dir, "log.jsonl")}`, `set: ${job.set}${job.cwd ? ` (${job.cwd})` : ""}`, `brief: ${path.join(dir, "brief.md")}`, `report: ${path.join(dir, "report.md")}`];
		return `${lines.join("\n") || "(no log lines)"}\n\n${paths.join("\n")}`;
	}

	/** One line per job of this session that is not finished: id, state, round and budget used. */
	widgetLines(): string[] {
		return [...this.jobs.values()]
			.filter((j) => !j.ended && !FINISHED.includes(j.job.state))
			.map((jr) => {
				const j = jr.job;
				const wall = Math.round(j.used.wallMs / 60_000);
				return `relay ${j.id} ${j.state} r${j.round + 1}${j.escalated ? "e" : ""} ${wall}/${Math.round(j.budget.wallMs / 60_000)}m ${Math.round((j.used.tokens / j.budget.tokens) * 100)}% tok${j.dependsOn ? ` <- ${j.dependsOn}` : ""}`;
			});
	}

	status(id?: string): string {
		const rows = [...this.jobs.values()].filter((j) => !id || j.job.id === id);
		if (!rows.length) return id ? `unknown job "${id}"` : "no jobs in this session";
		return rows
			.map((jr) => {
				const j = jr.job;
				const files = j.repos.map((r) => `${r.key}${r.merged ? " (merged)" : r.pr ? ` (PR ${r.pr})` : ""}`).join(", ");
				const budget = `${Math.round(j.used.wallMs / 60_000)}/${Math.round(j.budget.wallMs / 60_000)} min, ${j.used.tokens}/${j.budget.tokens} tokens`;
				const v = j.lastVerdict ? `${j.lastVerdict.verdict} (round ${j.lastVerdict.round}: ${j.lastVerdict.blockers}b ${j.lastVerdict.majors}m ${j.lastVerdict.minors}n)` : "none yet";
				const lines = readLog(jr.dir, 5).map((l) => `    ${l.kind}: ${l.text}`).join("\n");
				return `${j.id} [${j.state}] ${j.title}\n  repos: ${files || "-"}\n  round ${j.round + 1}, last verdict: ${v}\n  budget: ${budget}${j.paused ? `
  paused: ${j.paused.why}` : ""}${j.endReason ? `\n  ended: ${j.endReason}` : ""}${j.notes.length ? `\n  notes: ${j.notes.slice(-3).join("; ")}` : ""}\n  log:\n${lines || "    -"}`;
			})
			.join("\n\n");
	}

	get(id: string): JobRun | undefined {
		return this.jobs.get(id);
	}
}

export { readJob };
