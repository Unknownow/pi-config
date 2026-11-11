/**
 * Orchestrate extension: one orchestrator session runs 2-4 workflow sub-sessions, each in its own `wt`
 * worktree. It talks to the workflow and worktree extensions only through their public events
 * (workflow K4, K9-K11; worktree W1) and to the sub-sessions through append-only files under
 * `<git common dir>/pi/orchestra/<run>/`. See README.md.
 *
 * The same extension runs in both roles. A session whose worktree is the `cwd` of a sub in an active
 * run is a sub-session; any other session can start a run (orch_run) and becomes its orchestrator.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { emitClaims } from "../shared/claims.ts";
import { activeCount, canonicalPackages, kickoffText, makeRunId, readyToSpawn, renderBrief, setName, validatePackages, type PackageInput, type Run, type Sub } from "./brief.ts";
import { foldersFromEntries } from "./folders.ts";
import { globsMayOverlap } from "./paths.ts";
import { buildRepos, foldersFor, hasKeyPrefix, split, subRepos, worktreesOf, type Repo, type Worktree } from "./repos.ts";
import { verdictMatches } from "./inbox.ts";
import { loadConfig, DEFAULTS, type OrchestrateConfig } from "./config.ts";
import { isProposalReady, MODE_ENTRY, modeFromEntries, onTyped, toolRefusal, type Mode } from "./mode.ts";
import { repoTableText, section } from "./prompts.ts";
import { check, type Snapshot } from "./monitor.ts";
import {
	addAccepted, appendMessage, commonDir, findSubByToplevel, listActiveRuns, norm, orchestraDir, readAccepted, readCursor, readNew, readRun, readStatus, runDir, subDir, writeCursor, writeRun, writeStatus,
	type Exec, type Message, type Status,
} from "./store.ts";

const ACTIVE: Sub["state"][] = ["spawned", "planning", "executing", "awaiting-acceptance"];
const sameDir = (a: string, b: string): boolean => (process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b));
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default function (pi: ExtensionAPI): void {
	const exec: Exec = async (command, args, opts) => {
		const r = await pi.exec(command, args, { cwd: opts?.cwd, timeout: 60_000 });
		return { stdout: r.stdout, stderr: r.stderr, code: r.killed ? 1 : (r.code ?? 1) };
	};
	const git = async (cwd: string, ...args: string[]): Promise<string | null> => {
		try {
			const r = await exec("git", ["-C", cwd, ...args]);
			return r.code === 0 ? r.stdout.trim() : null;
		} catch {
			return null;
		}
	};

	let cfg: OrchestrateConfig = loadConfig(getAgentDir()).config;
	let uiCtx: ExtensionContext | undefined;
	const say = (msg: string, level: "info" | "warning" | "error" = "info") => {
		try {
			uiCtx?.ui.notify(`orchestrate: ${msg}`, level);
		} catch {
			// the context may be gone
		}
	};
	const sendToModel = (customType: string, content: string, deliverAs: "steer" | "followUp" = "followUp") => {
		try {
			pi.sendMessage({ customType, content, display: true }, { deliverAs, triggerTurn: true });
		} catch (e) {
			say(`could not deliver a message: ${(e as Error).message}`, "warning");
		}
	};

	// ---------------------------------------------------------------- sub-session side

	interface Me {
		common: string;
		run: Run;
		sub: Sub;
		dir: string;
	}
	let me: Me | null = null;
	let started = false;
	let lastK4: Record<string, unknown> | undefined;
	let prevPhase = "off";
	let prevFlowId: string | undefined;
	let k4Waiters: Array<() => void> = [];
	let pendingAsk = new Map<string, (m: Message) => void>();
	let k10: { n: number; resolve: (v: unknown) => void } | null = null;
	const requestedTrees = new Set<string>();
	let generation = 0;
	let timers: ReturnType<typeof setInterval>[] = [];
	const every = (ms: number, fn: () => void | Promise<void>) => {
		let busy = false;
		const t = setInterval(() => {
			if (busy) return;
			busy = true;
			Promise.resolve(fn()).catch(() => {}).finally(() => {
				busy = false;
			});
		}, ms);
		t.unref?.();
		timers.push(t);
	};
	const stopTimers = () => {
		for (const t of timers) clearInterval(t);
		timers = [];
	};

	const f = (m: Me, name: string) => `${m.dir}/${name}`;

	function writeMyStatus(): void {
		if (!me || !started) return;
		const k = lastK4 ?? {};
		const num = (v: unknown) => (typeof v === "number" ? v : undefined);
		const s: Status = {
			v: 1,
			phase: typeof k.phase === "string" ? k.phase : "off",
			flowId: typeof k.flowId === "string" ? k.flowId : undefined,
			title: typeof k.title === "string" ? k.title : undefined,
			stage: num(k.stage),
			stages: num(k.stages),
			done: num(k.done),
			total: num(k.total),
			waiting: k.waiting === true ? true : undefined,
			heartbeat: Date.now(),
			pid: process.pid,
		};
		try {
			writeStatus(f(me, "status.json"), s);
		} catch (e) {
			say(`could not write status: ${(e as Error).message}`, "warning");
		}
	}

	const post = (type: string, msg: string, data?: Record<string, unknown>, replyTo?: string): Message | null => {
		if (!me) return null;
		try {
			return appendMessage(f(me, "outbox.jsonl"), me.sub.id, { type, text: msg, data, replyTo });
		} catch (e) {
			say(`could not write to the orchestrator: ${(e as Error).message}`, "error");
			return null;
		}
	};

	pi.events.on("workflow:status", (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const k = data as Record<string, unknown>;
		lastK4 = k;
		if (mode !== "off" && !me && typeof k.phase === "string" && k.phase !== "off" && !k4Warned) {
			k4Warned = true;
			say(`the workflow is in phase ${k.phase} while orchestrator mode is ${mode}; the read-only guard stays on (/orch off lifts it)`, "warning");
		}
		const waiters = k4Waiters;
		k4Waiters = [];
		for (const w of waiters) w();
		if (!me || !started) return;
		const phase = typeof k.phase === "string" ? k.phase : "off";
		if (prevPhase === "execute" && phase !== "execute") post("flow-ended", `flow ended (phase ${phase})`, { flowId: prevFlowId });
		prevPhase = phase;
		if (typeof k.flowId === "string") prevFlowId = k.flowId;
		writeMyStatus();
	});

	/** K10: the plan goes to the orchestrator instead of the menu. */
	pi.events.on("workflow:plan-ready", (data: unknown) => {
		if (!me || !started || !data || typeof data !== "object") return;
		const d = data as { title?: unknown; plan?: unknown; claim?: unknown };
		if (typeof d.claim !== "function" || typeof d.plan !== "string") return;
		let n = 1;
		try {
			while (fs.existsSync(f(me, `plan-${n}.md`))) n++;
			const file = f(me, `plan-${n}.md`);
			fs.writeFileSync(file, d.plan);
			if (!post("plan-review", `Plan ${n} of package ${me.sub.id} is ready for review: ${file}`, { file, n })) return;
		} catch {
			return;
		}
		k10?.resolve(null);
		(d.claim as (p: Promise<unknown>) => void)(new Promise((resolve) => {
			k10 = { n, resolve };
		}));
	});

	/** K11: a merge needs the orchestrator's acceptance of the same tree. */
	pi.events.on("workflow:merge-gate", (data: unknown) => {
		if (!me || !started || !data || typeof data !== "object") return;
		const d = data as { cwd?: unknown; tree?: unknown; claim?: unknown };
		if (typeof d.claim !== "function") return;
		const m = me;
		(d.claim as (p: Promise<unknown>) => void)(
			(async () => {
				if (readRun(m.common, m.run.id).run?.state === "ended") return null; // the run is over: nobody can accept any more
				const dir = typeof d.cwd === "string" && d.cwd ? d.cwd : m.sub.cwd ?? "";
				// a multi-repo run is accepted per repo: find the worktree this merge is in
				let key = "";
				const fresh = readRun(m.common, m.run.id).run ?? m.run;
				if (fresh.repos?.length) {
					const top = norm((await git(dir, "rev-parse", "--show-toplevel")) ?? dir);
					const sub = fresh.subs.find((x) => x.id === m.sub.id) ?? m.sub;
					const wt = worktreesOf(sub, fresh).find((w) => sameDir(w.cwd, top));
					if (!wt) return { problem: `${top} is not a worktree of package ${m.sub.id} (its repos: ${worktreesOf(sub, fresh).map((w) => w.key).join(", ") || "none"}); the orchestrator accepts only the repos of the package.` };
					key = wt.key;
				}
				const tree = typeof d.tree === "string" && d.tree ? d.tree : await git(dir, "rev-parse", "HEAD^{tree}");
				if (!tree) return { problem: "The orchestrator's acceptance check could not read the tree of this worktree." };
				const token = key ? `${key}:${tree}` : tree;
				// both the orchestrator's accepted.json and its accept-verdict message must name the tree (and the repo; a missing repo is the working repo)
				const workKey = fresh.repos?.[0]?.key ?? "";
				const verdict = readNew(f(m, "inbox.jsonl"), 0).msgs.some((x) => x.type === "accept-verdict" && x.data?.accept === true && x.data?.tree === tree && String(x.data?.repo ?? workKey) === key);
				if (verdict && readAccepted(f(m, "accepted.json")).includes(token)) return null;
				if (!requestedTrees.has(token)) {
					requestedTrees.add(token);
					post("accept-request", `Package ${m.sub.id} asks to merge tree ${tree}${key ? ` of repo ${key}` : ""}.`, { tree, repo: key });
				}
				return { problem: `The orchestrator has not accepted tree ${tree}${key ? ` of repo ${key}` : ""} yet. An acceptance request was sent; end your turn. You get a message when it answers; then retry the merge.` };
			})(),
		);
	});

	function deliverInbox(): void {
		if (!me) return;
		const file = f(me, "inbox.jsonl");
		const cur = f(me, "inbox.read");
		const r = readNew(file, readCursor(cur));
		for (const m of r.msgs) {
			const pending = m.replyTo ? pendingAsk.get(m.replyTo) : undefined;
			if (m.type === "answer" && pending) {
				pending(m);
			} else if (m.type === "plan-verdict") {
				const approve = m.data?.approve === true;
				if (k10 && verdictMatches(k10.n, m)) {
					k10.resolve(approve ? { approve: true } : { reject: m.text || "the orchestrator rejected the plan" });
					k10 = null;
					say(approve ? "plan approved by the orchestrator" : `plan rejected: ${m.text}`);
				} else {
					say(`verdict for plan ${String(m.data?.n ?? "?")} ignored; ${k10 ? `plan ${k10.n} is under review` : "no plan is under review"}`, "warning");
				}
			} else if (m.type === "directive") {
				sendToModel("orchestrate-message", `Orchestrator directive: ${m.text}`, m.data?.urgent === true ? "steer" : "followUp");
			} else if (m.type === "answer") {
				sendToModel("orchestrate-message", `Orchestrator answer${m.replyTo ? ` to ${m.replyTo}` : ""}: ${m.text}`);
			} else {
				sendToModel("orchestrate-message", `Orchestrator${m.type === "accept-verdict" ? ` (acceptance ${m.data?.accept === true ? "granted" : "refused"})` : ""}: ${m.text}`);
			}
		}
		if (r.cursor !== readCursor(cur) || r.bad) writeCursor(cur, r.cursor);
		if (r.bad) say(`${r.bad} unreadable line(s) in the inbox were skipped`, "warning");
	}

	pi.registerTool({
		name: "ask_orchestrator",
		label: "Ask orchestrator",
		description: "Ask the orchestrator session a question about the brief, scope or a decision, and wait for its answer. Only in a session started by the orchestrator.",
		promptSnippet: "ask_orchestrator: ask the orchestrating session a question (orchestrated sub-sessions only)",
		parameters: Type.Object({ question: Type.String({ description: "The question, with what you already tried" }) }),
		async execute(_id, params, signal) {
			if (!me || !started) throw new Error("this session was not started by an orchestrator; use wait_for_user to ask the user");
			const q = post("question", params.question);
			if (!q) throw new Error("could not write the question");
			const minutes = cfg.askTimeoutMinutes;
			const answer = await new Promise<Message | null>((resolve) => {
				const done = (v: Message | null) => {
					clearTimeout(timeout);
					pendingAsk.delete(q.id);
					signal?.removeEventListener("abort", onAbort);
					resolve(v);
				};
				const onAbort = () => done(null);
				const timeout = setTimeout(() => done(null), minutes * 60_000);
				pendingAsk.set(q.id, done);
				signal?.addEventListener("abort", onAbort);
			});
			if (signal?.aborted) throw new Error("cancelled");
			if (!answer) return text(`No answer in ${minutes} min. Call wait_for_user with this question; the user answers.`);
			return text(answer.text);
		},
	});

	async function startSubSession(m: Me, ctx: ExtensionContext): Promise<void> {
		if (!lastK4) await new Promise<void>((resolve) => {
			const t = setTimeout(resolve, 10_000);
			k4Waiters.push(() => {
				clearTimeout(t);
				resolve();
			});
		});
		await new Promise((r) => setTimeout(r, 500));
		const briefPath = f(m, "brief.md");
		const claims = emitClaims((d) => pi.events.emit("workflow:start-plan", d), { v: 1, title: `${m.run.title}: ${m.sub.id}`, brief: kickoffText(m.sub, m.run, briefPath), allowTools: ["ask_orchestrator"] }, 10_000);
		const ans = (await claims.answer) as { ok?: boolean; error?: string } | null;
		if (!claims.claimed || !ans || ans.error || !ans.ok) {
			ctx.ui.notify(`orchestrate: could not start the flow from the brief (${!claims.claimed ? "workflow extension did not answer" : ans?.error ?? "no answer"}); brief: ${briefPath}`, "error");
			return;
		}
		started = true;
		writeMyStatus();
	}

	// ---------------------------------------------------------------- orchestrator mode

	let mode: Mode = "off";
	let proposalReady = false;
	let k4Warned = false;
	const goRe = (): RegExp => {
		try {
			return new RegExp(cfg.approvePattern, "i");
		} catch {
			return new RegExp(DEFAULTS.approvePattern, "i");
		}
	};
	function setMode(m: Mode, announce = true): void {
		mode = m;
		proposalReady = false;
		k4Warned = false;
		try {
			pi.appendEntry(MODE_ENTRY, { v: 1, mode: m });
		} catch (e) {
			say(`could not save the mode: ${(e as Error).message}`, "warning");
		}
		if (announce) say(m === "off" ? "orchestrator mode off: the guard is lifted" : `orchestrator mode: ${m}`);
	}
	const assistantText = (m: unknown): string => {
		const a = m as { role?: string; content?: unknown } | undefined;
		if (!a || a.role !== "assistant" || !Array.isArray(a.content)) return "";
		return a.content.filter((c: { type?: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
	};

	// The section is always set (empty when off) so pi's patch replay of the system prompt stays stable.
	let repoTableCache: { key: string; text: string | undefined } | undefined;
	pi.on("before_agent_start", async (event, ctx) => {
		const sections = (event as { systemPromptOptions?: { sections?: Record<string, string> } }).systemPromptOptions?.sections;
		if (!sections) return;
		let table: string | undefined;
		if (!me && (mode === "propose" || mode === "run")) {
			try {
				const key = `${ctx.cwd}|${addedOf(ctx).join("|")}`;
				if (repoTableCache?.key !== key) repoTableCache = { key, text: ((r) => (r ? repoTableText(r) : undefined))(await sessionRepos(ctx)) };
				table = repoTableCache.text;
			} catch {
				table = undefined;
			}
		}
		sections.orchestrate = me ? "" : section(mode, table);
	});

	pi.on("tool_call", async (event) => {
		if (me || mode === "off") return;
		const why = toolRefusal(mode, event.toolName, (event.input ?? {}) as Record<string, unknown>);
		if (why) return { block: true, reason: why };
	});

	pi.on("input", async (event) => {
		if (me || mode === "off" || event.source === "extension" || event.streamingBehavior) return { action: "continue" as const };
		const typed = event.text.trim();
		if (typed.startsWith("/")) return { action: "continue" as const };
		const t = onTyped(mode, typed, proposalReady, goRe());
		proposalReady = false;
		if (!t) return { action: "continue" as const };
		setMode(t.mode);
		return { action: "transform" as const, text: `${typed}\n\n${t.append}` };
	});

	pi.on("agent_end", async (event) => {
		if (me || (mode !== "propose" && mode !== "discuss")) return;
		const msgs = (event as { messages?: Array<{ role?: string; stopReason?: string }> }).messages ?? [];
		const last = [...msgs].reverse().find((m) => m.role === "assistant");
		const body = assistantText(last).trim();
		proposalReady = mode === "propose" && isProposalReady(body, last?.stopReason === "stop" && body.length > 0);
	});

	// ---------------------------------------------------------------- orchestrator side

	interface Owned {
		common: string;
		runId: string;
		repoCwd: string;
	}
	let owned: Owned | null = null;
	const snaps = new Map<string, Snapshot>();
	let events: string[] = [];
	const spawning = new Set<string>();
	let queue: Promise<unknown> = Promise.resolve();
	const corruptSeen = new Set<string>();

	/** Serialised read-modify-write of run.json (this session is its only writer). */
	function mutate<T>(fn: (run: Run) => T): Promise<T> {
		const o = owned;
		const p = queue.then(() => {
			if (!o) throw new Error("no active run in this session");
			const r = readRun(o.common, o.runId);
			if (!r.run) throw new Error(r.corrupt ?? "run.json is missing");
			const out = fn(r.run);
			writeRun(o.common, r.run);
			return out;
		});
		queue = p.catch(() => {});
		return p;
	}
	const current = (): Run | null => (owned ? readRun(owned.common, owned.runId).run ?? null : null);
	const need = (): { o: Owned; run: Run } => {
		const run = current();
		if (!owned || !run) throw new Error("no active run in this session; start one with orch_run or /orch watch");
		return { o: owned, run };
	};
	const subOf = (run: Run, id: string): Sub => {
		const s = run.subs.find((x) => x.id === id);
		if (!s) throw new Error(`unknown package "${id}" (have: ${run.subs.map((x) => x.id).join(", ")})`);
		return s;
	};
	const sf = (o: Owned, id: string, name: string) => `${subDir(o.common, o.runId, id)}/${name}`;

	function stopWatcher(): void {
		stopTimers();
		owned = null;
		snaps.clear();
		defaultBranches.clear();
		events = [];
	}

	function flush(): void {
		if (!events.length) return;
		const content = events.join("\n\n");
		events = [];
		sendToModel("orchestrate-events", content);
	}

	const workingKey = (run: Run): string => run.repos?.[0]?.key ?? "";
	/** The orchestrator's checkout of the repo `key` (the working repo for key ""). */
	const topOfKey = (o: Owned, run: Run, key: string): string => run.repos?.find((r) => r.key === key)?.top ?? o.repoCwd;
	const prefix = (key: string, file: string): string => (key ? `${key}:${norm(file)}` : norm(file));

	async function ghMerged(cwd: string, branch: string): Promise<boolean | null> {
		try {
			const r = await exec("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "number"], { cwd });
			if (r.code !== 0) return null;
			const arr = JSON.parse(r.stdout || "[]") as unknown;
			return Array.isArray(arr) && arr.length > 0;
		} catch {
			return null;
		}
	}

	async function readOutboxes(): Promise<void> {
		const o = owned;
		const run = current();
		if (!o || !run) return;
		const ended: Sub[] = [];
		const stateChanges: Array<[string, Sub["state"]]> = [];
		for (const sub of run.subs) {
			if (!ACTIVE.includes(sub.state)) continue;
			const file = sf(o, sub.id, "outbox.jsonl");
			const cur = sf(o, sub.id, "outbox.read");
			const r = readNew(file, readCursor(cur));
			for (const m of r.msgs) {
				const head = `[${sub.id}]`;
				if (m.type === "question") events.push(`${head} question (id ${m.id}): ${m.text}\nAnswer it with orch_send {id:"${sub.id}", type:"answer", replyTo:"${m.id}", text}.`);
				else if (m.type === "plan-review") events.push(`${head} plan ${String(m.data?.n ?? "?")} ready: ${String(m.data?.file ?? "")}\nRead it against the brief (${sf(o, sub.id, "brief.md")}), then call orch_review_plan with n=${String(m.data?.n ?? "?")}.`);
				else if (m.type === "accept-request") {
					stateChanges.push([sub.id, "awaiting-acceptance"]);
					const repoKey = String(m.data?.repo ?? workingKey(run));
					const wt = worktreesOf(sub, run).find((w) => w.key === repoKey) ?? { key: repoKey, cwd: sub.cwd ?? "", base: sub.base };
					events.push(`${head} asks to merge tree ${String(m.data?.tree ?? "?")}${run.repos ? ` of repo ${repoKey}` : ""}. Check its diff against the brief's criteria (git -C ${wt.cwd} diff ${await diffBase(wt, o, run)}...HEAD), then call orch_accept${run.repos ? ` with repo "${repoKey}"` : ""}.`);
				} else if (m.type === "flow-ended") ended.push(sub);
				else events.push(`${head} ${m.type}: ${m.text}`);
			}
			if (r.bad) events.push(`[${sub.id}] ${r.bad} unreadable line(s) in its outbox were skipped.`);
			if (r.cursor !== readCursor(cur)) writeCursor(cur, r.cursor);
		}
		if (ended.length) {
			const at = new Date().toISOString();
			await mutate((r) => {
				for (const e of ended) {
					const s = r.subs.find((x) => x.id === e.id);
					if (s && !s.endedAt) s.endedAt = at;
				}
			});
		}
		const newlyEnded = ended.map((e) => e.id);
		if (stateChanges.length) {
			const ready = await mutate((r) => {
				for (const [id, st] of stateChanges) {
					const s = r.subs.find((x) => x.id === id);
					if (s && s.state !== "merged") s.state = st;
				}
			});
		}
		events.push(...(await checkEnded(false, newlyEnded))); // a quick first answer; later polls retry
		flush();
	}

	const reportedUnmerged = new Set<string>();
	const defaultBranches = new Map<string, string | null>();

	/** Confirms with gh the merge of every sub whose flow ended (or of `only`, when asked by hand); returns report lines. Retried on every poll until it succeeds. */
	async function checkEnded(manual: boolean, only?: string[]): Promise<string[]> {
		const o = owned;
		const run = current();
		if (!o || !run) return [];
		const lines: string[] = [];
		const merged: string[] = [];
		for (const sub of run.subs) {
			if (sub.state === "merged" || sub.state === "stopped") continue;
			if (only ? !only.includes(sub.id) : !sub.endedAt) continue;
			const res = !sub.branch ? { ok: null, missing: [] as string[] } : run.repos ? await mergedPerRepo(o, run, sub) : { ok: await ghMerged(o.repoCwd, sub.branch), missing: [] as string[] };
			const ok = res.ok;
			if (ok) merged.push(sub.id);
			else if (manual || !reportedUnmerged.has(sub.id)) {
				reportedUnmerged.add(sub.id);
				lines.push(`[${sub.id}] ${manual ? "not confirmed merged" : "its flow ended"} ${ok === null ? "(the merge could not be checked with gh)" : "without a merged pull request"}${res.missing.length ? ` (${res.missing.join("; ")})` : ""} (branch ${sub.branch}). ${manual ? "" : "It is checked again on every poll; /orch merged <id> checks now. "}Ask it (orch_send) or check the PR.`);
			}
		}
		if (merged.length) {
			const ready = await mutate((r) => {
				for (const id of merged) {
					const s = r.subs.find((x) => x.id === id);
					if (s) s.state = "merged";
				}
				return { ready: readyToSpawn(r), running: r.subs.filter((s) => ACTIVE.includes(s.state)).map((s) => s.id), all: r.subs.every((s) => s.state === "merged" || s.state === "stopped") };
			});
			for (const id of merged) {
				snaps.delete(id);
				lines.push(
					`[${id}] merged. ${ready.ready.length ? `Ready to spawn: ${ready.ready.join(", ")}.` : "Nothing new is ready to spawn."}${ready.running.length ? ` Running: ${ready.running.join(", ")}; they may need to rebase on the updated default branch.` : ""}${ready.all ? " All packages are done; tell the user, then /orch end." : ""}`,
				);
			}
		}
		return lines;
	}

	/** Multi-repo merge check: a repo is touched when its worktree has commits since its base or is dirty; merged = every touched repo has a merged PR for the branch. */
	async function mergedPerRepo(o: Owned, run: Run, sub: Sub): Promise<{ ok: boolean | null; missing: string[] }> {
		const missing: string[] = [];
		let touched = 0;
		let unknown = false;
		for (const wt of worktreesOf(sub, run)) {
			const dirty = ((await git(wt.cwd, "status", "--porcelain")) ?? "").trim().length > 0;
			const count = wt.base ? Number((await git(wt.cwd, "rev-list", "--count", `${wt.base}..HEAD`)) ?? "1") : 1;
			if (!dirty && !(count > 0)) continue;
			touched++;
			if (!(count > 0)) {
				missing.push(`uncommitted changes in ${wt.key}`);
				continue;
			}
			const ok = await ghMerged(topOfKey(o, run, wt.key), sub.branch ?? "");
			if (ok === null) unknown = true;
			if (!ok) missing.push(`no merged PR in ${wt.key}`);
		}
		if (!touched) return { ok: false, missing: ["no repo has changes"] };
		if (missing.length) return { ok: unknown && missing.every((x) => x.startsWith("no merged PR")) ? null : false, missing };
		return { ok: true, missing };
	}

	/** Where the sub's own work starts: its merge base with the default branch now (so a rebase does not turn merged packages into drift); the spawn-time commit when that fails. */
	async function diffBase(wt: Worktree, o: Owned, run: Run): Promise<string | undefined> {
		if (!wt.cwd) return wt.base;
		const viaHead = await git(wt.cwd, "merge-base", "HEAD", "origin/HEAD");
		if (viaHead) return viaHead;
		// no origin/HEAD (a repo made with git init + remote add): use the default branch name from gh, read once per repo
		if (!defaultBranches.has(wt.key)) {
			try {
				const g = await exec("gh", ["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], { cwd: topOfKey(o, run, wt.key) });
				defaultBranches.set(wt.key, g.code === 0 && g.stdout.trim() ? g.stdout.trim() : null);
			} catch {
				defaultBranches.set(wt.key, null);
			}
		}
		const name = defaultBranches.get(wt.key);
		if (name) {
			const viaName = await git(wt.cwd, "merge-base", "HEAD", `origin/${name}`);
			if (viaName) return viaName;
		}
		return wt.base;
	}

	async function pollGit(): Promise<void> {
		const o = owned;
		const run = current();
		if (!o || !run) return;
		const now = Date.now();
		const cur = new Map<string, Snapshot>();
		for (const sub of run.subs) {
			if (!ACTIVE.includes(sub.state) || !sub.cwd) continue;
			const sp = sf(o, sub.id, "status.json");
			const st = readStatus(sp);
			if (st.corrupt && !corruptSeen.has(sp)) {
				corruptSeen.add(sp);
				events.push(`[${sub.id}] status.json is unreadable: ${st.corrupt}`);
			}
			if (!st.status) continue;
			const heads: string[] = [];
			let por = "";
			const all = new Set<string>();
			for (const wt of worktreesOf(sub, run)) {
				heads.push((await git(wt.cwd, "rev-parse", "HEAD")) ?? "");
				const base = await diffBase(wt, o, run);
				const diff = base ? ((await git(wt.cwd, "diff", "--name-only", `${base}...HEAD`)) ?? "") : "";
				const p = (await git(wt.cwd, "status", "--porcelain")) ?? "";
				por += `${wt.key}\n${p}\n`;
				const dirty = p
					.split("\n")
					.filter(Boolean)
					.map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""));
				for (const file of [...diff.split("\n").filter(Boolean), ...dirty]) all.add(prefix(wt.key, file));
			}
			const head = heads.join(",");
			const files = [...all];
			const prev = snaps.get(sub.id);
			cur.set(sub.id, {
				head,
				porcelainHash: createHash("md5").update(por).digest("hex"),
				done: st.status.done,
				files,
				heartbeat: st.status.heartbeat,
				phase: st.status.phase,
				waiting: st.status.waiting === true,
				changedAt: prev?.changedAt ?? now,
				reported: prev?.reported ?? { drift: [], overlap: [], offline: false, stalled: false },
			});
		}
		const phases: Array<[string, Sub["state"]]> = [];
		for (const [id, snap] of cur) {
			const sub = subOf(run, id);
			const other = new Map<string, string[]>();
			for (const [oid, os2] of cur) if (oid !== id) other.set(oid, os2.files);
			const r = check(snaps.get(id), snap, { now, owns: sub.owns, forbids: sub.forbids, otherFiles: other, cfg });
			snaps.set(id, r.next);
			for (const e of r.events) events.push(`[${id}] ${e.type}: ${e.text}`);
			if (snap.phase === "plan" && sub.state === "spawned") phases.push([id, "planning"]);
			if (snap.phase === "execute" && (sub.state === "spawned" || sub.state === "planning")) phases.push([id, "executing"]);
		}
		if (phases.length) {
			await mutate((r) => {
				for (const [id, st] of phases) {
					const s = r.subs.find((x) => x.id === id);
					if (s && (s.state === "spawned" || s.state === "planning")) s.state = st;
				}
			});
		}
		events.push(...(await checkEnded(false)));
		flush();
	}

	function startWatcher(o: Owned): void {
		stopTimers();
		owned = o;
		snaps.clear();
		defaultBranches.clear();
		every(5_000, readOutboxes);
		every(cfg.pollSeconds * 1000, pollGit);
	}

	async function table(): Promise<string> {
		const { o, run } = need();
		const now = Date.now();
		const rows = run.subs.map((s) => {
			const st = readStatus(sf(o, s.id, "status.json")).status;
			const age = st ? `${Math.round((now - st.heartbeat) / 1000)}s ago` : "-";
			const steps = st?.total ? ` ${st.done ?? 0}/${st.total}` : "";
			return `${s.id.padEnd(16)} ${s.state.padEnd(20)} ${(st?.phase ?? "-") + steps + (st?.waiting ? " (waiting)" : "")}`.padEnd(52) + ` beat ${age}${s.branch ? `  ${s.branch}` : ""}`;
		});
		return `Run ${run.id} (${run.title}), running ${activeCount(run)}/${cfg.maxSubs}\n${rows.join("\n")}`;
	}

	const addedOf = (ctx: ExtensionContext): string[] => foldersFromEntries(ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[]);
	const topOf = async (dir: string): Promise<string | null> => {
		const t = await git(dir, "rev-parse", "--show-toplevel");
		return t ? norm(t) : null;
	};

	/** The run's repos: the working repo and the git repos of the added folders. Undefined when only one repo (a single-repo run). Throws on a key collision. */
	async function sessionRepos(ctx: ExtensionContext): Promise<Repo[] | undefined> {
		const working = await topOf(ctx.cwd);
		if (!working) throw new Error("not in a git repository");
		const added: string[] = [];
		for (const dir of addedOf(ctx)) {
			const t = await topOf(dir);
			if (t) added.push(t);
		}
		const built = buildRepos(working, added);
		if (built.error) throw new Error(built.error);
		return built.repos.length > 1 ? built.repos : undefined;
	}

	/** D7: owned paths that may overlap with active runs of the session's other repos; the user decides. One-sided: only runs found from this session's repos. */
	async function confirmOverlaps(ctx: ExtensionContext, repos: Repo[], packages: PackageInput[]): Promise<void> {
		const found: string[] = [];
		for (const repo of repos.slice(1)) {
			const common2 = await commonDir(exec, repo.top);
			if (!common2) continue;
			for (const other of listActiveRuns(common2).runs) {
				for (const os2 of other.subs) {
					if (os2.state === "merged" || os2.state === "stopped") continue;
					for (const og of os2.owns) {
						const sp = split(og);
						const otherTop = sp.key ? other.repos?.find((r) => r.key === sp.key)?.top : repo.top;
						if (!otherTop || !sameDir(otherTop, repo.top)) continue;
						for (const p of packages) for (const g of p.owns ?? []) {
							const mine = split(g);
							const myTop = repos.find((r) => r.key === mine.key)?.top;
							if (myTop && sameDir(myTop, repo.top) && globsMayOverlap(`r:${mine.path}`, `r:${sp.path}`)) found.push(`${p.id} owns "${g}", which may overlap "${og}" of package ${os2.id} in the active run ${other.id}`);
						}
					}
				}
			}
		}
		if (!found.length) return;
		const list = [...new Set(found)].slice(0, 10).join("\n- ");
		if (ctx.hasUI) {
			const pick = await ctx.ui.select(`Owned paths overlap with other active runs:\n- ${list}`, ["Create anyway", "Cancel"]);
			if (pick === "Create anyway") return;
		}
		throw new Error(`cancelled: owned paths overlap with active runs in other repos:\n- ${list}`);
	}

	const pkgSchema = Type.Object({
		id: Type.String({ description: "Short slug [a-z0-9-], up to 16 characters" }),
		goal: Type.String({ description: "What this package delivers" }),
		criteria: Type.Optional(Type.Array(Type.String(), { description: "Acceptance criteria, each checkable" })),
		owns: Type.Array(Type.String(), { description: "Globs of the paths this package may change (src/a/**); no two packages own the same glob. With added repos (/folders) write `repo:glob` (api:src/**); a glob with no repo means the working repo" }),
		forbids: Type.Optional(Type.Array(Type.String(), { description: "Globs it must not touch" })),
		dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Package ids that must be merged first" })),
		decisions: Type.Optional(Type.Array(Type.String(), { description: "Decisions already made with the user" })),
		notes: Type.Optional(Type.String()),
		repos: Type.Optional(Type.Array(Type.String(), { description: "Multi-repo runs: extra repo keys the package needs to read (repos it owns paths in are included on their own)" })),
	});

	pi.registerTool({
		name: "orch_run",
		label: "Orchestrate: run",
		description: "Create an orchestrated run from work packages (2 or more). Validates them, writes the briefs and starts watching. Spawn them afterwards with orch_spawn. One active run per repo.",
		promptSnippet: "orch_run: define the work packages of an orchestrated run (then orch_spawn)",
		parameters: Type.Object({ title: Type.String({ description: "Short title of the whole job" }), packages: Type.Array(pkgSchema) }),
		async execute(_id, params, _signal, _u, ctx) {
			uiCtx = ctx;
			// The check applies only while the guard is on: /orch off lifts it (D1).
			if (mode !== "off" && mode !== "run") throw new Error("approve the packages first (/orch, then go)");
			const common = await commonDir(exec, ctx.cwd);
			if (!common) throw new Error("not in a git repository");
			const active = listActiveRuns(common).runs;
			if (active.length) throw new Error(`run ${active[0].id} is still active in this repo; finish it or end it with /orch end`);
			const repos = await sessionRepos(ctx);
			if (!repos) {
				const keyed = (params.packages as PackageInput[]).flatMap((p) => [...(p.owns ?? []), ...(p.forbids ?? [])]).filter(hasKeyPrefix);
				if (keyed.length) throw new Error(`invalid packages: no other repos in this session, so use plain globs (not ${keyed.slice(0, 3).join(", ")}); add repos with /folders add`);
			}
			const errors = validatePackages(params.packages as PackageInput[], repos);
			if (errors.length) throw new Error(`invalid packages:\n- ${errors.join("\n- ")}`);
			const packages = repos ? canonicalPackages(params.packages as PackageInput[], repos).packages : (params.packages as PackageInput[]);
			if (repos) await confirmOverlaps(ctx, repos, packages);
			let existing: string[] = [];
			try {
				existing = fs.readdirSync(orchestraDir(common));
			} catch {
				// first run in this repo
			}
			const id = makeRunId(params.title, new Date(), existing);
			const subs: Sub[] = [];
			for (const p of packages) {
				const name = setName(id, p.id);
				if (!name) throw new Error(`package id "${p.id}" gives an invalid worktree name`);
				subs.push({
					id: p.id, goal: p.goal, criteria: p.criteria ?? [], owns: p.owns ?? [], forbids: p.forbids ?? [], dependsOn: p.dependsOn ?? [], decisions: p.decisions ?? [], notes: p.notes, name, state: "planned",
					...(repos ? { repos: subRepos(p, repos[0].key) } : {}),
				});
			}
			const run: Run = { v: 1, id, title: params.title, created: new Date().toISOString(), owner: { pid: process.pid, host: os.hostname(), session: ctx.sessionManager.getSessionFile() ?? "" }, state: "active", ...(repos ? { repos } : {}), subs };
			fs.mkdirSync(runDir(common, id), { recursive: true });
			for (const s of subs) {
				fs.mkdirSync(subDir(common, id, s.id), { recursive: true });
				fs.writeFileSync(`${subDir(common, id, s.id)}/brief.md`, renderBrief(s, run));
			}
			writeRun(common, run);
			startWatcher({ common, runId: id, repoCwd: ctx.cwd });
			return text(`Run ${id} created with ${subs.length} packages${repos ? ` over ${repos.length} repos (${repos.map((r) => r.key).join(", ")})` : ""}. Ready to spawn: ${readyToSpawn(run).join(", ") || "none"}. Briefs are in ${runDir(common, id)}/<id>/brief.md.`);
		},
	});

	pi.registerTool({
		name: "orch_spawn",
		label: "Orchestrate: spawn",
		description: "Open packages as sub-sessions, each in its own wt worktree and terminal. A package can be spawned when all its dependencies are merged, and at most maxSubs run at once.",
		promptSnippet: "orch_spawn: open ready packages as sub-sessions in worktrees",
		parameters: Type.Object({ ids: Type.Array(Type.String(), { description: "Package ids to spawn" }) }),
		async execute(_id, params, _signal, _u, ctx) {
			uiCtx = ctx;
			const { o, run } = need();
			const ready = readyToSpawn(run);
			const lines: string[] = [];
			let running = activeCount(run) + spawning.size;
			for (const id of params.ids) {
				const sub = subOf(run, id);
				if (!ready.includes(id) || spawning.has(id)) {
					lines.push(`${id}: not spawned (${sub.state === "planned" ? "a dependency is not merged yet" : `state ${sub.state}`})`);
					continue;
				}
				if (running + 1 > cfg.maxSubs) {
					lines.push(`${id}: not spawned (maxSubs ${cfg.maxSubs} reached)`);
					continue;
				}
				spawning.add(id);
				running++;
				try {
					// multi-repo: only the added folders this package needs go into its set (plain folders always do)
					let payload: Record<string, unknown> = { v: 1, name: sub.name };
					if (run.repos) {
						const added = addedOf(ctx);
						const keyOf = new Map<string, string | null>();
						for (const dir of added) {
							const t = await topOf(dir);
							keyOf.set(dir, t ? (run.repos.find((r) => sameDir(r.top, t))?.key ?? "?") : null);
						}
						payload = { ...payload, folders: foldersFor(sub, added, (dir) => keyOf.get(dir) ?? null) };
					}
					const claims = emitClaims((d) => pi.events.emit("worktree:create", d), payload, 120_000);
					if (!claims.claimed) throw new Error("worktree extension not loaded");
					const ans = (await claims.answer) as { error?: string; cwd?: string; branch?: string; launched?: boolean; text?: string; repos?: Array<{ top?: string; cwd?: string }> } | null;
					if (!ans || ans.error || !ans.cwd) throw new Error(ans?.error ?? "worktree extension gave no answer");
					const top = norm((await git(ans.cwd, "rev-parse", "--show-toplevel")) ?? ans.cwd); // a sub-session finds itself by its git top level
					const base = (await git(top, "rev-parse", "HEAD")) ?? undefined;
					const wts: Worktree[] = [];
					const notes: string[] = [];
					if (run.repos) {
						wts.push({ key: run.repos[0].key, cwd: top, base });
						for (const r of Array.isArray(ans.repos) ? ans.repos : []) {
							if (typeof r?.top !== "string" || typeof r.cwd !== "string") continue;
							const key = run.repos.find((x) => sameDir(x.top, r.top as string))?.key;
							if (!key || wts.some((w) => w.key === key)) continue;
							const wtop = norm((await git(r.cwd, "rev-parse", "--show-toplevel")) ?? r.cwd);
							wts.push({ key, cwd: wtop, base: (await git(wtop, "rev-parse", "HEAD")) ?? undefined });
						}
						if (!Array.isArray(ans.repos)) notes.push("the worktree extension did not report its repos (old version): only the working repo is watched");
						else for (const k of sub.repos ?? []) if (!wts.some((w) => w.key === k)) notes.push(`no worktree for repo ${k}`);
					}
					await mutate((r) => {
						const s = subOf(r, id);
						s.cwd = top;
						s.branch = ans.branch;
						s.base = base;
						if (run.repos) s.worktrees = wts;
						s.state = "spawned";
					});
					lines.push(`${id}: spawned in ${top} (${ans.branch ?? "branch ?"})${ans.launched ? "" : "; the terminal did not open, use /wt open " + sub.name}${wts.length > 1 ? `; worktrees: ${wts.map((w) => w.key).join(", ")}` : ""}${notes.length ? `. WARNING: ${notes.join("; ")}` : ""}`);
				} catch (e) {
					running--;
					lines.push(`${id}: failed: ${(e as Error).message} (still planned)`);
				} finally {
					spawning.delete(id);
				}
			}
			return text(`${lines.join("\n")}\nThe sub-sessions start at the plan phase on their own; plans and questions arrive as messages.`);
		},
	});

	pi.registerTool({
		name: "orch_status",
		label: "Orchestrate: status",
		description: "Compact table of the run: each package's state, phase, steps, heartbeat and branch.",
		promptSnippet: "orch_status: table of the run's packages",
		parameters: Type.Object({}),
		async execute() {
			return text(await table());
		},
	});

	pi.registerTool({
		name: "orch_send",
		label: "Orchestrate: send",
		description: "Send a message to a sub-session: answer (to a question, with replyTo), directive (an instruction; urgent interrupts) or info.",
		promptSnippet: "orch_send: answer, instruct or inform a sub-session",
		parameters: Type.Object({
			id: Type.String({ description: "Package id" }),
			type: StringEnum(["answer", "directive", "info"] as const),
			text: Type.String(),
			replyTo: Type.Optional(Type.String({ description: "Question id, for an answer" })),
			urgent: Type.Optional(Type.Boolean({ description: "directive only: interrupt the running turn" })),
		}),
		async execute(_id, params) {
			const { o, run } = need();
			subOf(run, params.id);
			const m = appendMessage(sf(o, params.id, "inbox.jsonl"), "orch", { type: params.type, text: params.text, replyTo: params.replyTo, data: params.urgent ? { urgent: true } : undefined });
			return text(`sent ${m.id} to ${params.id}`);
		},
	});

	pi.registerTool({
		name: "orch_review_plan",
		label: "Orchestrate: review plan",
		description: "Give the verdict on a sub-session's plan after reading it. With confirmPlans on, the user confirms an approval from your summary. Give reasons when rejecting.",
		promptSnippet: "orch_review_plan: approve or reject a sub-session's plan",
		parameters: Type.Object({
			id: Type.String(),
			n: Type.Number({ description: "Plan number from the plan-review message; the verdict counts only for that plan" }),
			approve: Type.Boolean(),
			summary: Type.String({ description: "One line: what the plan does and why it fits the brief" }),
			reasons: Type.Optional(Type.String({ description: "Required when rejecting: what to change" })),
		}),
		async execute(_id, params, _s, _u, ctx) {
			uiCtx = ctx;
			const { o, run } = need();
			subOf(run, params.id);
			let approve = params.approve;
			let reasons = params.reasons ?? "";
			if (approve && cfg.confirmPlans && ctx.hasUI) {
				const pick = await ctx.ui.select(`Approve plan of ${params.id}? ${params.summary}`, ["Approve", "Reject"]);
				if (pick !== "Approve") {
					approve = false;
					reasons = (await ctx.ui.input("Why reject? (sent to the sub-session)", "")) || "the user rejected the plan";
				}
			}
			if (!approve && !reasons) throw new Error("reasons are required when rejecting a plan");
			appendMessage(sf(o, params.id, "inbox.jsonl"), "orch", { type: "plan-verdict", text: approve ? "approved" : reasons, data: { approve, n: params.n } });
			return text(approve ? `plan ${params.n} of ${params.id} approved` : `plan ${params.n} of ${params.id} rejected: ${reasons}`);
		},
	});

	pi.registerTool({
		name: "orch_accept",
		label: "Orchestrate: accept",
		description: "Accept or refuse the result a sub-session asked to merge, after checking its diff against the brief's criteria. Acceptance covers the tree it requested; if the worktree changed since, accept again after a new request.",
		promptSnippet: "orch_accept: accept or refuse a sub-session's merge request",
		parameters: Type.Object({ id: Type.String(), accept: Type.Boolean(), reasons: Type.Optional(Type.String({ description: "Required when refusing" })), repo: Type.Optional(Type.String({ description: "Multi-repo runs: the repo key of the request; default the repo of its latest request" })) }),
		async execute(_id, params) {
			const { o, run } = need();
			const sub = subOf(run, params.id);
			const wantRepo = params.repo?.toLowerCase();
			const reqs = readNew(sf(o, params.id, "outbox.jsonl"), 0).msgs.filter((m) => m.type === "accept-request" && (wantRepo === undefined || String(m.data?.repo ?? workingKey(run)) === wantRepo));
			const tree = reqs.length ? String(reqs[reqs.length - 1].data?.tree ?? "") : "";
			if (!tree) throw new Error(`${params.id} has not asked for acceptance${wantRepo ? ` in repo ${wantRepo}` : ""} yet`);
			const repo = reqs.length ? String(reqs[reqs.length - 1].data?.repo ?? workingKey(run)) : workingKey(run);
			if (!params.accept && !params.reasons) throw new Error("reasons are required when refusing");
			if (params.accept) {
				const wt = worktreesOf(sub, run).find((w) => w.key === repo);
				const now = wt ? await git(wt.cwd, "rev-parse", "HEAD^{tree}") : null;
				if (now !== tree) throw new Error(`the sub-session changed since its request (requested tree ${tree}, now ${now ?? "unknown"}); wait for its next accept-request`);
				addAccepted(sf(o, params.id, "accepted.json"), repo ? `${repo}:${tree}` : tree);
			}
			appendMessage(sf(o, params.id, "inbox.jsonl"), "orch", {
				type: "accept-verdict",
				text: params.accept ? `Tree ${tree}${repo ? ` of repo ${repo}` : ""} accepted; retry the merge.` : `Not accepted${repo ? ` (repo ${repo})` : ""}: ${params.reasons}`,
				data: { accept: params.accept, tree, repo },
			});
			if (!params.accept) await mutate((r) => {
				const s = subOf(r, params.id);
				if (s.state === "awaiting-acceptance") s.state = "executing";
			});
			return text(params.accept ? `accepted tree ${tree}${repo ? ` of repo ${repo}` : ""} of ${params.id}` : `refused ${params.id}: ${params.reasons}`);
		},
	});

	pi.registerCommand("orch", {
		description: "Orchestrator mode and run: start (read-only discussion), off, status, watch (resume watching a run), merged <id> (check a PR merge now), end",
		getArgumentCompletions: (prefix) =>
			["start", "off", "status", "watch", "merged", "end"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			uiCtx = ctx;
			let sub = args.trim().split(/\s+/)[0];
			if (!sub) sub = owned || me ? "status" : mode === "off" ? "start" : "mode";
			try {
				if (sub === "start") {
					if (me) throw new Error("this is a sub-session of a run; start orchestrating from another session");
					if (lastK4 && typeof lastK4.phase === "string" && lastK4.phase !== "off") throw new Error(`the workflow is in phase ${lastK4.phase}; end it (/flow off) before /orch start`);
					const common = await commonDir(exec, ctx.cwd);
					if (!common) throw new Error("not in a git repository");
					const active = listActiveRuns(common).runs[0];
					if (active) throw new Error(`run ${active.id} is still active in this repo; resume it with /orch watch or end it with /orch end`);
					setMode("discuss", false);
					const title = args.trim().slice("start".length).trim();
					ctx.ui.notify("orchestrate: discuss mode (read-only). Say \"go\" for the package proposal, \"go\" again to run it; /orch off lifts the guard.", "info");
					if (title) pi.sendUserMessage(title, { deliverAs: "followUp" });
				} else if (sub === "mode") {
					ctx.ui.notify(`orchestrate: mode ${mode}${mode === "discuss" ? "; \"go\" asks for the package proposal" : mode === "propose" ? "; \"go\" on a finished proposal starts the run" : ""}; /orch off lifts the guard`, "info");
				} else if (sub === "off") {
					setMode("off");
					if (owned) ctx.ui.notify(`orchestrate: the watcher keeps running run ${owned.runId}`, "info");
				} else if (sub === "status") {
					ctx.ui.notify(await table(), "info");
				} else if (sub === "merged") {
					const id = args.trim().split(/\s+/)[1];
					if (!id) throw new Error("usage: /orch merged <id>");
					subOf(need().run, id);
					ctx.ui.notify(`orchestrate: ${(await checkEnded(true, [id])).join("\n") || "nothing to check"}`, "info");
				} else if (sub === "end" && !owned) {
					if (mode === "off") throw new Error("no active run in this session");
					setMode("off");
				} else if (sub === "end") {
					await mutate((r) => {
						r.state = "ended";
					});
					const id = owned?.runId;
					stopWatcher();
					if (mode !== "off") setMode("off", false);
					ctx.ui.notify(`orchestrate: run ${id} ended; the worktrees stay (remove them with /wt)`, "info");
				} else if (sub === "watch") {
					const common = await commonDir(exec, ctx.cwd);
					if (!common) throw new Error("not in a git repository");
					const run = listActiveRuns(common).runs[0];
					if (!run) throw new Error("no active run in this repo");
					const mine = run.owner.session && run.owner.session === (ctx.sessionManager.getSessionFile() ?? "");
					const alive = run.owner.host === os.hostname() && pidAlive(run.owner.pid) && run.owner.pid !== process.pid;
					if (!mine && alive) throw new Error(`run ${run.id} is watched by another live session (pid ${run.owner.pid})`);
					startWatcher({ common, runId: run.id, repoCwd: ctx.cwd });
					setMode("run", false);
					await mutate((r) => {
						r.owner = { pid: process.pid, host: os.hostname(), session: ctx.sessionManager.getSessionFile() ?? "" };
					});
					ctx.ui.notify(`orchestrate: watching run ${run.id}`, "info");
				} else {
					ctx.ui.notify("usage: /orch start [title] | off | status | watch | merged <id> | end", "warning");
				}
			} catch (e) {
				ctx.ui.notify(`orchestrate: ${(e as Error).message}`, "error");
			}
		},
	});

	function pidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	// ---------------------------------------------------------------- start and stop

	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		stopTimers();
		owned = null;
		me = null;
		started = false;
		pendingAsk = new Map();
		k10 = null;
		mode = modeFromEntries(ctx.sessionManager.getBranch());
		proposalReady = false;
		k4Warned = false;
		const gen = ++generation;
		const loaded = loadConfig(getAgentDir());
		cfg = loaded.config;
		if (loaded.warning) say(loaded.warning, "warning");
		if (!ctx.hasUI) return;
		const common = await commonDir(exec, ctx.cwd);
		if (!common) return;
		const listed = listActiveRuns(common);
		for (const c of listed.corrupt) if (!corruptSeen.has(c)) {
			corruptSeen.add(c);
			say(`unreadable run file: ${c}`, "warning");
		}
		const top = await git(ctx.cwd, "rev-parse", "--show-toplevel");
		const become = (hit: { run: Run; sub: Sub }) => {
			const m: Me = { common, run: hit.run, sub: hit.sub, dir: subDir(common, hit.run.id, hit.sub.id) };
			me = m;
			mode = "off";
			const fresh = !fs.existsSync(`${m.dir}/status.json`);
			started = !fresh;
			prevPhase = "off";
			every(3_000, deliverInbox);
			every(60_000, writeMyStatus);
			if (fresh) void startSubSession(m, ctx).catch((e: Error) => ctx.ui.notify(`orchestrate: ${e.message}`, "error"));
		};
		const hit = top ? findSubByToplevel(listed.runs, top) : null;
		if (hit) {
			become(hit);
			return;
		}
		const file = ctx.sessionManager.getSessionFile() ?? "";
		const mine = file ? listed.runs.find((r) => r.owner.session === file) : undefined;
		if (mine) {
			startWatcher({ common, runId: mine.id, repoCwd: ctx.cwd });
			say(`resumed watching run ${mine.id}`);
			return;
		}
		// the terminal may open before orch_spawn has written this worktree into run.json: look again for about 15 s
		if (top) {
			void (async () => {
				for (let i = 0; i < 5; i++) {
					await new Promise((res) => setTimeout(res, 3_000));
					if (gen !== generation || me) return;
					const again = findSubByToplevel(listActiveRuns(common).runs, top);
					if (again) {
						become(again);
						return;
					}
				}
			})();
		}
	});

	pi.on("session_shutdown", async () => {
		stopTimers();
		k10?.resolve(null);
		k10 = null;
		generation++;
	});
}
