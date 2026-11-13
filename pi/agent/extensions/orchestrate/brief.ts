/** Work packages: validation, waves, ids, brief and kickoff text. Pure. */

import { canonical, split, type Repo, type Worktree } from "./repos.ts";

export type SubState = "planned" | "spawning" | "spawned" | "planning" | "executing" | "awaiting-acceptance" | "merged" | "stopped";

export interface Sub {
	id: string;
	goal: string;
	criteria: string[];
	owns: string[];
	forbids: string[];
	dependsOn: string[];
	decisions: string[];
	notes?: string;
	name: string;
	branch?: string;
	/** The worktree of the working repo (a sub-session finds itself by it). */
	cwd?: string;
	base?: string;
	/** Multi-repo runs: the repo keys this package works in, and its worktree in each (the working one included). */
	repos?: string[];
	worktrees?: Worktree[];
	/** When its flow last ended (the time of its latest flow-ended message); the merge is then confirmed against the delivered trees. */
	endedAt?: string;
	/** How the flow ended (K14); "unknown" for a sub that ended before the upgrade. Only "finished" merges on its own. */
	endHow?: "finished" | "stopped" | "abandoned" | "unknown";
	/** Automatic checks done since the flow ended (capped at 2). */
	endChecks?: number;
	/** Whether the "not confirmed merged" report was sent for this end. */
	endReported?: boolean;
	/** Merged by `/orch merged --force`, without a positive check. */
	forced?: boolean;
	/** What the check said when it was forced. */
	forcedCheck?: string;
	/** Set while orch_spawn creates the worktree (state "spawning"); the trust handler waits for it. */
	spawningAt?: string;
	state: SubState;
}

export interface Run {
	v: 1;
	id: string;
	title: string;
	created: string;
	owner: { pid: number; host: string; session: string };
	state: "active" | "ended";
	/** Whether the project was trusted when the run started; only then are spawned worktrees trusted automatically. */
	originTrusted?: boolean;
	/** Multi-repo runs: the working repo first. Absent in a single-repo run (working key ""). */
	repos?: Repo[];
	/** The remote ref the packages' PRs go into, per repo key ("" in a single-repo run); drift and overlap are measured from the merge base with it. Absent in older runs. */
	targets?: Record<string, string>;
	subs: Sub[];
}

/** The input of one package, before names and states are assigned. */
export type PackageInput = Pick<Sub, "id" | "goal"> & Partial<Pick<Sub, "criteria" | "owns" | "forbids" | "dependsOn" | "decisions" | "notes">> & { repos?: string[] };

export const SUB_ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
/** Copy of BRANCH_RE in worktree/layout.ts:7 (orchestrate never imports worktree). */
export const SET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ACTIVE: SubState[] = ["spawning", "spawned", "planning", "executing", "awaiting-acceptance"];

/** Canonicalises owns and forbids against the run's repos (`key:glob`; a bare glob is the working repo) and checks the extra repos. Returns the canonical packages and the key errors. */
export function canonicalPackages(pkgs: PackageInput[], repos: Repo[]): { packages: PackageInput[]; errors: string[] } {
	const errors: string[] = [];
	const workingKey = repos[0]?.key ?? "";
	const conv = (p: PackageInput, globs: string[] | undefined): string[] | undefined =>
		globs?.map((g) => {
			const c = canonical(g, repos, workingKey);
			if ("error" in c) {
				errors.push(`${p.id}: ${c.error}`);
				return g;
			}
			return c.value;
		});
	const packages = pkgs.map((p) => {
		const extra = (p.repos ?? []).map((k) => k.toLowerCase());
		for (const k of extra) if (!repos.some((r) => r.key === k)) errors.push(`${p.id}: unknown repo "${k}" in repos (have: ${repos.map((r) => r.key).join(", ")})`);
		return { ...p, owns: conv(p, p.owns), forbids: conv(p, p.forbids), repos: p.repos ? extra : undefined };
	});
	return { packages, errors };
}

/** Errors in the packages. With `repos` (a multi-repo run) globs are canonicalised first; the duplicate-owner check then runs on the canonical form. */
export function validatePackages(pkgs: PackageInput[], repos?: Repo[]): string[] {
	const errors: string[] = [];
	if (repos?.length) {
		const c = canonicalPackages(pkgs, repos);
		errors.push(...c.errors);
		pkgs = c.packages;
	}
	if (pkgs.length < 2) errors.push("a run needs at least 2 packages");
	const ids = new Set<string>();
	for (const p of pkgs) {
		if (!SUB_ID_RE.test(p.id)) errors.push(`bad id "${p.id}": use a-z, 0-9, - (max 16)`);
		if (ids.has(p.id)) errors.push(`duplicate id "${p.id}"`);
		ids.add(p.id);
		if (!p.goal?.trim()) errors.push(`${p.id}: goal is empty`);
		if (!p.owns?.length) errors.push(`${p.id}: owns is empty`);
	}
	for (const p of pkgs) for (const d of p.dependsOn ?? []) if (!ids.has(d)) errors.push(`${p.id}: unknown dependency "${d}"`);
	const owner = new Map<string, string>();
	for (const p of pkgs) {
		for (const g of p.owns ?? []) {
			const key = g.replace(/[\\]/g, "/").toLowerCase();
			const other = owner.get(key);
			if (other && other !== p.id) errors.push(`${p.id} and ${other} both own "${g}"`);
			owner.set(key, p.id);
		}
	}
	if (hasCycle(pkgs)) errors.push("dependsOn has a cycle");
	return errors;
}

function hasCycle(pkgs: PackageInput[]): boolean {
	const deps = new Map(pkgs.map((p) => [p.id, p.dependsOn ?? []]));
	const state = new Map<string, 1 | 2>();
	const visit = (id: string): boolean => {
		if (state.get(id) === 2) return false;
		if (state.get(id) === 1) return true;
		state.set(id, 1);
		for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) return true;
		state.set(id, 2);
		return false;
	};
	return [...deps.keys()].some(visit);
}

/** Ids still `planned` whose dependencies are all merged. */
export function readyToSpawn(run: Run): string[] {
	const merged = new Set(run.subs.filter((s) => s.state === "merged").map((s) => s.id));
	return run.subs.filter((s) => s.state === "planned" && s.dependsOn.every((d) => merged.has(d))).map((s) => s.id);
}

/** How long a sub may stay `spawning` before it counts as stale (ms). */
export const SPAWNING_MAX_MS = 3 * 60_000;

/** Subs stuck in `spawning`: no `spawningAt`, older than 3 min, or an owner that is dead. Pure. */
export function staleSpawning(run: Run, now: number, ownerAlive: boolean): string[] {
	return run.subs
		.filter((s) => {
			if (s.state !== "spawning") return false;
			const at = s.spawningAt ? Date.parse(s.spawningAt) : NaN;
			return !Number.isFinite(at) || now - at > SPAWNING_MAX_MS || !ownerAlive;
		})
		.map((s) => s.id);
}

/** Puts a sub that did not get its worktree back to `planned`. */
export function revertSpawning(sub: Sub): void {
	if (sub.state === "spawning") sub.state = "planned";
	delete sub.spawningAt;
}

export function activeCount(run: Run): number {
	return run.subs.filter((s) => ACTIVE.includes(s.state)).length;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `o` + MMDDHHmm of the local time. */
export function runStamp(now: Date): string {
	return `o${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** `o<MMDDHHmm>-<title slug>`, at most 30 characters. `existing` run ids: the minute moves on until no run has the same stamp (set names carry only the stamp). */
export function makeRunId(title: string, now: Date, existing: string[] = []): string {
	let when = now;
	let stamp = runStamp(when);
	while (existing.some((e) => e === stamp || e.startsWith(`${stamp}-`))) {
		when = new Date(when.getTime() + 60_000);
		stamp = runStamp(when);
	}
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const room = 30 - stamp.length - 1;
	const cut = slug.slice(0, room).replace(/-+$/, "");
	return cut ? `${stamp}-${cut}` : stamp;
}

/** The wt set name `<o+stamp>-<sub>`; null when it breaks the name rule. */
export function setName(runId: string, subId: string): string | null {
	const name = `${runId.split("-")[0]}-${subId}`;
	return SET_NAME_RE.test(name) && !name.endsWith(".") && !name.includes("..") ? name : null;
}

/** The repo key of a canonical glob; "" when bare. */
export const keyOf = (g: string): string => split(g).key;

const list = (items: string[], empty: string) => (items.length ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`);

export function renderBrief(sub: Sub, run: Run): string {
	const others = run.subs.filter((s) => s.id !== sub.id);
	return [
		`# Package ${sub.id}: ${run.title}`,
		"",
		"## Goal",
		sub.goal,
		"",
		"## Acceptance criteria",
		list(sub.criteria, "(none given; the goal is the criterion)"),
		"",
		"## Paths you own",
		list(sub.owns, "none"),
		"",
		"## Paths you must not touch",
		list(sub.forbids, "none beyond the paths other packages own"),
		"",
		...(run.repos?.length
			? [
					"## Repos",
					run.repos.map((r) => `- ${r.key}: ${r.top}${sub.repos && !sub.repos.includes(r.key) ? " (not in your package)" : ""}`).join("\n"),
					"Paths above are written `repo:path`. These are the orchestrator's checkouts; your worktree of each repo is in your session's folders.",
					"",
				]
			: []),
		"## Decisions already made",
		list(sub.decisions, "none"),
		...(sub.notes ? ["", "## Notes", sub.notes] : []),
		"",
		"## Other packages",
		others.length
			? others.map((o) => `- ${o.id}: ${o.goal} (owns ${o.owns.join(", ")})${o.dependsOn.length ? `; depends on ${o.dependsOn.join(", ")}` : ""}`).join("\n")
			: "- none",
		"",
	].join("\n");
}

export function kickoffText(sub: Sub, run: Run, briefPath: string): string {
	return [
		`You are package "${sub.id}" of the orchestrated run "${run.title}". Read the brief at ${briefPath} first; it is the whole job.`,
		"",
		...(sub.worktrees?.length ? ["Your worktrees:", ...sub.worktrees.map((w) => `- ${w.key || "(working repo)"}: ${w.cwd}`), ""] : []),
		"Rules:",
		`- Stay inside your owned paths (${sub.owns.join(", ")}).`,
		`- Never touch: ${sub.forbids.length ? sub.forbids.join(", ") : "paths owned by other packages"}.`,
		"- Ask the orchestrator with the ask_orchestrator tool instead of guessing; it always answers. While you wait for an answer that was cancelled, continue with what is not blocked.",
		"- Deliver into the run's target branch. Plan every stage of your package in one flow; don't start a second flow unless the orchestrator tells you to resume a stopped one.",
		"- When the brief asks for a pull request per stage, merge each at that stage's `Deliver: merge` step; otherwise open one pull request and merge it at the end of the flow.",
		"- The merge attempt itself sends the acceptance request to the orchestrator: never ask for acceptance in a question. When the merge is refused for that, end your turn and retry after the verdict arrives.",
		"- To wait on another package's PR, CI or a release, call wait_for_user with kind \"external\" and a read-only check (for a PR: gh pr list --base <target> --head <branch> --state merged ...). It does not go to the user. If the orchestrator sends you a message while you wait, act on it, then wait again or move on.",
		"",
		`Goal: ${sub.goal}`,
	].join("\n");
}
