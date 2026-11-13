/** Pure helpers for the sub's plan-judge result (workflow K10 `judge`). No imports from `workflow/`. */

export interface PlanJudge {
	ran: boolean;
	verdict: "PASS" | "FAIL" | "cancelled" | "error";
	rounds: number;
	spec: "agreed" | "brief" | "none";
	findings: string[];
	userFindings: string[];
}

const VERDICTS = ["PASS", "FAIL", "cancelled", "error"];
const SPECS = ["agreed", "brief", "none"];
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Validates the K10 `judge` field; anything malformed gives undefined. */
export function parsePlanJudge(data: unknown): PlanJudge | undefined {
	const d = data as Partial<Record<keyof PlanJudge, unknown>> | null | undefined;
	if (!d || typeof d !== "object") return undefined;
	if (typeof d.ran !== "boolean" || typeof d.verdict !== "string" || !VERDICTS.includes(d.verdict)) return undefined;
	if (typeof d.rounds !== "number" || typeof d.spec !== "string" || !SPECS.includes(d.spec)) return undefined;
	if (!strings(d.findings) || !strings(d.userFindings)) return undefined;
	return { ran: d.ran, verdict: d.verdict as PlanJudge["verdict"], rounds: d.rounds, spec: d.spec as PlanJudge["spec"], findings: d.findings, userFindings: d.userFindings };
}

const isClean = (j: PlanJudge): boolean => j.ran && j.verdict === "PASS" && j.findings.length === 0 && j.userFindings.length === 0;

/** The one-line judge summary for the plan-review event; "" without a judge result. */
export function planReviewJudgeLine(j?: PlanJudge): string {
	if (!j) return "";
	if (!j.ran) return `judge: did not run (${j.verdict === "cancelled" ? "cancelled" : "error"})`;
	if (isClean(j)) return `judge: PASS (${j.rounds} runs)`;
	const open = j.findings.length + j.userFindings.length;
	return `judge: ${open} open findings (${j.userFindings.length} need a decision) after ${j.rounds} runs, see the plan file`;
}

/** The section appended to the plan file; "" when there is no result or it is clean. */
export function judgeSection(j?: PlanJudge): string {
	if (!j || isClean(j)) return "";
	const list = (xs: string[]) => xs.map((x) => `- ${x.replace(/\n/g, "\n  ")}`).join("\n");
	const parts: string[] = [];
	if (j.userFindings.length) parts.push(`Needs a decision:\n${list(j.userFindings)}`);
	if (j.findings.length) parts.push(`Open after the cap:\n${list(j.findings)}`);
	return `\n\n## Open judge findings\n\n${parts.length ? `${parts.join("\n\n")}\n\n` : ""}${planReviewJudgeLine(j)}\n`;
}

/** The phase as the board and table show it. */
export function phaseLabel(phase: string, judging?: string): string {
	return judging === "plan" || judging === "discussion" ? `${phase} (judging ${judging})` : phase;
}
