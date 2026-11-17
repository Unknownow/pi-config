/**
 * The job's token use from files: the worker's agents tools (explore, advisor, test_run) append one line per
 * subagent run to `<job dir>/agents-usage.jsonl` (agents `PI_AGENTS_USAGE_FILE`), and relay_critic saves each
 * draft round's cost as `critic/round-N.json`. Costs are agents `weightedCost` (weighted tokens × model multiplier).
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The worker's agents usage file, in the job dir. */
export const AGENTS_USAGE_FILE = "agents-usage.jsonl";
/** Advisor runs a job may make, across worker restarts and escalation. */
export const ADVISOR_CAP = 3;

const lineCost = (l: string): number => {
	try {
		const n = Number(JSON.parse(l)?.weightedCost);
		return Number.isFinite(n) && n > 0 ? n : 0;
	} catch {
		return 0; // a foreign or broken line costs nothing
	}
};

/** The cost of the complete lines after byte `offset`, and the offset after the last complete line (a line still being written waits). */
export function readNewUsage(file: string, offset: number): { cost: number; offset: number } {
	let fd: number;
	try {
		fd = fs.openSync(file, "r");
	} catch {
		return { cost: 0, offset };
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size <= offset) return { cost: 0, offset: Math.min(offset, size) };
		const buf = Buffer.alloc(size - offset);
		const n = fs.readSync(fd, buf, 0, buf.length, offset);
		const end = buf.subarray(0, n).lastIndexOf(0x0a);
		if (end < 0) return { cost: 0, offset };
		const cost = buf
			.subarray(0, end)
			.toString("utf8")
			.split("\n")
			.reduce((s, l) => s + (l.trim() ? lineCost(l) : 0), 0);
		return { cost, offset: offset + end + 1 };
	} finally {
		fs.closeSync(fd);
	}
}

/** Advisor runs recorded in the usage file, failed runs included. */
export function advisorRunsUsed(file: string): number {
	let text = "";
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return 0;
	}
	return text.split("\n").filter((l) => {
		try {
			return l.trim() && JSON.parse(l)?.role === "advisor";
		} catch {
			return false;
		}
	}).length;
}

/** The weightedCost of every relay_critic round saved in `criticDir` (`round-N.json`, and `failed-N.json` for tries that failed). */
export function draftCriticCost(criticDir: string): number {
	let names: string[] = [];
	try {
		names = fs.readdirSync(criticDir).filter((f) => /^(round|failed)-\d+\.json$/.test(f));
	} catch {
		return 0;
	}
	return names.reduce((s, f) => {
		try {
			const n = Number(JSON.parse(fs.readFileSync(path.join(criticDir, f), "utf8")).weightedCost);
			return s + (Number.isFinite(n) && n > 0 ? n : 0);
		} catch {
			return s;
		}
	}, 0);
}
