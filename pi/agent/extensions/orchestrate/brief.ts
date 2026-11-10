/** Work packages: validation, waves, ids, brief and kickoff text. Pure. */

export type SubState = "planned" | "spawned" | "planning" | "executing" | "awaiting-acceptance" | "merged" | "stopped";

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
	cwd?: string;
	base?: string;
	state: SubState;
}

export interface Run {
	v: 1;
	id: string;
	title: string;
	created: string;
	owner: { pid: number; host: string; session: string };
	state: "active" | "ended";
	subs: Sub[];
}

/** The input of one package, before names and states are assigned. */
export type PackageInput = Pick<Sub, "id" | "goal"> & Partial<Pick<Sub, "criteria" | "owns" | "forbids" | "dependsOn" | "decisions" | "notes">>;

export const SUB_ID_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
/** Copy of BRANCH_RE in worktree/layout.ts:7 (orchestrate never imports worktree). */
export const SET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ACTIVE: SubState[] = ["spawned", "planning", "executing", "awaiting-acceptance"];

export function validatePackages(pkgs: PackageInput[], maxSubs: number): string[] {
	const errors: string[] = [];
	if (pkgs.length < 2) errors.push("a run needs at least 2 packages");
	if (pkgs.length > maxSubs) errors.push(`at most ${maxSubs} packages (maxSubs)`);
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

export function activeCount(run: Run): number {
	return run.subs.filter((s) => ACTIVE.includes(s.state)).length;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `o` + MMDDHHmm of the local time. */
export function runStamp(now: Date): string {
	return `o${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** `o<MMDDHHmm>-<title slug>`, at most 30 characters. */
export function makeRunId(title: string, now: Date): string {
	const stamp = runStamp(now);
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
		"Rules:",
		`- Stay inside your owned paths (${sub.owns.join(", ")}).`,
		`- Never touch: ${sub.forbids.length ? sub.forbids.join(", ") : "paths owned by other packages"}.`,
		"- Ask the orchestrator with the ask_orchestrator tool instead of guessing; if it does not answer, use wait_for_user.",
		"- Deliver with one pull request, merged at the end of your flow. The merge also needs the orchestrator's acceptance: when it is refused for that, end your turn and retry after the message arrives.",
		"",
		`Goal: ${sub.goal}`,
	].join("\n");
}
