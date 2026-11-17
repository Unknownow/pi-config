/**
 * Options for loading agents into another pi process (a worker): which tools to register, a cap on
 * advisor calls, and a file that collects the usage of every subagent run. Pure helpers plus one append.
 */

import * as fs from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";

/** Comma list: when set, only these agents tools are registered. */
export const TOOLS_ENV = "PI_AGENTS_TOOLS";
/** Number: the advisor refuses after this many calls in the process. */
export const ADVISOR_CAP_ENV = "PI_AGENTS_ADVISOR_CAP";
/** Path: every finished subagent run appends one JSON line `{ role, model, usage, weightedCost, ok, at }`. */
export const USAGE_FILE_ENV = "PI_AGENTS_USAGE_FILE";

/** Whether the tool `name` is registered, given the env value of PI_AGENTS_TOOLS (unset or blank = all). */
export function toolEnabled(name: string, raw: string | undefined): boolean {
	if (raw === undefined || !raw.trim()) return true;
	return raw
		.split(",")
		.map((s) => s.trim())
		.includes(name);
}

/** The advisor cap in the env value; undefined when unset or not a number >= 0. */
export function parseCap(raw: string | undefined): number | undefined {
	if (raw === undefined || !raw.trim()) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Counts advisor calls: `take()` returns the refusal once `cap` calls were made, else counts the call and returns undefined. */
export function advisorGate(cap: number | undefined): { take(): string | undefined; used(): number } {
	let used = 0;
	return {
		take() {
			if (cap !== undefined && used >= cap) return `advisor refused: this process may call the advisor ${cap} time${cap === 1 ? "" : "s"} (${ADVISOR_CAP_ENV}) and has used ${cap === 1 ? "it" : "them all"}. Decide yourself, or ask whoever gave you the task.`;
			used++;
			return undefined;
		},
		used: () => used,
	};
}

export interface UsageLine {
	role: string;
	model: string;
	usage: Usage;
	weightedCost: number;
	ok: boolean;
	/** ISO time the run finished. */
	at: string;
}

/** Appends one JSON line to `file`; nothing when `file` is unset. Errors are swallowed: usage records never fail a run. */
export function appendUsage(file: string | undefined, line: UsageLine): void {
	if (!file) return;
	try {
		fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		// a missing folder or a locked file must not fail the run
	}
}
