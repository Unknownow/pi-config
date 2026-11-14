/** Budgets: the lead's edit budget, a job's wall and token budget with its grace window, tool timeouts. Pure except `measureEdits`. */

import * as fs from "node:fs";
import * as path from "node:path";
import { type RelayConfig, toolTimeoutFor } from "./config.ts";
import type { Job } from "./job.ts";
import type { Run } from "./sh.ts";

export interface Measure {
	lines: number;
	/** Absolute paths of the files with uncommitted changes. */
	files: string[];
}

const countLines = (file: string): number => {
	try {
		const buf = fs.readFileSync(file);
		if (buf.includes(0)) return 1;
		return buf.toString("utf8").split("\n").length - (buf.length && buf[buf.length - 1] === 0x0a ? 1 : 0);
	} catch {
		return 0;
	}
};

/** Uncommitted changes across the given repos: `git diff --numstat HEAD` plus the line counts of untracked files. */
export async function measureEdits(run: Run, repoDirs: string[]): Promise<Measure> {
	let lines = 0;
	const files = new Set<string>();
	const tops = new Set<string>();
	for (const dir of repoDirs) {
		const top = await run("git", ["rev-parse", "--show-toplevel"], dir);
		if (top.code === 0 && top.stdout.trim()) tops.add(path.resolve(top.stdout.trim()));
	}
	for (const dir of tops) {
		const stat = await run("git", ["diff", "--numstat", "--no-renames", "-z", "HEAD"], dir);
		if (stat.code === 0) {
			for (const rec of stat.stdout.split("\0").filter(Boolean)) {
				const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec);
				if (!m) continue;
				lines += (m[1] === "-" ? 1 : Number(m[1])) + (m[2] === "-" ? 0 : Number(m[2]));
				files.add(path.resolve(dir, m[3]));
			}
		}
		const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], dir);
		if (untracked.code === 0) {
			for (const f of untracked.stdout.split("\0").filter(Boolean)) {
				lines += countLines(path.join(dir, f));
				files.add(path.resolve(dir, f));
			}
		}
	}
	return { lines, files: [...files] };
}

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Why an edit of `file` is refused, or undefined. At the line limit nothing more goes in; a file beyond the file limit is refused. */
export function editBudgetProblem(m: Measure, file: string | undefined, limits: { lines: number; files: number }): string | undefined {
	const tail = "write a brief and relay_dispatch it (your uncommitted edits move into the job)";
	if (m.lines >= limits.lines) return `edit budget reached (${m.lines} of ${limits.lines} lines uncommitted): ${tail}`;
	const known = file !== undefined && m.files.some((f) => same(f, file));
	if (file !== undefined && !known && m.files.length >= limits.files) return `edit budget reached (${m.files.length} of ${limits.files} files uncommitted): ${tail}`;
	return undefined;
}

export type BudgetState = { state: "ok" } | { state: "grace"; grace: NonNullable<Job["grace"]>; why: "wall" | "tokens" } | { state: "over"; why: string };

/**
 * Wall time and weighted tokens against the job's budget. When either runs out, one grace window opens
 * (graceMin minutes, or graceTokenShare of the token budget, whichever comes first). The caller stores `grace`.
 */
export function budgetState(job: Pick<Job, "budget" | "used" | "grace">, cfg: Pick<RelayConfig, "budget">, now: number): BudgetState {
	const wallOut = job.used.wallMs >= job.budget.wallMs;
	const tokOut = job.used.tokens >= job.budget.tokens;
	if (!wallOut && !tokOut) return { state: "ok" };
	const why: "wall" | "tokens" = wallOut ? "wall" : "tokens";
	const grace = job.grace ?? { startedAt: now, tokensAt: job.used.tokens };
	const graceMs = cfg.budget.graceMin * 60_000;
	const graceTokens = Math.round(job.budget.tokens * cfg.budget.graceTokenShare);
	if (now - grace.startedAt >= graceMs) return { state: "over", why: `grace of ${cfg.budget.graceMin} min is over (${why} budget)` };
	if (job.used.tokens - grace.tokensAt >= graceTokens) return { state: "over", why: `grace of ${graceTokens} tokens is used (${why} budget)` };
	return { state: "grace", grace, why };
}

/** The wall budget in ms for a job whose Verify or Design names a long tool: at least timeout x 2 + 60 min. Returns the raised value and a note, or undefined. */
export function longToolWall(cfg: RelayConfig, text: string, currentWallMs: number): { wallMs: number; note: string } | undefined {
	const minutes = toolTimeoutFor(cfg, text);
	if (minutes === undefined) return undefined;
	const wanted = (minutes * 2 + 60) * 60_000;
	if (wanted <= currentWallMs) return undefined;
	return { wallMs: wanted, note: `wall budget raised to ${Math.round(wanted / 60_000)} min: Verify or Design uses a tool with a ${minutes} min timeout` };
}

/** The timeout (ms) of a running tool: bash gets `bashTimeoutMin`, a configured pattern its own, anything else none (0). */
export function toolTimeoutMs(cfg: RelayConfig, tool: string, args: Record<string, unknown>): number {
	const text = `${tool} ${typeof args.command === "string" ? args.command : JSON.stringify(args)}`;
	const custom = toolTimeoutFor(cfg, text);
	if (custom !== undefined) return custom * 60_000;
	return tool === "bash" ? cfg.bashTimeoutMin * 60_000 : 0;
}
