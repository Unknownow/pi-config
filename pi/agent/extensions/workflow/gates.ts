/** Pure decisions of the automatic judge gates (the plan judge now, the discussion gate later). `index.ts` only runs judges, sends messages and keeps the runtime handle. */

import { createHash } from "node:crypto";
import { JUDGE_PLAN, JUDGE_PLAN_RECHECK, NO_SPEC_NOTE } from "./prompts.ts";

export type Severity = "blocker" | "major" | "minor";

/** One finding of a judge reply. `route`: "auto" can be fixed by the model alone, "user" needs a person's decision. */
export interface Finding {
	severity: Severity;
	category: string;
	route: "auto" | "user";
	/** The head line as written, without its leading "- ". */
	head: string;
	/** The `Why:` and `Fix:` lines that follow it. */
	body: string;
}

export type GateVerdict = "PASS" | "FAIL" | "cancelled" | "error";
export type SpecKind = "agreed" | "brief" | "none";

/** What the plan gate remembers about the plan it judged; persisted in the state entry. */
export interface PlanGate {
	planHash: string;
	/** Judge runs spent on this plan (confirm runs are not counted). */
	rounds: number;
	verdict?: GateVerdict;
	autoFindings: Finding[];
	userFindings: Finding[];
	/** The plan text the last run judged, for the next recheck's diff. */
	judgedPlan?: string;
	/** Set when a run ended at the cap: a changed plan then gets one confirm run, no fix loop. */
	cappedHash?: string;
	spec: SpecKind;
}

/** The optional `judge` field of K10 `workflow:plan-ready`. */
export interface K10Judge {
	ran: boolean;
	verdict: GateVerdict;
	rounds: number;
	spec: SpecKind;
	findings: string[];
	userFindings: string[];
}

const HEAD = /^-\s+(blocker|major|minor)\s+-\s+\[([^\]]+)\]/i;
const ROUTE = /\bfix:\s*(auto|user)\b/i;

/** The findings of a judge reply. A missing `fix:` tag means "user"; text outside finding blocks is ignored. */
export function parseFindings(text: string): Finding[] {
	const out: Finding[] = [];
	let cur: { f: Finding; body: string[] } | undefined;
	const flush = (): void => {
		if (cur) out.push({ ...cur.f, body: cur.body.join("\n") });
		cur = undefined;
	};
	for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
		const line = raw.trimEnd();
		const m = HEAD.exec(line.trimStart());
		if (m && !/^\s/.test(line)) {
			flush();
			const route = ROUTE.exec(line)?.[1].toLowerCase() === "auto" ? "auto" : "user";
			cur = { f: { severity: m[1].toLowerCase() as Severity, category: m[2].trim(), route, head: line.replace(/^-\s+/, ""), body: "" }, body: [] };
			continue;
		}
		if (/^\s*VERDICT:/i.test(line)) {
			flush();
			continue;
		}
		if (cur && (/^\s+\S/.test(line) || /^(Why|Fix):/i.test(line))) cur.body.push(line.trim());
		else flush();
	}
	flush();
	return out;
}

/** A clean result: PASS and nothing left to report. */
export function isClean(verdict: string | undefined, findings: Finding[]): boolean {
	return verdict === "PASS" && findings.length === 0;
}

/** A finding as one string: its head line plus its body. */
export function findingText(f: Finding): string {
	return f.body ? `${f.head}\n${f.body}` : f.head;
}

/** Hash of a text, ignoring CRLF and outer whitespace. */
export function textHash(s: string): string {
	return createHash("sha1").update(s.replace(/\r\n/g, "\n").trim()).digest("hex");
}

/** A line diff of `prev` against `next` with 2 lines of context (`+`, `-`, ` ` prefixes, `@@` between hunks). "" when equal; null when too big (cells over 4M or output over `cap` lines). */
export function planTextDiff(prev: string, next: string, cap = 400): string | null {
	const a = prev.replace(/\r\n/g, "\n").split("\n");
	const b = next.replace(/\r\n/g, "\n").split("\n");
	if (a.length * b.length > 4_000_000) return null;
	const w = b.length + 1;
	const t = new Uint32Array((a.length + 1) * w);
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
	const ops: { k: " " | "+" | "-"; s: string }[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ k: " ", s: a[i++] }), j++;
		else if (j < b.length && (i >= a.length || t[i * w + j + 1] >= t[(i + 1) * w + j])) ops.push({ k: "+", s: b[j++] });
		else ops.push({ k: "-", s: a[i++] });
	}
	if (!ops.some((o) => o.k !== " ")) return "";
	const keep = ops.map(() => false);
	ops.forEach((o, n) => {
		if (o.k === " ") return;
		for (let d = -2; d <= 2; d++) if (n + d >= 0 && n + d < ops.length) keep[n + d] = true;
	});
	const out: string[] = [];
	let gap = false;
	ops.forEach((o, n) => {
		if (!keep[n]) {
			gap = out.length > 0;
			return;
		}
		if (gap) out.push("@@");
		gap = false;
		out.push(`${o.k}${o.s}`);
	});
	return out.length > cap ? null : out.join("\n");
}

/** The planner's `Disputes:` block: from its line up to the first `## Plan` heading (or the end). */
export function planDisputes(reply: string): string | undefined {
	const m = /^[ \t]*Disputes:/im.exec(reply);
	if (!m) return undefined;
	const rest = reply.slice(m.index);
	const end = rest.search(/^##\s*Plan/m);
	const text = (end >= 0 ? rest.slice(0, end) : rest).trim();
	return text || undefined;
}

/** A bare Escape key press, in the legacy and the kitty encodings. */
export function isEscKey(data: string): boolean {
	return data === "\x1b" || data === "\x1b[27u";
}

/** What to do with a complete plan: skip the gate, reuse a verdict, or run the judge (confirm: one run, no fix loop). */
export function planGateDecide(o: { mode: "off" | "auto"; quick: boolean; planHash: string; gate?: PlanGate }): "off" | "reuse" | "confirm" | "recheck" | "full" {
	if (o.mode === "off" || o.quick) return "off";
	const g = o.gate;
	if (g && g.planHash === o.planHash && (g.verdict === "PASS" || g.verdict === "FAIL")) return "reuse";
	if (g?.cappedHash && g.cappedHash !== o.planHash) return "confirm";
	if (g?.judgedPlan) return "recheck";
	return "full";
}

/** After a plan-judge run (`rounds` already counts it): send the auto findings to the planner, or offer the plan. User findings are never sent. */
export function planGateAfterVerdict(o: { verdict: string; findings: Finding[]; rounds: number; max: number; confirm: boolean }): { action: "offer" | "fix"; auto: Finding[]; user: Finding[]; capped: boolean } {
	const auto = o.findings.filter((f) => f.route === "auto");
	const user = o.findings.filter((f) => f.route !== "auto");
	if (isClean(o.verdict, o.findings)) return { action: "offer", auto, user, capped: false };
	const capped = o.rounds >= o.max;
	return { action: !o.confirm && auto.length > 0 && !capped ? "fix" : "offer", auto, user, capped };
}

/** A "go" typed while the gate ran: approve only after a clean PASS, otherwise show the menu. */
export function planOfferAction(o: { clean: boolean; queuedGo: boolean }): "approve" | "offer" {
	return o.clean && o.queuedGo ? "approve" : "offer";
}

/** The K10 `judge` field from the gate's state; `ran` is false when the judge was cancelled or failed. */
export function planReadyJudge(gate: PlanGate, ran: boolean): K10Judge {
	return { ran, verdict: gate.verdict ?? (ran ? "FAIL" : "error"), rounds: gate.rounds, spec: gate.spec, findings: gate.autoFindings.map(findingText), userFindings: gate.userFindings.map(findingText) };
}

/** A new flow, or a replan, starts clean ("enter-plan"); an orchestrator rejection keeps what the judge knows but gives a fresh budget. */
export function planGateReset(gate: PlanGate | undefined, why: "enter-plan" | "rejected"): PlanGate | undefined {
	if (why === "enter-plan" || !gate) return undefined;
	return { ...gate, rounds: 0, cappedHash: undefined };
}

/** Lines the approval menu shows above the plan. */
export function menuJudgeLines(gate: PlanGate | undefined, note?: string): string[] {
	const out: string[] = [];
	if (note) out.push(note);
	if (!gate) return out;
	const open = gate.autoFindings.length + gate.userFindings.length;
	if (gate.verdict === "PASS" && !open) out.push(`Plan judge: PASS (${gate.rounds} run${gate.rounds === 1 ? "" : "s"})`);
	else if (gate.verdict === "PASS" || gate.verdict === "FAIL") {
		if (gate.autoFindings.length) out.push(`Plan judge: ${gate.autoFindings.length} open finding${gate.autoFindings.length === 1 ? "" : "s"}${gate.cappedHash !== undefined ? " after the cap" : ""}`, ...gate.autoFindings.map((f) => `- ${f.head}`));
		if (gate.userFindings.length) out.push("Needs your decision:", ...gate.userFindings.map((f) => `- ${f.head}`));
	}
	if (gate.spec === "none") out.push("spec: none");
	return out;
}

function findingsBlock(fs: Finding[]): string {
	return fs.length ? fs.map((f) => `- ${findingText(f).replace(/\n/g, "\n  ")}`).join("\n") : "(none)";
}

/** The judge's system prompts for a plan: a full pass, or (with `recheck`) the previous findings, the disputes and the diff. */
export function planReviewPrompts(o: { plan: string; spec?: { kind: "agreed" | "brief"; text: string }; folders: string[]; recheck?: { findings: Finding[]; disputes?: string; diff: string } }): string[] {
	const spec = o.spec ? `## Spec (${o.spec.kind === "brief" ? "the brief" : "the agreed list"})\n\n${o.spec.text}` : NO_SPEC_NOTE;
	const folders = o.folders.length ? [`## Other folders of this session\n\n${o.folders.map((f) => `- ${f}`).join("\n")}`] : [];
	if (!o.recheck) return [JUDGE_PLAN, spec, ...folders, "## Plan under review", o.plan];
	return [
		JUDGE_PLAN_RECHECK,
		spec,
		...folders,
		`## Your previous findings\n\n${findingsBlock(o.recheck.findings)}`,
		`## Planner disputes\n\n${o.recheck.disputes ?? "(none)"}`,
		`## Plan changes since your review\n\n${o.recheck.diff}`,
		"## Current plan",
		o.plan,
	];
}
