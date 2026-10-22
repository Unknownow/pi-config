/** Pure helpers for the end-of-flow report card: the findings log and the card's lines. No runtime imports. */

export type FindingStatus = "open" | "fixed" | "noted";

/** A finding headline seen in a judge report; open is false once a later report of the same stage no longer lists it. */
export interface FlowFinding {
	line: string;
	stage?: number;
	open: boolean;
}

export interface ReportFinding {
	line: string;
	stage?: number;
	status: FindingStatus;
}

export interface ReportStep {
	id: string;
	text: string;
	done: boolean;
}

export interface ReportLine {
	text: string;
	tone: "head" | "done" | "open" | "fixed" | "noted" | "human";
}

const HEADLINE = /^\S.*\s-\s*(blocker|major|minor)\s*-/i;
const MAX_STORED = 50;
const MAX_SHOWN = 30;

function cut(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Adds the finding headlines of a judge report to the log: same-stage findings missing from it become closed. Returns a new array. */
export function recordFindings(list: FlowFinding[] | undefined, stage: number | undefined, report: string): FlowFinding[] {
	const headlines = report
		.split(/\r?\n/)
		.filter((l) => HEADLINE.test(l))
		.map((l) => l.trim());
	const out = (list ?? []).map((f) => (f.stage === stage ? { ...f, open: false } : { ...f }));
	for (const line of headlines) {
		const existing = out.find((f) => f.stage === stage && f.line === line);
		if (existing) existing.open = true;
		else out.push({ line, stage, open: true });
	}
	while (out.length > MAX_STORED) {
		const i = out.findIndex((f) => !f.open);
		out.splice(i >= 0 ? i : 0, 1);
	}
	return out;
}

/** Gives each logged finding its card status: closed is fixed, an open plan flaw already written into the plan is noted. */
export function reportFindings(list: FlowFinding[] | undefined, plan: string | undefined): ReportFinding[] {
	return (list ?? []).map((f) => {
		let status: FindingStatus = "open";
		if (!f.open) status = "fixed";
		else if (/\[plan-flaw\]/i.test(f.line) && plan?.includes(f.line)) status = "noted";
		return { line: f.line, stage: f.stage, status };
	});
}

/** The card's step and finding lines, without colours. */
export function reportLines(steps: ReportStep[] | undefined, findings: ReportFinding[] | undefined, human?: { id?: string; text: string }[]): ReportLine[] {
	const lines: ReportLine[] = [];
	if (steps?.length) {
		lines.push({ text: `Steps ${steps.filter((s) => s.done).length}/${steps.length} done`, tone: "head" });
		for (const s of steps) {
			const text = cut(s.text.split(/\r?\n/)[0] ?? "", 100);
			lines.push(s.done ? { text: `  ✓ ${s.id} ${text}`, tone: "done" } : { text: `  ○ ${s.id} ${text}`, tone: "open" });
		}
	}
	if (findings?.length) {
		const count = (st: FindingStatus) => findings.filter((f) => f.status === st).length;
		lines.push({ text: `Findings: ${count("open")} open · ${count("fixed")} fixed · ${count("noted")} noted`, tone: "head" });
		const ordered = (["open", "noted", "fixed"] as const).flatMap((st) => findings.filter((f) => f.status === st));
		for (const f of ordered.slice(0, MAX_SHOWN)) {
			const stage = f.stage !== undefined ? `[stage ${f.stage}] ` : "";
			lines.push({ text: `  ${f.status.padEnd(5)} ${stage}${cut(f.line, 120)}`, tone: f.status });
		}
		if (ordered.length > MAX_SHOWN) lines.push({ text: `  +${ordered.length - MAX_SHOWN} more`, tone: "fixed" });
	}
	if (human?.length) {
		lines.push({ text: `Human checks (after the flow): ${human.length}`, tone: "head" });
		for (const h of human.slice(0, MAX_SHOWN)) lines.push({ text: `  ☐ ${h.id ? `${h.id} ` : ""}${cut(h.text, 120)}`, tone: "human" });
		if (human.length > MAX_SHOWN) lines.push({ text: `  +${human.length - MAX_SHOWN} more`, tone: "fixed" });
	}
	return lines;
}
