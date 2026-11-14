/**
 * The relay executor: a run's packages become relay jobs. Talks to relay only through the pi.events contracts
 * (relay:dispatch, relay:control, relay:job-query, relay:hosted; the tagged relay:job-start/job-progress/job-end/approval).
 * Never imports relay and never reads relay's job files. index.ts wires the bus and the timers; everything else is here.
 */

import * as fs from "node:fs";
import { emitClaims } from "../shared/claims.ts";
import { readyToSpawn, type JobRepo, type Run, type Sub } from "./brief.ts";
import { RELAY_CATEGORIES } from "./config.ts";
import type { Mode } from "./mode.ts";
import { split } from "./repos.ts";

export type Executor = "relay" | "workflow";

/** The executor of a run (older runs have none: workflow); with no run, the configured one. */
export function executorOf(run: Pick<Run, "executor"> | null | undefined, configured: Executor): Executor {
	return run ? (run.executor ?? "workflow") : configured;
}

// ------------------------------------------------------------------------------------------ hosted

export type Hosted = { state: "on" } | { state: "pending" } | { state: "off"; reason: string };

/**
 * What relay's answer to `relay:hosted {on: true}` means. "no session context" is pending once (relay decides at its
 * session_start; the claim is retried at the first turn); after that retry, and for any other "off", relay cannot host.
 */
export function hostedDecision(answer: unknown, retried: boolean): Hosted {
	if (answer === null || answer === undefined) return { state: "off", reason: "relay is not loaded" };
	const a = answer as { mode?: unknown; reason?: unknown; error?: unknown };
	if (typeof a.error === "string") return { state: "off", reason: a.error };
	if (a.mode === "on") return { state: "on" };
	const reason = typeof a.reason === "string" && a.reason ? a.reason : "relay answered off";
	if (reason === "no session context" && !retried) return { state: "pending" };
	return { state: "off", reason };
}

/** Whether a mode change claims (`on`) or releases (`off`) relay's hosted mode. Only for executor relay. */
export function hostedChange(from: Mode, to: Mode, executor: Executor): "on" | "off" | null {
	if (executor !== "relay") return null;
	if (from === "off" && to !== "off") return "on";
	if (from !== "off" && to === "off") return "off";
	return null;
}

/** Emits `relay:hosted`; with `on` the answer is awaited. */
export async function claimHosted(emit: (event: string, data: unknown) => void, on: boolean, timeoutMs = 5000): Promise<unknown> {
	if (!on) {
		emit("relay:hosted", { v: 1, on: false });
		return null;
	}
	const c = emitClaims((d) => emit("relay:hosted", d), { v: 1, on: true }, timeoutMs);
	return c.claimed ? c.answer : null;
}

/** The user-facing line when relay cannot host this session. */
export const hostedOffText = (reason: string): string => `relay is unavailable or cannot host this session (${reason}); no relay run starts. Fix relay, or set "executor": "workflow" in orchestrate.json and /orch start again.`;

// ------------------------------------------------------------------------------------------ the brief

const slash = (p: string) => p.split("\\").join("/").replace(/\/+$/, "");
const base = (p: string) => slash(p).split("/").pop() ?? p;

/** Orchestrate repo key -> relay repo name: the folder name of the repo top; two repos with one folder name (case-insensitive) use their full tops. */
export function relayNames(run: Pick<Run, "repos" | "top">): Map<string, string> {
	const tops: Array<[string, string]> = run.repos?.length ? run.repos.map((r) => [r.key, slash(r.top)]) : [["", slash(run.top ?? "")]];
	const count = new Map<string, number>();
	for (const [, t] of tops) count.set(base(t).toLowerCase(), (count.get(base(t).toLowerCase()) ?? 0) + 1);
	return new Map(tops.map(([k, t]) => [k, (count.get(base(t).toLowerCase()) ?? 0) > 1 ? t : base(t)]));
}

/** The repo keys a package works in (its Targets): every repo of a single-repo run, a multi-repo package's `repos`. */
const keysOf = (sub: Sub, run: Run): string[] => (run.repos?.length ? (sub.repos?.length ? sub.repos : run.repos.map((r) => r.key)) : [""]);

/** A canonical glob with relay's repo name instead of the orchestrate key. */
export function relayGlob(glob: string, run: Run, names = relayNames(run)): string {
	if (!run.repos?.length) return glob;
	const { key, path } = split(glob);
	const name = names.get(key || run.repos[0].key);
	return name ? `${name}:${path}` : glob;
}

/** A Verify line with relay's repo name instead of the orchestrate key (`api: npm test`). Lines with no repo key stay as they are. */
export function relayVerifyLine(line: string, run: Run, names = relayNames(run)): string {
	const l = line.replace(/^\s*[-*]\s+/, "").trim();
	if (!run.repos?.length) return l;
	const m = /^([^\s:]+):\s+(.+)$/.exec(l);
	const name = m && names.get(m[1].toLowerCase());
	return m && name && run.repos.some((r) => r.key === m[1].toLowerCase()) ? `${name}: ${m[2]}` : l;
}

const LABELS = ["goal", "user decisions", "non-goals", "priorities", "target", "standing orders", "reserved for the user"];
const clean = (l: string) => l.replace(/^\s*[-*]\s+/, "").replace(/\*\*/g, "").trim();
const labelOf = (l: string): string | undefined => {
	const m = /^([A-Za-z -]+?)\s*:/.exec(clean(l));
	const k = m?.[1].trim().toLowerCase();
	return k && LABELS.includes(k) ? k : undefined;
};

/** The items of a charter line (`Standing orders: ...` plus the bullets under it until the next charter label). */
export function charterField(charter: string, label: string): string[] {
	const out: string[] = [];
	let on = false;
	for (const raw of (charter ?? "").split(/\r?\n/)) {
		if (/^#/.test(raw.trim())) {
			on = false;
			continue;
		}
		const l = labelOf(raw);
		if (l) {
			on = l === label.toLowerCase();
			if (on) {
				const rest = clean(raw).replace(/^[^:]*:\s*/, "");
				if (rest) out.push(rest);
			}
			continue;
		}
		if (on && clean(raw)) out.push(clean(raw));
	}
	return out;
}

export const DEFAULT_SCALE = "No numbers were given: assume the repo's current sizes; nothing needs to scale beyond them.";
const bullets = (items: string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty ? `- ${empty}` : "");

/** Relay's brief for one package: every section relay requires, never a `## Depends on` (dependents wait for the merge). */
export function renderRelayBrief(sub: Sub, run: Run): string {
	const names = relayNames(run);
	const others = run.subs.filter((s) => s.id !== sub.id);
	const files = sub.owns.map((g) => relayGlob(g, run, names));
	const targets = keysOf(sub, run).map((k) => {
		const t = run.targets?.[k];
		return t ? `${names.get(k)}: ${t.replace(/^origin\//, "")}` : `${names.get(k)}: (no target)`;
	});
	const nonGoals = [
		...sub.forbids.map((g) => `Do not touch ${relayGlob(g, run, names)}`),
		...others.flatMap((o) => o.owns.map((g) => `${relayGlob(g, run, names)} (package ${o.id} owns it)`)),
	];
	const constraints = [`Stay inside Files (${files.join(", ")}).`, ...charterField(run.charter ?? "", "standing orders"), ...charterField(run.charter ?? "", "non-goals").map((n) => `Non-goal of the run: ${n}`)];
	const decisions = [...sub.decisions, ...charterField(run.charter ?? "", "user decisions").map((d) => `User decision: ${d}`)];
	const design = [
		...(sub.notes?.trim() ? [sub.notes.trim(), ""] : []),
		`This package is one of ${run.subs.length} of the orchestrated run "${run.title}". The other packages:`,
		bullets(others.map((o) => `${o.id}: ${o.goal} (Files: ${o.owns.map((g) => relayGlob(g, run, names)).join(", ")})`), "none"),
	];
	return [
		`# Package ${sub.id}: ${run.title}`,
		"",
		"## Goal",
		sub.goal.trim(),
		"",
		"## Done when",
		bullets(sub.criteria, sub.goal.trim()),
		"",
		"## Non-goals",
		bullets(nonGoals, "anything beyond the Goal"),
		"",
		"## Constraints",
		bullets(constraints, "none"),
		"",
		"## Decisions (locked)",
		bullets(decisions, "none beyond the Goal"),
		"",
		"## Design",
		design.join("\n"),
		"",
		"## Scale",
		sub.scale?.trim() || DEFAULT_SCALE,
		"",
		"## Verify",
		bullets((sub.verify ?? []).map((v) => relayVerifyLine(v, run, names)).filter(Boolean), ""),
		"",
		"## Targets",
		bullets(targets, ""),
		"",
		"## Authority",
		bullets((run.authority ?? []).map((a) => a.replace(/^\s*[-*]\s+/, "").trim()), ""),
		"",
		...(sub.budget?.trim() ? ["## Budget", sub.budget.trim(), ""] : []),
		"## Files",
		bullets(files, ""),
		"",
	].join("\n");
}

/** Copy of relay's required sections (relay/brief.ts REQUIRED_SECTIONS). */
const REQUIRED = ["Goal", "Done when", "Non-goals", "Constraints", "Decisions (locked)", "Design", "Scale", "Verify"];
const NEEDS_SPECIFICS = ["merge", "publish", "delete", "formats"];
const AUTHORITY_LINE = /^(\w+)\s*:\s*(yes|no|n\/a)\b\s*(?:\((.*)\))?\s*$/i;

function sectionsOf(text: string): Map<string, string> {
	const out = new Map<string, string>();
	let name: string | undefined;
	let body: string[] = [];
	const flush = () => {
		if (name !== undefined) out.set(name.toLowerCase(), body.join("\n").trim());
	};
	for (const l of text.split(/\r?\n/)) {
		const m = /^##\s+(.+?)\s*$/.exec(l);
		if (m) {
			flush();
			name = m[1];
			body = [];
		} else body.push(l);
	}
	flush();
	return out;
}
const lines = (body: string | undefined) => (body ?? "").split(/\r?\n/).map((l) => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);

/** Problems in run Authority lines (relay syntax, all six categories); empty when fine. */
export function authorityProblems(authority: string[]): string[] {
	const e: string[] = [];
	const seen = new Map<string, { value: string; specifics?: string }>();
	for (const l of authority.map((a) => a.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean)) {
		const m = AUTHORITY_LINE.exec(l);
		if (!m || !(RELAY_CATEGORIES as readonly string[]).includes(m[1].toLowerCase())) {
			e.push(`Authority: cannot read "${l}" (expected "<${RELAY_CATEGORIES.join("|")}>: yes (<specifics>) | no | n/a")`);
			continue;
		}
		seen.set(m[1].toLowerCase(), { value: m[2].toLowerCase(), specifics: m[3]?.trim() || undefined });
	}
	for (const c of RELAY_CATEGORIES) {
		const a = seen.get(c);
		if (!a) e.push(`Authority: "${c}" is missing (yes (<specifics>), no or n/a)`);
		else if (a.value === "yes" && !a.specifics && NEEDS_SPECIFICS.includes(c)) e.push(`Authority: "${c}: yes" needs specifics, e.g. "${c}: yes (<what exactly>)"`);
	}
	return e;
}

/**
 * The local brief check: a copy of relay's required-section and Authority-syntax rules, plus: Targets lines are readable,
 * no `## Depends on`, and every repo name (`names`, the run's relay names) used in a Verify line or a Files glob is a Targets key.
 */
export function checkRelayBrief(text: string, names: string[]): string[] {
	const e: string[] = [];
	const s = sectionsOf(text);
	for (const r of REQUIRED) if (!s.get(r.toLowerCase())?.trim()) e.push(`section "${r}" is missing or empty`);
	if (s.get("done when")?.trim() && !/^\s*[-*]\s+\S/m.test(s.get("done when") ?? "")) e.push('"Done when" needs at least one bullet');
	if (s.has("depends on")) e.push("a `## Depends on` section is not allowed (dependents wait for the merge)");
	e.push(...authorityProblems(lines(s.get("authority"))));
	const targets: string[] = [];
	for (const l of lines(s.get("targets"))) {
		const m = /^(.+?)\s*:\s+(\S+)$/.exec(l);
		if (!m) e.push(`Targets: cannot read "${l}" (expected "<repo dir or name>: <branch>")`);
		else targets.push(m[1].toLowerCase());
	}
	if (!targets.length) e.push("Targets: at least one line `<repo dir or name>: <branch>`");
	const known = names.map((n) => n.toLowerCase());
	const needTarget = (name: string, where: string) => {
		if (!targets.includes(name.toLowerCase())) e.push(`${where} names the repo "${name}", which has no Targets line`);
	};
	for (const l of lines(s.get("verify"))) {
		const m = /^(.+?):\s+(.+)$/.exec(l);
		if (m && known.includes(m[1].toLowerCase())) needTarget(m[1], `Verify "${l}"`);
	}
	for (const g of lines(s.get("files"))) {
		const i = g.lastIndexOf(":");
		const name = i > 0 ? g.slice(0, i) : "";
		if (name && known.includes(name.toLowerCase())) needTarget(name, `Files "${g}"`);
		else if (name && !/^[a-z]$/i.test(name)) e.push(`Files "${g}" names an unknown repo "${name}"`);
	}
	for (const part of (s.get("budget") ?? "").split(/[;\n]/).map((p) => p.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean)) {
		const m = /^(wall|tokens|size)\s*:\s*(.+)$/i.exec(part);
		const ok = m && (m[1].toLowerCase() === "wall" ? /^\d+\s*(m|min|h)?$/i.test(m[2].trim()) : m[1].toLowerCase() === "tokens" ? /^\d+(\.\d+)?\s*[kKmM]?$/.test(m[2].trim()) : ["small", "normal", "large"].includes(m[2].trim()));
		if (!ok) e.push(`Budget: cannot read "${part}" (wall: 120m; tokens: 4M; size: small|normal|large)`);
	}
	return e;
}

/** The brief problems of every package of a run (by package). */
export function checkRunBriefs(run: Run): string[] {
	const names = [...relayNames(run).values()];
	return run.subs.flatMap((s) => checkRelayBrief(renderRelayBrief(s, run), names).map((p) => `${s.id}: ${p}`));
}

// ------------------------------------------------------------------------------------------ the state machine

/** The relay job states that are finished (copy of relay/job.ts FINISHED). */
const FINISHED = ["done", "stopped", "failed"];
const UNFINISHED_PKG: Sub["state"][] = ["dispatched", "retry-pending"];

export interface JobInfo {
	id: string;
	state: string;
	tag?: { run: string; package: string };
	used?: { tokens: number; wallMs: number };
	repos?: JobRepo[];
	report?: string;
	reason?: string;
}

export interface ExecDeps {
	/** `pi.events.emit`. */
	emit: (event: string, data: unknown) => void;
	/** The run as stored (run.json); null when there is none. */
	read: () => Run | null;
	/** Serialised read-modify-write of run.json. */
	mutate: <T>(fn: (run: Run) => T) => Promise<T>;
	/** The run folder. */
	dir: string;
	runTokens: () => number;
	/** Something the user must see (shown in the chat). */
	tell: (text: string) => void;
	/** The run ended: unregister and stop the timers. */
	ended: () => void;
	/** After a state change (the widget). */
	changed?: () => void;
	timeoutMs?: number;
}

const asRepos = (v: unknown): JobRepo[] | undefined =>
	Array.isArray(v) ? v.filter((r) => r && typeof r.key === "string").map((r) => ({ key: r.key, ...(typeof r.pr === "string" ? { pr: r.pr } : {}), merged: r.merged === true })) : undefined;
const tokensOf = (used: unknown): number | undefined => {
	const t = (used as { tokens?: unknown } | undefined)?.tokens;
	return typeof t === "number" && Number.isFinite(t) ? t : undefined;
};
const tagOf = (v: unknown): { run: string; package: string } | undefined => {
	const t = v as { run?: unknown; package?: unknown } | undefined;
	return t && typeof t.run === "string" && typeof t.package === "string" ? { run: t.run, package: t.package } : undefined;
};

/** The transitive dependents of `id`. */
export function dependentsOf(run: Run, id: string): string[] {
	const out: string[] = [];
	const todo = [id];
	while (todo.length) {
		const cur = todo.shift() as string;
		for (const s of run.subs) if (s.dependsOn.includes(cur) && !out.includes(s.id) && s.id !== id) {
			out.push(s.id);
			todo.push(s.id);
		}
	}
	return out;
}

/** Whether a stopped or failed job gets its one follow-up retry. */
export function retryAllowed(sub: Pick<Sub, "retries" | "stoppedBy">, reason: string | undefined): boolean {
	return (sub.retries ?? 0) < 1 && sub.stoppedBy !== "orchestrator" && !/^budget:/i.test((reason ?? "").trim());
}

/** The text of the follow-up that retries a package. */
export const retryText = (sub: Pick<Sub, "reason" | "report">): string =>
	`Retry: the job ended with "${sub.reason ?? "no reason given"}". ${sub.report ? `Its report was ${sub.report}; relay keeps it as report.before-followup-<n>.md (report.before-followup-*.md) in the same folder when the follow-up starts.` : "There is no report of that run."} Read it, fix what made the job end, then run Verify and report_done again.`;

/** Marks the package failed and every transitive dependent blocked (in `run`, which the caller writes). Returns the blocked ids. */
function failIn(run: Run, id: string, reason: string): string[] {
	const s = run.subs.find((x) => x.id === id);
	if (!s) return [];
	s.state = "failed";
	s.reason = reason;
	const blocked: string[] = [];
	for (const d of dependentsOf(run, id)) {
		const t = run.subs.find((x) => x.id === d);
		if (!t || t.state === "merged" || t.state === "failed" || t.state === "blocked") continue;
		t.state = "blocked";
		t.reason = `blocked by ${id}: ${reason}`;
		blocked.push(d);
	}
	return blocked;
}

const sumTokens = (run: Run): number => run.subs.reduce((n, s) => n + (s.tokens ?? 0), 0);
const prList = (prs: JobRepo[] | undefined) => (prs ?? []).filter((r) => !r.merged).map((r) => `${r.key}: ${r.pr ?? "(no PR)"}`).join(", ") || "(no PR)";

export const approvalsFile = (dir: string) => `${dir}/approvals.jsonl`;
export const reportFile = (dir: string) => `${dir}/report.md`;
export const findingsFile = (dir: string) => `${dir}/findings.md`;

export interface ApprovalLine {
	at: string;
	job: string;
	package?: string;
	category: string;
	item: string;
	by: string;
	reason: string;
}

export function readApprovals(dir: string): ApprovalLine[] {
	try {
		return fs.readFileSync(approvalsFile(dir), "utf8").split(/\r?\n/).filter(Boolean).flatMap((l) => {
			try {
				return [JSON.parse(l) as ApprovalLine];
			} catch {
				return [];
			}
		});
	} catch {
		return [];
	}
}

/** The run report: Approvals first, then each package, the run tokens and the open proposal findings. */
export function buildReport(run: Run, approvals: ApprovalLine[], findings: string, runTokens: number): string {
	const out = [`# Run ${run.id}: ${run.title}`, "", "## Approvals"];
	out.push(approvals.length ? approvals.map((a) => `- ${a.package ?? "?"} (${a.job}): ${a.category} \`${a.item}\` by ${a.by}: ${a.reason}`).join("\n") : "- none");
	out.push("", "## Packages");
	for (const s of run.subs) {
		out.push(`### ${s.id}: ${s.state}`);
		if (s.job) out.push(`- job ${s.job}${s.retries ? ` (${s.retries} retry)` : ""}${s.report ? `; report: ${s.report}` : ""}`);
		for (const r of s.prs ?? []) out.push(`- ${r.key}: ${r.merged ? "merged" : "not merged"}${r.pr ? ` (${r.pr})` : ""}`);
		if (s.state === "delivered-pr") {
			const held = dependentsOf(run, s.id).filter((d) => run.subs.find((x) => x.id === d)?.state === "planned");
			out.push(`- held: the PR waits for a merge by hand${held.length ? `; it holds ${held.join(", ")}` : ""}`);
		} else if (s.reason && (s.state === "failed" || s.state === "blocked")) out.push(`- reason: ${s.reason}`);
	}
	out.push("", "## Tokens", `${sumTokens(run).toLocaleString("en-US")} weighted tokens used of ${runTokens.toLocaleString("en-US")}.`);
	out.push("", "## Open proposal findings", findings.trim() || "None.", "");
	return out.join("\n");
}

/** Whether the run can still move without a hand merge: a job is unfinished, or a package can be dispatched. */
export function canMove(run: Run): boolean {
	return run.subs.some((s) => UNFINISHED_PKG.includes(s.state)) || readyToSpawn(run).length > 0;
}

type Answer = Record<string, unknown> & { error?: string };

export class RelayExec {
	private readonly d: ExecDeps;
	private readonly dispatching = new Set<string>();
	/** A query or dispatch met "no session context": index retries at the first turn. */
	needsContext = false;
	/** The run cap was acted on in this session. */
	private capped = false;

	constructor(d: ExecDeps) {
		this.d = d;
	}

	private async request(event: string, payload: object, timeoutMs: number): Promise<Answer> {
		const c = emitClaims((data) => this.d.emit(event, data), payload, timeoutMs);
		if (!c.claimed) return { error: "relay is not loaded" };
		const a = (await c.answer) as Answer | null;
		return a && typeof a === "object" ? a : { error: "relay gave no answer" };
	}

	private mine(data: unknown): { run: Run; tag: { run: string; package: string } } | undefined {
		const run = this.d.read();
		const tag = tagOf((data as { tag?: unknown } | null)?.tag);
		if (!run || run.state === "ended" || !tag || tag.run !== run.id) return undefined;
		return { run, tag };
	}

	private say(text: string): void {
		try {
			this.d.tell(text);
		} catch {
			// display only
		}
	}

	async query(ids: string[]): Promise<{ jobs: JobInfo[] } | { error: string }> {
		const a = await this.request("relay:job-query", { v: 1, ids }, this.d.timeoutMs ?? 30_000);
		if (typeof a.error === "string") {
			if (/no session context/i.test(a.error)) this.needsContext = true;
			return { error: a.error };
		}
		const jobs = Array.isArray(a.jobs) ? (a.jobs as JobInfo[]).filter((j) => j && typeof j.id === "string") : [];
		return { jobs: jobs.map((j) => ({ ...j, repos: asRepos(j.repos) })) };
	}

	/** Dispatches every planned package whose dependencies are merged, in proposal order. */
	async dispatchReady(): Promise<void> {
		const run = this.d.read();
		if (!run || run.state === "ended" || sumTokens(run) >= this.d.runTokens()) return;
		for (const id of readyToSpawn(run)) {
			if (this.dispatching.has(id)) continue;
			this.dispatching.add(id);
			try {
				const now = this.d.read();
				const sub = now?.subs.find((s) => s.id === id);
				if (!now || !sub || sub.state !== "planned") continue;
				const brief = renderRelayBrief(sub, now);
				const problems = checkRelayBrief(brief, [...relayNames(now).values()]);
				if (problems.length) {
					await this.fail(id, `the brief is incomplete: ${problems.join("; ")}`);
					continue;
				}
				try {
					fs.mkdirSync(`${this.d.dir}/${id}`, { recursive: true });
					fs.writeFileSync(`${this.d.dir}/${id}/brief.md`, brief);
				} catch {
					// the brief goes to relay anyway
				}
				const a = await this.request("relay:dispatch", { v: 1, brief, tag: { run: now.id, package: id } }, this.d.timeoutMs ?? 120_000);
				if (typeof a.error === "string" || typeof a.id !== "string") {
					const why = typeof a.error === "string" ? a.error : "relay answered without a job id";
					if (/no session context/i.test(why)) {
						this.needsContext = true;
						continue;
					}
					await this.fail(id, `dispatch refused: ${why}`);
					continue;
				}
				const job = a.id;
				await this.d.mutate((r) => {
					const s = r.subs.find((x) => x.id === id);
					if (!s || s.state !== "planned") return;
					s.state = "dispatched";
					s.job = job;
					s.tokens = 0;
				});
				this.d.changed?.();
			} finally {
				this.dispatching.delete(id);
			}
		}
	}

	/** Fails a package (dependents blocked) and tells the user. */
	private async fail(id: string, reason: string): Promise<void> {
		const blocked = await this.d.mutate((r) => {
			const s = r.subs.find((x) => x.id === id);
			if (!s || s.state === "failed" || s.state === "merged") return undefined;
			return failIn(r, id, reason);
		});
		if (blocked === undefined) return;
		this.say(`package ${id} failed: ${reason}${blocked.length ? `\nBlocked: ${blocked.join(", ")}` : ""}`);
		this.d.changed?.();
	}

	/** A job ended (job-end, or a job-query that shows it finished). Ignored unless the package is dispatched with that job. */
	private async finish(id: string, job: string, how: string, end: { repos?: JobRepo[]; reason?: string; report?: string; tokens?: number }): Promise<void> {
		const out = await this.d.mutate((r) => {
			const s = r.subs.find((x) => x.id === id);
			if (!s || s.state !== "dispatched" || s.job !== job) return undefined;
			if (end.tokens !== undefined) s.tokens = end.tokens;
			if (end.report) s.report = end.report;
			if (end.repos) s.prs = end.repos;
			if (how === "delivered" || how === "done") {
				if (!end.repos?.length || end.repos.every((x) => x.merged)) {
					s.state = "merged";
					delete s.reason;
					return { kind: "merged" as const };
				}
				s.state = "delivered-pr";
				s.reason = `PR not merged: ${prList(end.repos)}`;
				return { kind: "held" as const, holds: dependentsOf(r, id).filter((d) => r.subs.find((x) => x.id === d)?.state === "planned") };
			}
			const reason = end.reason?.trim() || `job ${how === "unknown" ? "not found" : how}`;
			if (how !== "unknown" && retryAllowed(s, end.reason)) {
				s.state = "retry-pending";
				s.reason = reason;
				return { kind: "retry" as const };
			}
			const after = (s.retries ?? 0) > 0 ? " (after its retry)" : "";
			return { kind: "failed" as const, reason: reason + after, blocked: failIn(r, id, reason + after), own: s.stoppedBy === "orchestrator" };
		});
		if (!out) return;
		this.d.changed?.();
		if (out.kind === "merged") await this.dispatchReady();
		else if (out.kind === "held") {
			const s = this.d.read()?.subs.find((x) => x.id === id);
			this.say(`package ${id} was delivered, but its PR is not merged: ${prList(s?.prs)}.${out.holds.length ? ` It holds ${out.holds.join(", ")}.` : ""} Merge it by hand; the poll notices the merge (relay's scan sees a hand merge within about 10 minutes) and releases the dependents.`);
		} else if (out.kind === "retry") await this.retry(id);
		else if (!out.own) this.say(`package ${id} failed: ${out.reason}${out.blocked.length ? `\nBlocked: ${out.blocked.join(", ")}` : ""}`);
		await this.settle();
	}

	/** Sends the one follow-up of a retry-pending package once relay shows its job finished. */
	async retry(id: string, known?: JobInfo): Promise<void> {
		const sub = this.d.read()?.subs.find((s) => s.id === id);
		if (!sub || sub.state !== "retry-pending" || !sub.job) return;
		let info = known;
		if (!info) {
			const q = await this.query([sub.job]);
			if ("error" in q) return;
			info = q.jobs.find((j) => j.id === sub.job);
		}
		if (!info || info.state === "unknown") return this.fail(id, "job not found");
		if (!FINISHED.includes(info.state)) return;
		const a = await this.request("relay:control", { v: 1, job: sub.job, action: "followup", text: retryText(sub) }, this.d.timeoutMs ?? 60_000);
		if (typeof a.error === "string") {
			if (/still finishing/i.test(a.error)) return;
			if (/no session context/i.test(a.error)) {
				this.needsContext = true;
				return;
			}
			await this.fail(id, `the retry could not start: ${a.error}`);
			return this.settle();
		}
		await this.d.mutate((r) => {
			const s = r.subs.find((x) => x.id === id);
			if (!s || s.state !== "retry-pending") return;
			s.state = "dispatched";
			s.retries = (s.retries ?? 0) + 1;
		});
		this.d.changed?.();
	}

	/** `relay:job-end` */
	async onJobEnd(data: unknown): Promise<void> {
		const m = this.mine(data);
		if (!m) return;
		const e = data as { job?: unknown; how?: unknown; report?: unknown; used?: unknown; repos?: unknown; reason?: unknown };
		if (typeof e.job !== "string" || typeof e.how !== "string") return;
		await this.finish(m.tag.package, e.job, e.how, { repos: asRepos(e.repos), reason: typeof e.reason === "string" ? e.reason : undefined, report: typeof e.report === "string" ? e.report : undefined, tokens: tokensOf(e.used) });
	}

	/** `relay:job-progress`: the job's latest tokens, then the run cap. */
	async onProgress(data: unknown): Promise<void> {
		const m = this.mine(data);
		if (!m) return;
		const e = data as { job?: unknown; used?: unknown };
		const t = tokensOf(e.used);
		if (typeof e.job !== "string" || t === undefined) return;
		const changed = await this.d.mutate((r) => {
			const s = r.subs.find((x) => x.id === m.tag.package);
			if (!s || s.job !== e.job || s.tokens === t) return false;
			s.tokens = t;
			return true;
		});
		if (changed) await this.checkCap();
	}

	/** `relay:approval`: appended to approvals.jsonl. */
	onApproval(data: unknown): void {
		const m = this.mine(data);
		if (!m) return;
		const e = data as Record<string, unknown>;
		const str = (k: string) => (typeof e[k] === "string" ? (e[k] as string) : "");
		const line: ApprovalLine = { at: new Date().toISOString(), job: str("job"), package: m.tag.package, category: str("category"), item: str("item"), by: str("by"), reason: str("reason") };
		try {
			fs.mkdirSync(this.d.dir, { recursive: true });
			fs.appendFileSync(approvalsFile(this.d.dir), `${JSON.stringify(line)}\n`);
		} catch {
			// best effort
		}
	}

	/** The model stops a job (relay_stop) or the orchestrator does: marked before the stop, so the job is not retried. */
	async markOwnStop(job: string): Promise<boolean> {
		return this.d.mutate((r) => {
			const s = r.subs.find((x) => x.job === job);
			if (!s) return false;
			s.stoppedBy = "orchestrator";
			return true;
		}).catch(() => false);
	}

	/** Stops every unfinished job of the run (`stoppedBy: "orchestrator"` first). Returns the errors. */
	async stopAll(reason: string): Promise<string[]> {
		const run = this.d.read();
		if (!run) return [];
		const errors: string[] = [];
		const live = run.subs.filter((s) => s.job && UNFINISHED_PKG.includes(s.state));
		await this.d.mutate((r) => {
			for (const s of r.subs) {
				if (!s.job || !UNFINISHED_PKG.includes(s.state)) continue;
				s.stoppedBy = "orchestrator";
				if (s.state === "retry-pending") failIn(r, s.id, reason);
			}
		});
		for (const s of live) {
			if (s.state !== "dispatched") continue;
			const a = await this.request("relay:control", { v: 1, job: s.job, action: "stop" }, this.d.timeoutMs ?? 60_000);
			if (typeof a.error === "string") errors.push(`${s.id} (${s.job}): ${a.error}`);
		}
		this.d.changed?.();
		return errors;
	}

	/** At the run cap: stops every unfinished job, blocks what was not dispatched and tells the user. Soft by up to one poll. */
	async checkCap(): Promise<void> {
		const run = this.d.read();
		if (!run || run.state === "ended") return;
		const sum = sumTokens(run);
		const cap = this.d.runTokens();
		// once capped (in memory, or every unfinished job already stopped by the orchestrator) nothing is stopped or told again
		if (sum < cap || this.capped || !run.subs.some((s) => s.state === "planned" || (UNFINISHED_PKG.includes(s.state) && s.stoppedBy !== "orchestrator"))) return;
		this.capped = true;
		const blocked = await this.d.mutate((r) => {
			const out: string[] = [];
			for (const s of r.subs) if (s.state === "planned") {
				s.state = "blocked";
				s.reason = "run cap";
				out.push(s.id);
			}
			return out;
		});
		const stopped = run.subs.filter((s) => UNFINISHED_PKG.includes(s.state)).map((s) => s.id);
		const errors = await this.stopAll("run cap");
		this.say(`run cap reached: ${sum.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")} weighted tokens. Stopped: ${stopped.join(", ") || "none"}; blocked: ${blocked.join(", ") || "none"}.${errors.length ? ` Stop errors: ${errors.join("; ")}` : ""}`);
		await this.settle();
	}

	/** The poll (every pollSeconds) and the restart rebuild: job states, tokens, PR holds, retries, dispatch, cap, report. */
	async tick(): Promise<void> {
		const run = this.d.read();
		if (!run || run.state === "ended") return;
		const live = run.subs.filter((s) => s.job && (UNFINISHED_PKG.includes(s.state) || s.state === "delivered-pr"));
		if (live.length) {
			const q = await this.query(live.map((s) => s.job as string));
			if ("error" in q) return;
			this.needsContext = false;
			const byJob = new Map(q.jobs.map((j) => [j.id, j]));
			await this.d.mutate((r) => {
				for (const s of r.subs) {
					const j = s.job ? byJob.get(s.job) : undefined;
					const t = tokensOf(j?.used);
					if (j && t !== undefined && s.state === "dispatched") s.tokens = t;
					if (j?.repos && s.state === "delivered-pr") s.prs = j.repos;
				}
			});
			for (const s of live) {
				const j = byJob.get(s.job as string);
				if (!j) continue;
				if (s.state === "dispatched") {
					if (j.state === "unknown") await this.finish(s.id, j.id, "unknown", {});
					else if (FINISHED.includes(j.state)) await this.finish(s.id, j.id, j.state === "done" ? "delivered" : j.state, { repos: j.repos, reason: j.reason, report: j.report, tokens: tokensOf(j.used) });
				} else if (s.state === "delivered-pr" && j.repos?.length && j.repos.every((x) => x.merged)) {
					const released = await this.d.mutate((r) => {
						const x = r.subs.find((y) => y.id === s.id);
						if (!x || x.state !== "delivered-pr") return false;
						x.state = "merged";
						delete x.reason;
						return true;
					});
					if (released) {
						this.say(`package ${s.id}: its PR was merged; its dependents are released`);
						this.d.changed?.();
					}
				} else if (s.state === "retry-pending") await this.retry(s.id, j);
			}
		}
		await this.dispatchReady();
		await this.checkCap();
		await this.settle();
	}

	/** When nothing can move: writes the report (shown when it changed) and, with no PR hold left, ends the run. */
	async settle(): Promise<void> {
		const run = this.d.read();
		if (!run || run.state === "ended" || canMove(run) || this.dispatching.size) return;
		let findings = "";
		try {
			findings = fs.readFileSync(findingsFile(this.d.dir), "utf8");
		} catch {
			// none
		}
		const report = buildReport(run, readApprovals(this.d.dir), findings, this.d.runTokens());
		let old = "";
		try {
			old = fs.readFileSync(reportFile(this.d.dir), "utf8");
		} catch {
			// first report
		}
		const holds = run.subs.some((s) => s.state === "delivered-pr");
		if (report !== old) {
			fs.writeFileSync(reportFile(this.d.dir), report);
			this.say(`run report (${reportFile(this.d.dir)})${holds ? "; the run stays active while a PR waits for a hand merge" : ""}:\n\n${report}`);
		}
		if (holds) return;
		const ended = await this.d.mutate((r) => {
			if (r.state === "ended") return false;
			r.state = "ended";
			return true;
		});
		if (ended) this.d.ended();
	}

	/** A status table for orch_status. */
	table(run: Run): string {
		const rows = run.subs.map((s) => `${s.id.padEnd(16)} ${s.state.padEnd(14)} ${(s.job ?? "-").padEnd(10)} ${String(s.tokens ?? 0).padStart(10)} tok${s.retries ? ` retry ${s.retries}` : ""}${s.reason ? `  ${s.reason}` : ""}`);
		return `Run ${run.id} (${run.title}), relay jobs; ${sumTokens(run).toLocaleString("en-US")} of ${this.d.runTokens().toLocaleString("en-US")} weighted tokens\n${rows.join("\n")}`;
	}
}
