/**
 * Trust for spawned worktrees: pi asks `project_trust` before it loads a project's `.pi`. A worktree that an
 * orchestrated run just created, in a run whose origin was trusted, is trusted without a prompt.
 *
 * The evidence is the per-user registry (`<agent dir>/orchestrate-spawned.json`), which only `orch_spawn` writes. A repository
 * can ship any `run.json`, so `run.json` is only a second check and never enough alone.
 */

import type { Run, Sub } from "./brief.ts";
import { SPAWNING_MAX_MS } from "./brief.ts";
import { norm, sameDir, type SpawnEntry } from "./store.ts";

export type TrustStep = "yes" | "poll" | "undecided";

const TRUSTED_STATES: Sub["state"][] = ["spawned", "planning", "executing", "awaiting-acceptance"];

/** Whether `cwd` is `top` or lies inside it. */
function insideOrSame(cwd: string, top: string): boolean {
	if (sameDir(cwd, top)) return true;
	const lower = process.platform === "win32";
	const c = lower ? `${norm(cwd)}/`.toLowerCase() : `${norm(cwd)}/`;
	const t = lower ? `${norm(top)}/`.toLowerCase() : `${norm(top)}/`;
	return c.startsWith(t);
}

/** One look at the registry and the runs of `common`. `yes`: `top` is a registered worktree of a trusted-origin run (and run.json agrees); `poll`: not yet, but such a spawn is under way. */
export function trustStep(o: { cwd: string; top: string; common: string }, spawned: SpawnEntry[], runs: Run[], now: number): TrustStep {
	let polling = false;
	for (const e of spawned) {
		if (!sameDir(e.common, o.common)) continue;
		if (e.state === "spawned") {
			if (!e.tops.some((t) => sameDir(t, o.top)) || !insideOrSame(o.cwd, o.top)) continue;
			const run = runs.find((r) => r.id === e.runId);
			const sub = run?.subs.find((s) => s.id === e.sub);
			if (run && run.originTrusted === true && sub && TRUSTED_STATES.includes(sub.state)) return "yes";
		} else {
			const at = Date.parse(e.at);
			if (Number.isFinite(at) && now - at < SPAWNING_MAX_MS) polling = true;
		}
	}
	return polling ? "poll" : "undecided";
}

export const TRUST_POLL_MS = 500;
export const TRUST_MAX_MS = 15_000;

export interface TrustDeps {
	/** `{ common, top }` of the repo at `cwd`, or null (no repo, error, timeout). */
	locate: (cwd: string) => Promise<{ common: string; top: string } | null>;
	listRuns: (common: string) => Run[];
	/** The per-user registry of spawned worktrees. */
	listSpawned: () => SpawnEntry[];
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

/** The decision for a worktree: re-reads the registry every 500 ms while a spawn is under way, for at most 15 s. */
export async function decideTrust(deps: TrustDeps, cwd: string): Promise<"yes" | "undecided"> {
	const where = await deps.locate(cwd);
	if (!where) return "undecided";
	const start = deps.now();
	for (;;) {
		let step: TrustStep;
		try {
			step = trustStep({ cwd, ...where }, deps.listSpawned(), deps.listRuns(where.common), deps.now());
		} catch {
			return "undecided";
		}
		if (step !== "poll") return step === "yes" ? "yes" : "undecided";
		if (deps.now() - start + TRUST_POLL_MS > TRUST_MAX_MS) return "undecided";
		await deps.sleep(TRUST_POLL_MS);
	}
}
