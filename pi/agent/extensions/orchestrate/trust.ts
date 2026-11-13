/**
 * Trust for spawned worktrees: pi asks `project_trust` before it loads a project's `.pi`. A worktree that an
 * orchestrated run just created, in a run whose origin was trusted, is trusted without a prompt. Pure logic here;
 * the handler in index.ts adds the git call.
 */

import type { Run, Sub } from "./brief.ts";
import { SPAWNING_MAX_MS } from "./brief.ts";
import { sameDir } from "./store.ts";

export type TrustStep = "yes" | "poll" | "undecided";

const TRUSTED_STATES: Sub["state"][] = ["spawned", "planning", "executing", "awaiting-acceptance"];

/** One look at the active runs. `yes`: `top` is a worktree of a sub of a trusted-origin run; `poll`: not yet, but such a run is creating one now. */
export function trustStep(top: string, runs: Run[], now: number): TrustStep {
	let polling = false;
	for (const run of runs) {
		if (run.originTrusted !== true) continue;
		for (const sub of run.subs) {
			const dirs = [sub.cwd, ...(sub.worktrees ?? []).map((w) => w.cwd)].filter((d): d is string => !!d);
			if (TRUSTED_STATES.includes(sub.state) && dirs.some((d) => sameDir(d, top))) return "yes";
			if (sub.state === "spawning") {
				const at = sub.spawningAt ? Date.parse(sub.spawningAt) : NaN;
				if (Number.isFinite(at) && now - at < SPAWNING_MAX_MS) polling = true;
			}
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
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}

/** The decision for a worktree: re-reads the runs every 500 ms while a spawn is under way, for at most 15 s. */
export async function decideTrust(deps: TrustDeps, cwd: string): Promise<"yes" | "undecided"> {
	const where = await deps.locate(cwd);
	if (!where) return "undecided";
	const start = deps.now();
	for (;;) {
		let step: TrustStep;
		try {
			step = trustStep(where.top, deps.listRuns(where.common), deps.now());
		} catch {
			return "undecided";
		}
		if (step !== "poll") return step === "yes" ? "yes" : "undecided";
		if (deps.now() - start + TRUST_POLL_MS > TRUST_MAX_MS) return "undecided";
		await deps.sleep(TRUST_POLL_MS);
	}
}
