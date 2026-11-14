/** The engine: runs the step modules of each job, the queue and the concurrency limit (D12). The lead's tools and the watcher call into it. */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { countTokens } from "../shared/tokens.ts";
import { APPROVAL, approvalPayload } from "./events.ts";
import { appendAmendment, checkBrief, parseBrief } from "./brief.ts";
import { budgetState, longToolWall } from "./budget.ts";
import { CATEGORIES, type Category, type RelayConfig, type Size } from "./config.ts";
import { type Job, type JobState, appendLog, draftDir, emptyJob, FINISHED, jobDir, newId, readJob, readLog, writeJob } from "./job.ts";
import { JobLock, type Me } from "./lock.ts";
import { append, inboxPath, outboxPath, takeNew, type OutMsg } from "./mailbox.ts";
import { forwardedServers, roleTools } from "./knowledge.ts";
import { type RpcCallbacks, type RpcWorker, startWorker as realStartWorker, type WorkerOpts } from "./rpc.ts";
import type { Run } from "./sh.ts";
import { runSubagent, type RunOptions, type RunResult } from "./subagent.ts";
import { dispatchStep } from "./steps/dispatch.ts";
import { deliverStep } from "./steps/deliver.ts";
import { judgeStep, workStep } from "./steps/loop.ts";
import { cleanupStep, reportStep } from "./steps/report.ts";
import type { Shell, Step, StepCtx, StepName, Wt, WorkerState } from "./types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The steps, by name. A new step is one module plus one entry here. */
export const STEPS: Record<StepName, Step> = {
	dispatch: dispatchStep,
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
	constructor(dir: string, job: Job, lock: JobLock) {
		this.dir = dir;
		this.job = job;
		this.lock = lock;
	}
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
		for (const jr of this.jobs.values()) jr.worker?.kill();
	}

	/** Jobs that hold a slot: started and not finished. */
	runningCount(): number {
		return [...this.jobs.values()].filter((j) => !j.ended && ((j.job.state !== "queued" && j.job.state !== "draft") || j.driving)).length;
	}
	ownedRunning(): number {
		return [...this.jobs.values()].filter((j) => !j.ended && !FINISHED.includes(j.job.state)).length;
	}

	private save(jr: JobRun) {
		writeJob(jr.dir, jr.job);
	}

	// ------------------------------------------------------------------------------------------------ dispatch

	async dispatch(input: { brief: string; size?: Size; overrides?: Job["overrides"]; draft?: string }): Promise<{ id: string; state: JobState; queued: boolean } | { error: string }> {
		const checked = checkBrief(input.brief);
		if ("errors" in checked) return { error: `the brief is not complete:\n- ${checked.errors.join("\n- ")}` };
		const brief = checked.brief;
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
		if (brief.dependsOn) job.notes.push(`Depends on ${brief.dependsOn}: dependent jobs are not supported yet; the job runs on its own`);
		if (input.draft && /^d[0-9a-z]{6}$/.test(input.draft)) {
			const src = path.join(draftDir(this.d.root, input.draft), "critic");
			if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, "critic"), { recursive: true });
		}
		const jr = new JobRun(dir, job, lock);
		this.jobs.set(id, jr);
		for (const a of job.approvals) this.d.emit(APPROVAL, approvalPayload(id, a.category, a.item, "brief", a.reason));
		if (this.runningCount() >= cfg.maxJobs) {
			job.state = "queued";
			this.save(jr);
			appendLog(dir, { kind: "queued", text: `queued behind ${cfg.maxJobs} running jobs` });
			return { id, state: "queued", queued: true };
		}
		job.state = "queued";
		this.save(jr);
		void this.drive(jr);
		return { id, state: job.state, queued: false };
	}

	private startQueued() {
		for (const jr of [...this.jobs.values()].sort((a, b) => a.job.createdAt - b.job.createdAt)) {
			if (this.runningCount() >= this.cfg.maxJobs) return;
			if (jr.job.state === "queued" && !jr.ended && !jr.driving) void this.drive(jr);
		}
	}

	// ------------------------------------------------------------------------------------------------ driving

	private initialStep(jr: JobRun): StepName | undefined {
		switch (jr.job.state) {
			case "queued":
				return "dispatch";
			case "working":
				return "work";
			case "judging":
			case "paused":
				return "judge";
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
						break;
					}
					// a worker's last message may not be read yet when its settle arrives
					if (step === "work") this.pump(jr);
					const s = STATE_OF[step];
					if (s && jr.job.state !== s) jr.job.state = s;
					this.save(jr);
					let next: StepName | "wait" | "end";
					try {
						next = await STEPS[step].run(jr.job, this.ctxFor(jr));
					} catch (e) {
						appendLog(jr.dir, { kind: "error", text: `${step}: ${(e as Error).message}` });
						if (step === "report" || step === "cleanup") next = "end";
						else {
							jr.job.endReason = `${step} step failed: ${(e as Error).message}`;
							jr.job.state = "failed";
							this.d.wake(`relay job ${jr.job.id}: the ${step} step failed: ${(e as Error).message}. The job is failed; its set is kept.`);
							next = "report";
						}
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

	private finish(jr: JobRun) {
		jr.ended = true;
		jr.lock.release();
		this.save(jr);
		this.startQueued();
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
			wt: d.wt,
			worker: jr.ws,
			startWorker: (job, o) => this.startWorker(jr, o),
			prompt: async (text) => {
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
			review: (role, task, cwd) => this.review(role, task, cwd),
			emit: (n, p) => d.emit(n, p),
			now: () => this.now(),
			relayDir: this.relayDir,
			leadCwd: d.leadCwd,
			folders: d.folders,
		};
	}

	private async startWorker(jr: JobRun, o: { prompt: string; resume?: boolean }): Promise<void> {
		const cfg = this.cfg;
		const spec = cfg.roles.worker[jr.job.size];
		const sessionDir = path.join(jr.dir, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		const k = this.knowledgeMcp("worker");
		const cb: RpcCallbacks = {
			onUsage: (u) => {
				jr.job.used.tokens += countTokens(u, cfg.tokenWeights).cost;
			},
			onSettled: () => {
				jr.ws.settled = true;
				if (jr.job.state === "working") void this.drive(jr);
			},
			onExit: () => {
				jr.ws.exited = true;
				jr.ws.alive = false;
				if (!jr.ended && jr.job.state === "working") void this.drive(jr);
			},
		};
		const start = this.d.startWorker ?? realStartWorker;
		jr.ws.exited = false;
		jr.ws.settled = false;
		jr.worker = start(
			{
				cwd: jr.job.cwd ?? jr.job.repos[0].worktree,
				model: spec.model,
				thinking: spec.thinking,
				sessionDir,
				resume: o.resume,
				trusted: this.d.trusted?.(),
				extensions: cfg.worker.extensions,
				mcp: k?.servers,
				env: { RELAY_JOB: jr.job.id, RELAY_JOB_DIR: jr.dir },
			},
			cb,
		);
		jr.ws.alive = true;
		jr.job.worker = { pid: jr.worker.pid ?? 0, model: spec.model, sessionDir };
		this.save(jr);
		const r = await jr.worker.prompt(o.prompt);
		if (!r.success) throw new Error(`the worker did not accept its first prompt: ${r.error ?? "no response"}`);
	}

	private knowledgeMcp(role: string): { servers: Record<string, Record<string, unknown>>; tools: string[] } | undefined {
		const k = this.cfg.knowledge;
		if (!k.server || !this.d.mcpServers) return undefined;
		const servers = forwardedServers(this.d.mcpServers(), k);
		if (!servers[k.server]) return undefined;
		return { servers, tools: roleTools(role, k) };
	}

	async review(role: "critic" | "judge", task: string, cwd: string): Promise<RunResult> {
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
			extensions: [path.join(this.relayDir, "reviewer.ts")],
			timeoutMs: 30 * 60_000,
			idleTimeoutMs: 10 * 60_000,
			mcp: k ? { servers: k.servers, extension: path.join(this.relayDir, "mcp-forward.ts") } : undefined,
			env: k?.tools.length ? { RELAY_REVIEW_ALLOW: k.tools.join(",") } : undefined,
			trusted: this.d.trusted?.(),
		});
	}

	// ------------------------------------------------------------------------------------------------ the watcher

	/** One poll: heartbeat, the worker's outbox, the budget. Drives only jobs that are working. */
	async tick(): Promise<void> {
		const now = this.now();
		for (const jr of [...this.jobs.values()]) {
			if (jr.ended || FINISHED.includes(jr.job.state) || jr.job.state === "queued") continue;
			const dt = jr.lastTick ? now - jr.lastTick : 0;
			jr.lastTick = now;
			if (now - jr.lastBeat >= (this.d.heartbeatMs ?? 30_000)) {
				jr.lastBeat = now;
				if ((await jr.lock.heartbeat()) === "lost") {
					appendLog(jr.dir, { kind: "lost", text: "heartbeat: this lead no longer owns the job" });
					continue;
				}
			}
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
				await jr.worker?.abort();
				this.save(jr);
				this.d.wake(`relay job ${jr.job.id}: stopped, ${b.why}. The set is kept.`);
				void this.drive(jr);
				continue;
			}
			this.save(jr);
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
		jr.job.approvals.push({ at: new Date(this.now()).toISOString(), item: ask.item, category: ask.category, by: "lead", reason });
		const p = parseBrief(fs.readFileSync(briefFile, "utf8"));
		if (!("errors" in p)) jr.job.briefVersion = p.version;
		this.save(jr);
		append(inbox, { type: "approve", replyTo: askId, reason });
		open();
		this.d.emit(APPROVAL, approvalPayload(id, ask.category, ask.item, "lead", reason));
		appendLog(jr.dir, { kind: "approval", text: `[${ask.category}] ${ask.item}: ${reason}` });
		return { ok: true, text: "approved" };
	}

	async stop(id: string): Promise<{ ok: true } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		if (jr.ended || FINISHED.includes(jr.job.state)) return { error: `job ${id} is already ${jr.job.state}` };
		await jr.worker?.abort();
		jr.job.endReason = "stopped by the lead";
		jr.job.state = "stopped";
		this.save(jr);
		await this.drive(jr);
		return { ok: true };
	}

	/** Re-runs delivery (or the judge when the job is paused or judging), with the approvals as they are now. */
	async deliver(id: string): Promise<{ ok: true; state: JobState } | { error: string }> {
		const jr = this.find(id);
		if ("error" in jr) return jr;
		if (jr.ended || !["delivering", "paused", "judging"].includes(jr.job.state)) return { error: `job ${id} is ${jr.job.state}: only a job that passed (delivering), is paused or is judging can be delivered` };
		if (jr.job.state === "paused") jr.job.state = "judging";
		this.save(jr);
		await this.drive(jr);
		return { ok: true, state: jr.job.state };
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
				return `${j.id} [${j.state}] ${j.title}\n  repos: ${files || "-"}\n  round ${j.round + 1}, last verdict: ${v}\n  budget: ${budget}${j.endReason ? `\n  ended: ${j.endReason}` : ""}${j.notes.length ? `\n  notes: ${j.notes.slice(-3).join("; ")}` : ""}\n  log:\n${lines || "    -"}`;
			})
			.join("\n\n");
	}

	get(id: string): JobRun | undefined {
		return this.jobs.get(id);
	}
}

export { readJob };
