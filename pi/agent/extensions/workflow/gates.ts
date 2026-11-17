/** Pure decisions of the automatic review gates (the plan critic and the discussion critic). `index.ts` only runs the critic, sends messages and keeps the runtime handle. */

import { type CriticRequest, type Finding, isClean } from "../agents/api.ts";
import { blockingFindings, minorFindings } from "../shared/findings.ts";
export { type Finding, isClean, parseFindings } from "../agents/api.ts";
export type { Severity } from "../shared/findings.ts";
export { blockingFindings, findingText, isEscKey, minorFindings, textHash } from "../shared/findings.ts";
import { endsInQuestion } from "./agent-end.ts";
import { foldersNote } from "./discussion-review.ts";
import { NO_SPEC_NOTE, PLAN_CRITERIA } from "./prompts.ts";

export type GateVerdict = "PASS" | "FAIL" | "cancelled" | "error";
export type SpecKind = "agreed" | "none";

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
	/** Minors of the last run (and late majors): shown as a count and appended to the approved plan as notes for the executor. */
	notes?: Finding[];
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

/**
 * What to do with a complete plan: skip the gate, reuse a verdict, or run the critic (confirm: one run, no fix loop).
 * A recheck carries the last findings; a plan whose text differs too much from the reviewed one (planTextDiff null) gets a full review.
 */
export function planGateDecide(o: { mode: "off" | "auto"; plan: string; planHash: string; gate?: PlanGate; hasDisputes?: boolean }): "off" | "reuse" | "confirm" | "recheck" | "full" {
	if (o.mode === "off") return "off";
	const g = o.gate;
	const decided = g?.verdict === "PASS" || g?.verdict === "FAIL";
	// The planner disputed findings without changing the plan: the critic rules on the disputes (unless the cap is reached).
	if (g && g.planHash === o.planHash && o.hasDisputes && g.judgedPlan !== undefined && g.autoFindings.length + g.userFindings.length > 0 && !g.cappedHash && decided) return "recheck";
	if (g && decided && (g.planHash === o.planHash || (g.judgedPlan !== undefined && planTextDiff(g.judgedPlan, o.plan) === ""))) return "reuse";
	if (g?.cappedHash && g.cappedHash !== o.planHash) return "confirm";
	if (g?.judgedPlan) return planTextDiff(g.judgedPlan, o.plan) === null ? "full" : "recheck";
	return "full";
}

/** After a plan-judge run (`rounds` already counts it): send the auto findings to the planner, or offer the plan. User findings are never sent. */
export function planGateAfterVerdict(o: { verdict: string; findings: Finding[]; rounds: number; max: number; confirm: boolean }): { action: "offer" | "fix"; auto: Finding[]; user: Finding[]; notes: Finding[]; capped: boolean } {
	// Only blocking findings are fixed or shown as open; minors become notes for the executor.
	const blocking = blockingFindings(o.findings);
	const auto = blocking.filter((f) => f.route === "auto");
	const user = blocking.filter((f) => f.route !== "auto");
	const notes = minorFindings(o.findings);
	if (isClean(o.verdict, o.findings)) return { action: "offer", auto, user, notes, capped: false };
	const capped = o.rounds >= o.max;
	return { action: !o.confirm && auto.length > 0 && !capped ? "fix" : "offer", auto, user, notes, capped };
}

/** A "go" typed while the gate ran: approve only after a clean PASS, otherwise show the menu. */
export function planOfferAction(o: { clean: boolean; queuedGo: boolean }): "approve" | "offer" {
	return o.clean && o.queuedGo ? "approve" : "offer";
}

/** A new flow, or a replan, starts clean ("enter-plan"). */
export function planGateReset(_gate: PlanGate | undefined, _why: "enter-plan"): PlanGate | undefined {
	return undefined;
}

/** The critic request of a plan review: always the whole plan, flow's plan criteria with the agreed list (the spec) and the folders; on a recheck the previous findings and the planner's disputes. */
export function planCriticRequest(o: { plan: string; spec?: { kind: "agreed"; text: string }; folders: string[]; recheck?: { findings: Finding[]; disputes?: string } }): Pick<CriticRequest, "document" | "about" | "criteria" | "previousFindings" | "disputes"> {
	const spec = o.spec ? `The agreed list (the spec):\n\n${o.spec.text}` : NO_SPEC_NOTE;
	return {
		about: "flow plan",
		document: o.plan,
		criteria: [PLAN_CRITERIA, spec, foldersNote(o.folders)].filter(Boolean).join("\n\n"),
		...(o.recheck ? { previousFindings: o.recheck.findings } : {}),
		...(o.recheck?.disputes ? { disputes: o.recheck.disputes } : {}),
	};
}

/** What the discussion gate remembers about its last review; persisted in the state entry. */
export interface DiscussionReview {
	listHash: string;
	verdict: "PASS" | "FAIL";
	findings: Finding[];
	/** Id of the last branch entry after the review was posted: the next recheck reads the transcript after it. */
	afterEntryId?: string;
	rounds: number;
	status: "idle" | "awaiting-fix" | "paused";
	/** Set by the restate request: false for a manual `/flow critic`, which starts no fix loop. */
	restateLoop?: boolean;
}

/** The findings `/flow plan force` carries into planning: the last review's, only when it belongs to the current agreed list. */
export function forcedOpenFindings(review: DiscussionReview | undefined, listHash: string): Finding[] {
	return review && listHash !== "" && review.listHash === listHash ? review.findings : [];
}

/** What to do when the user moves from discuss to plan. `sinceChars` is the length of the transcript since the last review (Infinity when its entry is gone). */
export function discussionGateStart(o: { mode: "off" | "auto"; listHash?: string; last?: DiscussionReview; sinceChars: number; cap: number }): "move" | "warn-move" | "full" | "recheck" {
	if (o.mode === "off") return "move";
	if (!o.listHash) return "warn-move";
	const l = o.last;
	if (l && l.listHash === o.listHash && isClean(l.verdict, l.findings)) return "move";
	if (l && l.afterEntryId && blockingFindings(l.findings).length > 0 && o.sinceChars <= o.cap) return "recheck";
	return "full";
}

/** After a discussion judge run: move on, send the findings to the discuss model, or pause for the user. */
export function discussionGateAfterVerdict(o: { verdict: string; findings: Finding[]; rounds: number; max: number }): "move" | "fix" | "pause" | "move-open" {
	if (isClean(o.verdict, o.findings)) return "move";
	if (blockingFindings(o.findings).some((f) => f.route === "user")) return "pause";
	return o.rounds < o.max ? "fix" : "move-open";
}

/** After the discuss model answered a fix request: recheck when it wrote a new list, else pause. */
export function discussionGateAfterFixReply(o: { prevListHash: string; replyListHash?: string; reply: string }): "recheck" | "pause" {
	if (!o.replyListHash || o.replyListHash === o.prevListHash || endsInQuestion(o.reply)) return "pause";
	return "recheck";
}

/** Typed input while a discussion judge runs: a second "go" only shows a notice, other text cancels. */
export function discussionGateOnInput(o: { running: boolean; isGo: boolean }): "notice" | "cancel" | "pass" {
	if (!o.running) return "pass";
	return o.isGo ? "notice" : "cancel";
}

