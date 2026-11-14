/**
 * The lead side of relay: activation (K16), the prompt, the typed "go", the edit budget, the action log, the tools and the commands.
 * Everything pi-specific arrives through `pi` and `LeadDeps`, so tests drive it with a fake `pi` (index.ts is the thin wiring).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseRoleSpec } from "../shared/roles.ts";
import { emitClaims } from "../shared/claims.ts";
import { classifyCommand } from "./authority.ts";
import { editBudgetProblem, measureEdits } from "./budget.ts";
import { type RelayConfig, configPath, loadConfig, repoPolicy, saveRole } from "./config.ts";
import { Engine } from "./engine.ts";
import { Activation, parseControl, parseDispatch, parseFlowActive, parseHosted, parseJobQuery, type Tag } from "./events.ts";
import { foldersFromEntries } from "./folders.ts";
import { jobRoot } from "./job.ts";
import { type Run, run as realRun } from "./sh.ts";
import { runCritic } from "./steps/critic.ts";
import type { EngineDeps } from "./engine.ts";
import type { Size } from "./config.ts";
import type { Wt } from "./types.ts";

export const KICKOFF = "Go. Write the brief now (all sections, Authority with all six categories), run relay_critic on it, revise on its findings (up to 3 rounds, passing the draft id back), then relay_dispatch it. After that, tell me the job id and stop; relay reports when it is done.";

export interface LeadDeps {
	/** typebox's `Type` (injected so tests need no packages). */
	Type: any;
	getAgentDir: () => string;
	cwd: string;
	run?: Run;
	env?: Record<string, string | undefined>;
	relayDir: string;
	/** Test seams, passed to the engine. */
	engine?: Partial<EngineDeps>;
	timeoutMs?: number;
	/** The interval of the adoption scan (default 10 min). */
	scanMs?: number;
	widgetMs?: number;
}

const text = (t: string, details: object = {}) => ({ content: [{ type: "text" as const, text: t }], details });
const fwd = (p: string) => p.split("\\").join("/");

export function createLead(pi: ExtensionAPI, d: LeadDeps) {
	const run = d.run ?? realRun;
	const env = d.env ?? process.env;
	const file = configPath(d.getAgentDir(), env as Record<string, string | undefined>);
	let loaded = loadConfig(file);
	let cfg: RelayConfig = loaded.config;
	let warned = false;
	const act = new Activation({ active: () => cfg.active, cwd: d.cwd, role: env.RELAY_ROLE, emit: (data) => pi.events.emit("flow:active", data), timeoutMs: d.timeoutMs });
	let engine: Engine | undefined;
	let lastCtx: any;
	/** relay:hosted: an orchestrator hosts this session; lead mode is decided at once, no prompt section, no "go" hook. */
	let hosted = false;
	let overBudgetNoted = false;
	let scanTimer: ReturnType<typeof setInterval> | undefined;
	let scans = 0;
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let widgetShown = false;

	/** The status widget: one line per unfinished job of this session (S33). */
	function paintWidget(): void {
		const ui = lastCtx?.ui;
		if (!ui?.setWidget || !engine) return;
		const lines = engine.widgetLines();
		if (!lines.length && !widgetShown) return;
		widgetShown = lines.length > 0;
		try {
			ui.setWidget("relay", lines.length ? lines : undefined, { placement: "belowEditor" });
		} catch {
			// a missing UI is fine
		}
	}

	// K16: registered at load, answers only for relay.
	const unsubK16 = pi.events.on("flow:active", (data: unknown) => {
		const p = parseFlowActive(data);
		if ("error" in p) return;
		const a = act.claim(p.from);
		if (a && p.claim) p.claim(a);
	});

	const foldersOf = (ctx: any): string[] => {
		try {
			return foldersFromEntries(ctx.sessionManager.getBranch());
		} catch {
			return [];
		}
	};

	/** Decides lead mode once; true when on. Prints the config warnings and a notice the first time. */
	async function leadOn(ctx: any): Promise<boolean> {
		lastCtx = ctx;
		const was = act.mode;
		const on = await act.decide();
		if (!warned) {
			warned = true;
			for (const w of loaded.warnings) ctx.ui?.notify?.(`relay: ${w}`, "warning");
		}
		if (on && !scanTimer) {
			// resume and adoption (S27): once lead mode is on, then every 10 min
			scanTimer = setInterval(() => void scan(lastCtx ?? ctx), d.scanMs ?? 10 * 60_000);
			scanTimer.unref?.();
			widgetTimer = setInterval(paintWidget, d.widgetMs ?? 2000);
			widgetTimer.unref?.();
			void scan(ctx);
		}
		if (was === "undecided" && !on && act.reason && !/relay json|worker or reviewer/.test(act.reason)) ctx.ui?.notify?.(act.reason.startsWith("relay") ? act.reason : `relay: ${act.reason}`, "info");
		return on;
	}

	/** Jobs of dead leads are adopted, and PR-only jobs whose pull request merged lose their kept set. */
	async function scan(ctx: any): Promise<void> {
		scans++;
		try {
			const eng = await engineFor(ctx);
			if ("error" in eng) return;
			await eng.adopt();
			await eng.prCleanup();
			await eng.restack();
		} catch (e) {
			ctx.ui?.notify?.(`relay: scan of unfinished jobs failed: ${(e as Error).message}`, "warning");
		}
	}

	const offMsg = () => `relay: lead mode is off (${act.reason || "not decided"}); /relay on asks again.`;
	const off = () => text(offMsg());

	const claimWt = async (event: string, payload: object, timeoutMs: number): Promise<any> => {
		const c = emitClaims((data) => pi.events.emit(event, data), { v: 1, ...payload }, timeoutMs);
		if (!c.claimed) return { error: `${event}: no listener (is the worktree extension loaded?)` };
		const a: any = await c.answer;
		return a ?? { error: `${event}: no answer` };
	};
	const wt: Wt = {
		create: (req) => claimWt("worktree:create", { name: req.name, launch: "none", bases: req.bases, ...(req.folders ? { folders: req.folders } : {}) }, 15 * 60_000),
		remove: (req) => claimWt("worktree:remove", { name: req.name, ...(req.force ? { force: true } : {}) }, 5 * 60_000),
		addRepo: (req) => claimWt("worktree:add-repo", { name: req.name, folder: req.folder, ...(req.base ? { base: req.base } : {}) }, 5 * 60_000),
	};

	const say = (customType: string, content: string, trigger: boolean) => {
		try {
			pi.sendMessage({ customType, content, display: true }, trigger ? { deliverAs: "followUp", triggerTurn: true } : { triggerTurn: false });
		} catch (e) {
			lastCtx?.ui?.notify?.(`relay: could not deliver a message: ${(e as Error).message}`, "warning");
		}
	};

	/** The engine of this session; undefined with a reason outside a git repo. */
	async function engineFor(ctx: any): Promise<Engine | { error: string }> {
		if (engine) return engine;
		const root = await jobRoot(run, ctx.cwd);
		if (!root) return { error: "relay_dispatch needs the working folder to be inside a git repo (jobs are stored in its git folder)" };
		const sid = (() => {
			try {
				return ctx.sessionManager.getSessionFile?.() ?? `mem-${process.pid}`;
			} catch {
				return `mem-${process.pid}`;
			}
		})();
		engine = new Engine({
			cfg: () => cfg,
			run,
			root,
			me: { pid: process.pid, sessionId: String(sid), host: os.hostname() },
			relayDir: d.relayDir,
			trusted: () => {
				try {
					return ctx.isProjectTrusted?.();
				} catch {
					return undefined;
				}
			},
			wt,
			mcpServers: () => {
				try {
					return pi.getMcpServers();
				} catch {
					return [];
				}
			},
			notify: (line) => say("relay-notice", line, false),
			wake: (t) => say("relay", t, true),
			emit: (n, p) => pi.events.emit(n, p),
			leadCwd: ctx.cwd,
			folders: () => foldersOf(lastCtx ?? ctx),
			...d.engine,
		});
		engine.start();
		return engine;
	}

	// ----------------------------------------------------------------------------------------- hooks

	pi.on("before_agent_start", async (event: any, ctx: any) => {
		if (!(await leadOn(ctx))) return;
		if (hosted) return;
		const sections = event?.systemPromptOptions?.sections;
		if (sections) sections.relay = fs.readFileSync(path.join(d.relayDir, "prompts", "lead.md"), "utf8");
	});

	pi.on("input", async (event: any, ctx: any) => {
		if (event.source === "extension" || hosted) return { action: "continue" };
		const typed = String(event.text ?? "").trim();
		if (!typed || typed.startsWith("/")) return { action: "continue" };
		if (!(await leadOn(ctx))) return { action: "continue" };
		let re: RegExp;
		try {
			re = new RegExp(cfg.approvePattern, "i");
		} catch {
			return { action: "continue" };
		}
		if (!re.test(typed)) return { action: "continue" };
		return { action: "transform", text: `${typed}\n\n${KICKOFF}` };
	});

	pi.on("tool_call", async (event: any, ctx: any) => {
		if (act.mode === "off" || (act.mode === "undecided" && !(await leadOn(ctx)))) return;
		const input = (event.input ?? {}) as Record<string, unknown>;
		if (/(^|__)(edit|write)$/.test(event.toolName)) {
			const raw = String(input.path ?? input.file_path ?? "").replace(/^@/, "");
			const abs = raw ? path.resolve(ctx.cwd, raw) : undefined;
			const m = await measureEdits(run, [ctx.cwd, ...foldersOf(ctx)]);
			const why = editBudgetProblem(m, abs, cfg.editBudget);
			if (why) return { block: true, reason: why };
			return;
		}
		if (/(^|__)bash$/.test(event.toolName)) await logAction(String(input.command ?? ""), ctx);
		return;
	});

	pi.on("tool_result", async (event: any, ctx: any) => {
		if (act.mode !== "on" || !/(^|__)bash$/.test(event.toolName)) return;
		const m = await measureEdits(run, [ctx.cwd, ...foldersOf(ctx)]);
		const over = m.lines >= cfg.editBudget.lines || m.files.length > cfg.editBudget.files;
		if (over && !overBudgetNoted) {
			overBudgetNoted = true;
			ctx.ui?.notify?.(`relay: edit budget exceeded by bash (${m.lines} lines, ${m.files.length} files uncommitted); the next edit or write is refused. Commit, or write a brief and relay_dispatch it.`, "warning");
		} else if (!over) overBudgetNoted = false;
	});

	pi.on("session_shutdown", async () => {
		unsubK16?.();
		unsubBus();
		if (scanTimer) clearInterval(scanTimer);
		if (widgetTimer) clearInterval(widgetTimer);
		await engine?.shutdown();
	});

	/** Classified bash actions go to lead-actions.jsonl. */
	async function logAction(command: string, ctx: any): Promise<void> {
		if (!command) return;
		try {
			const branch = (await run("git", ["branch", "--show-current"], ctx.cwd)).stdout.trim();
			const top = (await run("git", ["rev-parse", "--show-toplevel"], ctx.cwd)).stdout.trim();
			const found = classifyCommand(command, { branch, protectedBranches: repoPolicy(cfg, top || ctx.cwd).protectedBranches });
			if (!found.length) return;
			const root = (await jobRoot(run, ctx.cwd)) ?? path.join(d.getAgentDir(), "relay");
			fs.mkdirSync(root, { recursive: true });
			for (const f of found) fs.appendFileSync(path.join(root, "lead-actions.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), category: f.category, item: f.item, cwd: fwd(ctx.cwd) })}\n`);
		} catch {
			// the log is best effort
		}
	}

	// ----------------------------------------------------------------------------------------- tools

	const T = d.Type;
	const needsLead = async (ctx: any) => ((await leadOn(ctx)) ? undefined : off());
	/** Tool text of an action error: the tool name in front, except for messages that already start with "relay:". */
	const fmt = (tool: string, e: string) => text(e.startsWith("relay:") ? e : `${tool}: ${e}`);

	// One implementation per action, shared by the tools and the relay:* listeners.
	async function doDispatch(ctx: any, p: { brief: string; size?: string; draft?: string; overrides?: any; tag?: Tag }): Promise<{ id: string; queued: boolean } | { error: string }> {
		if (!(await leadOn(ctx))) return { error: offMsg() };
		if (act.jobSet) return { error: "this session is inside a job's worktree; it cannot dispatch jobs." };
		const eng = await engineFor(ctx);
		if ("error" in eng) return { error: eng.error };
		if (p.size !== undefined && !["small", "normal", "large"].includes(p.size)) return { error: 'size must be "small", "normal" or "large"' };
		const r = await eng.dispatch({ brief: p.brief, size: p.size as Size | undefined, draft: p.draft, overrides: p.overrides, tag: p.tag });
		return "error" in r ? { error: r.error } : { id: r.id, queued: r.queued };
	}
	async function doStop(ctx: any, id: string): Promise<{ ok: true } | { error: string }> {
		if (!(await leadOn(ctx))) return { error: offMsg() };
		if (!engine) return { error: "no jobs in this session" };
		return engine.stop(id);
	}
	async function doFollowup(ctx: any, id: string, words: string): Promise<{ ok: true; n: number; queued: boolean } | { error: string }> {
		if (!(await leadOn(ctx))) return { error: offMsg() };
		if (act.jobSet) return { error: "this session is inside a job's worktree." };
		const eng = await engineFor(ctx);
		if ("error" in eng) return { error: eng.error };
		return eng.followup(id, words);
	}

	pi.registerTool({
		name: "relay_critic",
		label: "Relay critic",
		description: "Have the critic review a brief before you dispatch it (read-only, reads the code). The first call returns a draft id; pass it back on later rounds (up to 3 per draft). Returns the findings.",
		promptSnippet: "relay_critic: review a brief; pass the returned draft id on the next round",
		parameters: T.Object({ brief: T.String({ description: "The full brief markdown" }), draft: T.Optional(T.String({ description: "The draft id from the previous round" })) }),
		async execute(_id: string, p: any, _signal: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			const eng = await engineFor(ctx);
			if ("error" in eng) return text(`relay_critic: ${eng.error.replace("relay_dispatch", "relay_critic")}`);
			const r = await runCritic({ cfg, root: eng.root, review: (task, cwd) => eng.review("critic", task, cwd), cwd: ctx.cwd }, p.brief, p.draft);
			if ("error" in r) return text(`relay_critic: ${r.error}`);
			const head = r.ran ? `draft ${r.draft}, round ${r.round} of ${cfg.caps.critic}: ${r.counts?.blocker} blocker, ${r.counts?.major} major, ${r.counts?.minor} minor${r.counts?.locked ? `, ${r.counts.locked} about locked decisions` : ""}${r.counts?.authority ? `, ${r.counts.authority} authority` : ""}` : `draft ${r.draft}`;
			return text(`${head}\n\n${r.text}`, { draft: r.draft, round: r.round });
		},
	});

	pi.registerTool({
		name: "relay_dispatch",
		label: "Relay dispatch",
		description: "Hand a complete brief to a worker. Validates it, moves your uncommitted edits into the job, creates the set and starts the worker. Returns the job id; relay reports when it is done.",
		promptSnippet: "relay_dispatch: start a job from a brief (your uncommitted edits move into it)",
		parameters: T.Object({
			brief: T.String(),
			size: T.Optional(T.String({ description: "small | normal | large" })),
			draft: T.Optional(T.String({ description: "The critic draft id, to attach its rounds" })),
			overrides: T.Optional(T.Array(T.Object({ decision: T.String(), finding: T.String(), reason: T.String() }), { description: "Locked decisions you overrode, with the finding and the reason" })),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const r = await doDispatch(ctx, p);
			if ("error" in r) return fmt("relay_dispatch", r.error);
			return text(`job ${r.id} ${r.queued ? `queued (${cfg.maxJobs} jobs are running)` : "started"}. relay reports when it is done; relay_status ${r.id} shows progress.`, { id: r.id });
		},
	});

	pi.registerTool({
		name: "relay_status",
		label: "Relay status",
		description: "State, round, last verdict, budget used and the last log lines of a job (or of every job of this session).",
		promptSnippet: "relay_status: show a job's state",
		parameters: T.Object({ job: T.Optional(T.String()) }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			return text(engine ? engine.status(p.job) : "no jobs in this session");
		},
	});

	pi.registerTool({
		name: "relay_approve",
		label: "Relay approve",
		description: "Answer a worker's question or approval request. For an approval: approve true adds it to the job's Authority (an amendment); approve false refuses. For a plain question, reason is the answer. Refuses a category listed in relay.json askUser: ask the user first.",
		promptSnippet: "relay_approve: answer a worker's ask or approval",
		parameters: T.Object({ job: T.String(), askId: T.String(), approve: T.Boolean(), reason: T.String() }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (!engine) return text("relay_approve: no jobs in this session");
			const r = engine.approve(p.job, p.askId, p.approve, p.reason);
			return text("error" in r ? `relay_approve: ${r.error}` : r.text);
		},
	});

	pi.registerTool({
		name: "relay_stop",
		label: "Relay stop",
		description: "Stop a job: aborts the worker and writes the report. The set is kept.",
		promptSnippet: "relay_stop: stop a job",
		parameters: T.Object({ job: T.String() }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const r = await doStop(ctx, p.job);
			return "error" in r ? fmt("relay_stop", r.error) : text(`job ${p.job} stopped; report written.`);
		},
	});

	pi.registerTool({
		name: "relay_deliver",
		label: "Relay deliver",
		description: "Retry the delivery of a job that passed the judge (after you fixed the cause of a stopped delivery or approved something), or run the judge again on a paused job.",
		promptSnippet: "relay_deliver: retry a job's delivery",
		parameters: T.Object({ job: T.String() }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (!engine) return text("relay_deliver: no jobs in this session");
			const r = await engine.deliver(p.job);
			return text("error" in r ? `relay_deliver: ${r.error}` : `job ${p.job} is ${r.state}`);
		},
	});

	pi.registerTool({
		name: "relay_send",
		label: "Relay send",
		description: "Send input to a running job. It is always recorded as an amendment of the brief. mode steer: reaches a running worker at its next step (a prompt when it is idle). follow_up: queued behind its current turn. restart: the worker's approach is dropped (the critic checks the amendment first); reset base also resets the branch to its base. An amendment after PASS holds delivery until the new brief version is judged. For a finished job use relay_followup.",
		promptSnippet: "relay_send: amend or redirect a running job (steer | follow_up | restart)",
		parameters: T.Object({
			job: T.String(),
			text: T.String({ description: "What changes, as an instruction to the worker" }),
			mode: T.String({ description: "steer | follow_up | restart" }),
			reset: T.Optional(T.String({ description: "restart only: base | keep (default keep)" })),
			from: T.Optional(T.String({ description: "user (default: the user's words) | lead (your own change)" })),
		}),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (!engine) return text("relay_send: no jobs in this session");
			if (!["steer", "follow_up", "restart"].includes(p.mode)) return text('relay_send: mode must be "steer", "follow_up" or "restart"');
			if (p.reset !== undefined && !["base", "keep"].includes(p.reset)) return text('relay_send: reset must be "base" or "keep"');
			const r = await engine.send(p.job, p.text, p.mode, { reset: p.reset, by: p.from === "lead" ? "lead" : "user" });
			return text("error" in r ? `relay_send: ${r.error}` : `amendment recorded (brief version ${r.version}): ${r.how}`);
		},
	});

	pi.registerTool({
		name: "relay_replan",
		label: "Relay re-plan",
		description: "After the worker failed the judge and escalated rounds, relay woke you: give the revised full brief (same Targets). A new worker session starts on the same worktree. Up to caps.replans per job.",
		promptSnippet: "relay_replan: revised brief for a job that ran out of rounds",
		parameters: T.Object({ job: T.String(), brief: T.String({ description: "The revised, complete brief" }) }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (!engine) return text("relay_replan: no jobs in this session");
			const r = await engine.replan(p.job, p.brief);
			return text("error" in r ? `relay_replan: ${r.error}` : `job ${p.job} re-planned (brief version ${r.version}); a new worker session started.`);
		},
	});

	pi.registerTool({
		name: "relay_resume",
		label: "Relay resume",
		description: "Continue a paused job (after /relay pause, or a worker that crashed or stalled twice): the worker is restarted with its session, or the judge runs again.",
		promptSnippet: "relay_resume: continue a paused job",
		parameters: T.Object({ job: T.String() }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (!engine) return text("relay_resume: no jobs in this session");
			const r = await engine.resume(p.job);
			return text("error" in r ? `relay_resume: ${r.error}` : `job ${p.job} is ${r.state}`);
		},
	});

	pi.registerTool({
		name: "relay_add_repo",
		label: "Relay add repo",
		description: "Add another repo to a running job (the worker asked for it, or the change needs it): a worktree of `folder` joins the job's set on origin/<target>, the worker is told, and the judge diff and delivery include it. Pass askId to answer the worker's ask.",
		promptSnippet: "relay_add_repo: add a repo to a running job",
		parameters: T.Object({ job: T.String(), folder: T.String({ description: "The repo folder, or the name of the lead's repo or an added folder" }), target: T.String({ description: "The target branch, e.g. main" }), askId: T.Optional(T.String({ description: "The worker's open ask this answers" })) }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (!engine) return text("relay_add_repo: no jobs in this session");
			const r = await engine.addRepo(p.job, p.folder, p.target, p.askId);
			return text("error" in r ? `relay_add_repo: ${r.error}` : `repo ${r.key} added to job ${p.job}: ${r.path} (branch ${r.branch}); the worker was told.`);
		},
	});

	pi.registerTool({
		name: "relay_followup",
		label: "Relay follow-up",
		description: "A follow-up on a finished job (done, stopped or failed): an amendment of the same job, worked in the same set (or a new one when the old is gone or the job merged), judged on its own diff, delivered and reported like the job. Also works for jobs of an earlier session.",
		promptSnippet: "relay_followup: continue a finished job with a change",
		parameters: T.Object({ job: T.String(), text: T.String({ description: "What the follow-up asks for" }) }),
		async execute(_id: string, p: any, _s: any, _u: any, ctx: any) {
			const r = await doFollowup(ctx, p.job, p.text);
			return "error" in r ? fmt("relay_followup", r.error) : text(`follow-up ${r.n} of job ${p.job} ${r.queued ? "queued" : "started"}. relay reports when it is done.`);
		},
	});

	// ----------------------------------------------------------------------------------------- bus contracts

	type Claim = ((answer: unknown) => void) | undefined;
	/** Answers a claim with the result of `work` (the claim is made synchronously, as the claim pattern needs). */
	const answerWith = (claim: Claim, work: () => Promise<unknown>) => claim?.(work().catch((e: Error) => ({ error: String(e?.message ?? e) })));

	function onDispatch(data: unknown) {
		const p = parseDispatch(data);
		if ("error" in p) return p.claim?.({ error: p.error });
		answerWith(p.claim, async () => {
			if (!lastCtx) return { error: "relay:dispatch: no session context yet" };
			const r = await doDispatch(lastCtx, { brief: p.brief, size: p.size, tag: p.tag });
			return "error" in r ? { error: r.error } : { id: r.id, queued: r.queued };
		});
	}
	function onControl(data: unknown) {
		const p = parseControl(data);
		if ("error" in p) return p.claim?.({ error: p.error });
		answerWith(p.claim, async () => {
			if (!lastCtx) return { error: "relay:control: no session context yet" };
			if (p.action === "stop") {
				const r = await doStop(lastCtx, p.job);
				return "error" in r ? { error: r.error } : { ok: true, job: p.job };
			}
			const r = await doFollowup(lastCtx, p.job, p.text!);
			return "error" in r ? { error: r.error } : { ok: true, job: p.job, n: r.n, queued: r.queued };
		});
	}
	function onJobQuery(data: unknown) {
		const p = parseJobQuery(data);
		if ("error" in p) return p.claim?.({ error: p.error });
		answerWith(p.claim, async () => {
			if (!lastCtx) return { error: "relay:job-query: no session context yet" };
			const eng = await engineFor(lastCtx);
			if ("error" in eng) return { error: eng.error };
			return { jobs: eng.query(p.ids) };
		});
	}
	function onHosted(data: unknown) {
		const p = parseHosted(data);
		if ("error" in p) return p.claim?.({ error: p.error });
		hosted = p.on;
		answerWith(p.claim, async () => {
			if (!lastCtx) return { on: p.on, mode: "off", reason: "no session context" };
			const on = p.on ? await leadOn(lastCtx) : act.mode === "on";
			return { on: p.on, mode: on ? "on" : "off", ...(on || !act.reason ? {} : { reason: act.reason }) };
		});
		// hosted without a claim still decides lead mode at once
		if (!p.claim && p.on && lastCtx) void leadOn(lastCtx);
	}

	let unsubBus = () => {};
	function registerBus() {
		unsubBus();
		const subs = [pi.events.on("relay:dispatch", onDispatch), pi.events.on("relay:control", onControl), pi.events.on("relay:job-query", onJobQuery), pi.events.on("relay:hosted", onHosted)];
		unsubBus = () => {
			for (const u of subs) (u as unknown as (() => void) | undefined)?.();
			unsubBus = () => {};
		};
	}
	registerBus();

	pi.on("session_start", async (_event: any, ctx: any) => {
		lastCtx = ctx;
		registerBus();
		if (hosted) await leadOn(ctx);
	});

	// ----------------------------------------------------------------------------------------- commands

	pi.registerCommand("relay", {
		description: "relay: status | on | off | go | stop <job> | pause <job> | resume <job> | followup <job> <text> | log <job> [n] | model <role> <provider/id[:thinking]>",
		handler: async (args: string, ctx: any) => {
			lastCtx = ctx;
			const [sub = "status", ...rest] = args.trim().split(/\s+/);
			const note = (m: string, level: "info" | "warning" | "error" = "info") => ctx.ui?.notify?.(m, level);
			if (sub === "on") {
				const r = await act.turnOn();
				note(r.ok ? "relay: lead mode on" : `relay: not turned on: ${r.why}`, r.ok ? "info" : "warning");
			} else if (sub === "off") {
				const running = engine?.ownedRunning() ?? 0;
				if (running > 0) note(`relay: not turned off: this lead owns ${running} running job(s); relay_stop them first`, "warning");
				else {
					act.turnOff();
					note("relay: lead mode off");
				}
			} else if (sub === "go") {
				if (!(await leadOn(ctx))) note(`relay: lead mode is off (${act.reason})`, "warning");
				else pi.sendUserMessage(KICKOFF);
			} else if (sub === "stop") {
				if (!rest[0]) note("usage: /relay stop <job>", "warning");
				else {
					const r = engine ? await engine.stop(rest[0]) : { error: "no jobs in this session" };
					note("error" in r ? `relay: ${r.error}` : `relay: job ${rest[0]} stopped`, "error" in r ? "warning" : "info");
				}
			} else if (sub === "pause" || sub === "resume") {
				if (!rest[0]) note(`usage: /relay ${sub} <job>`, "warning");
				else {
					const r = engine ? await (sub === "pause" ? engine.pause(rest[0]) : engine.resume(rest[0])) : { error: "no jobs in this session" };
					const set = engine?.get(rest[0])?.job.set ?? rest[0];
					note("error" in r ? `relay: ${r.error}` : sub === "pause" ? `relay: job ${rest[0]} paused; work in its set with /wt open ${set}, then /relay resume ${rest[0]}` : `relay: job ${rest[0]} resumed`, "error" in r ? "warning" : "info");
				}
			} else if (sub === "log") {
				if (!rest[0]) note("usage: /relay log <job> [n]", "warning");
				else {
					const eng = await engineFor(ctx);
					note("error" in eng ? `relay: ${eng.error}` : eng.logText(rest[0], Number(rest[1]) > 0 ? Number(rest[1]) : 20));
				}
			} else if (sub === "followup") {
				const [job, ...words] = rest;
				if (!job || !words.length) note("usage: /relay followup <job> <text>", "warning");
				else if (!(await leadOn(ctx))) note(`relay: lead mode is off (${act.reason})`, "warning");
				else {
					const eng = await engineFor(ctx);
					const r = "error" in eng ? eng : await eng.followup(job, words.join(" "));
					note("error" in r ? `relay: ${r.error}` : `relay: follow-up ${r.n} of ${job} ${r.queued ? "queued" : "started"}`, "error" in r ? "warning" : "info");
				}
			} else if (sub === "model") {
				const [role, spec] = rest;
				const roles = ["critic", "judge", "escalate", "worker.small", "worker.normal", "worker.large"];
				const parsed = spec ? parseRoleSpec(spec) : "usage: /relay model <role> <provider/id[:thinking]>";
				if (!role || !roles.includes(role) || typeof parsed === "string") note(typeof parsed === "string" ? parsed : `roles: ${roles.join(", ")}`, "warning");
				else {
					saveRole(file, role as any, parsed);
					loaded = loadConfig(file);
					cfg = loaded.config;
					note(`relay: ${role} is now ${spec}`);
				}
			} else {
				const mode = act.mode === "undecided" ? "not decided yet" : act.mode;
				note(`relay: lead mode ${mode}${act.reason ? ` (${act.reason})` : ""}\n${engine ? engine.status() : "no jobs in this session"}`);
			}
		},
	});

	return { act, leadOn, engineFor, config: () => cfg, engine: () => engine, scans: () => scans };
}
