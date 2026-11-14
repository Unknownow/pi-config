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
import { Activation, parseFlowActive } from "./events.ts";
import { foldersFromEntries } from "./folders.ts";
import { jobRoot } from "./job.ts";
import { type Run, run as realRun } from "./sh.ts";
import { runCritic } from "./steps/critic.ts";
import type { EngineDeps } from "./engine.ts";
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
	let overBudgetNoted = false;

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
		if (was === "undecided" && !on && act.reason && !/relay json|worker or reviewer/.test(act.reason)) ctx.ui?.notify?.(act.reason.startsWith("relay") ? act.reason : `relay: ${act.reason}`, "info");
		return on;
	}

	const off = () => text(`relay: lead mode is off (${act.reason || "not decided"}); /relay on asks again.`);

	const claimWt = async (event: string, payload: object, timeoutMs: number): Promise<any> => {
		const c = emitClaims((data) => pi.events.emit(event, data), { v: 1, ...payload }, timeoutMs);
		if (!c.claimed) return { error: `${event}: no listener (is the worktree extension loaded?)` };
		const a: any = await c.answer;
		return a ?? { error: `${event}: no answer` };
	};
	const wt: Wt = {
		create: (req) => claimWt("worktree:create", { name: req.name, launch: "none", bases: req.bases, ...(req.folders ? { folders: req.folders } : {}) }, 15 * 60_000),
		remove: (req) => claimWt("worktree:remove", { name: req.name, ...(req.force ? { force: true } : {}) }, 5 * 60_000),
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
		const sections = event?.systemPromptOptions?.sections;
		if (sections) sections.relay = fs.readFileSync(path.join(d.relayDir, "prompts", "lead.md"), "utf8");
	});

	pi.on("input", async (event: any, ctx: any) => {
		if (event.source === "extension") return { action: "continue" };
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
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (act.jobSet) return text("relay_dispatch: this session is inside a job's worktree; it cannot dispatch jobs.");
			const eng = await engineFor(ctx);
			if ("error" in eng) return text(`relay_dispatch: ${eng.error}`);
			if (p.size !== undefined && !["small", "normal", "large"].includes(p.size)) return text('relay_dispatch: size must be "small", "normal" or "large"');
			const r = await eng.dispatch({ brief: p.brief, size: p.size, draft: p.draft, overrides: p.overrides });
			if ("error" in r) return text(`relay_dispatch: ${r.error}`);
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
			const refuse = await needsLead(ctx);
			if (refuse) return refuse;
			if (!engine) return text("relay_stop: no jobs in this session");
			const r = await engine.stop(p.job);
			return text("error" in r ? `relay_stop: ${r.error}` : `job ${p.job} stopped; report written.`);
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

	// ----------------------------------------------------------------------------------------- commands

	pi.registerCommand("relay", {
		description: "relay: status | on | off | go | stop <job> | model <role> <provider/id[:thinking]>",
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

	return { act, leadOn, engineFor, config: () => cfg, engine: () => engine };
}
