/**
 * The state and rules of a test-and-fix flow: which items are open, what the next step is, and the
 * plan of a fix round. Pure (no pi imports); test-flow.test.ts covers it, index.ts drives it.
 */

import type { TestReport, TestTag } from "./test-report.ts";
import type { HumanCheck } from "./waits.ts";

export interface StoredItem {
	tag: TestTag;
	title: string;
	body: string;
	/** The test round that last reported it. */
	round: number;
}

/** A question for the user, asked in a batch at the end of a round. `manual` is only kept for saved state: manual items are listed at the end, not asked. */
export interface Pending {
	kind: "ask" | "manual" | "blocked" | "refail" | "dispute";
	/** The item's ID, or "plan" for a plan flaw without one. */
	id: string;
	/** The title (items) or the flaw line (disputes). */
	text: string;
}

/** The state of a test-and-fix flow, from `/flow test` until it ends. */
export interface TestFlow {
	/** What the user asked to test. */
	scope: string;
	/** Test rounds started, 1-based. */
	round: number;
	/** The latest version of each reported item, by ID. */
	items: Record<string, StoredItem>;
	/** The latest report's Ran: lines. */
	ran: string[];
	/** The next free item number. */
	nextId: number;
	/** The automatic request for a valid report has been sent this round. */
	nudged?: boolean;
	/** Per repo (key: repoKey(root)): `git status --porcelain` lines when the round started. */
	snapshot?: Record<string, string[]>;
	/** Files that changed during testing, as `repo: porcelain line`. */
	strays?: string[];
	/** Fix rounds started. */
	fixRounds?: number;
	/** Fix rounds left before the limit menu. */
	fixBudget?: number;
	/** IDs reported `[fixed]`. */
	fixed?: string[];
	/** IDs the user chose to skip. */
	skipped?: string[];
	/** The user's answers, as `D<n>. <ID>: <answer>`. */
	answers?: string[];
	/** Failed fixes per ID. */
	refails?: Record<string, number>;
	/** The next fix round runs on the escalate model. */
	escalateNext?: boolean;
	/** The step IDs of the fix round in progress; the next report must cover them. */
	lastFixIds?: string[];
	/** How many of `answers` the supervisor has been told. */
	answersSent?: number;
	/** Questions for the end of the round. */
	pending?: Pending[];
}

export type Next = "fix" | "limit" | "ask" | "done";

/** Fills the fields a state saved by an older version lacks. */
export type Full = TestFlow & Required<Pick<TestFlow, "fixRounds" | "fixBudget" | "fixed" | "skipped" | "answers" | "refails" | "lastFixIds" | "pending">>;

export function normalize(f: TestFlow): Full {
	return {
		...f,
		fixRounds: f.fixRounds ?? 0,
		fixBudget: f.fixBudget ?? 0,
		fixed: f.fixed ?? [],
		skipped: f.skipped ?? [],
		answers: f.answers ?? [],
		refails: f.refails ?? {},
		lastFixIds: f.lastFixIds ?? [],
		pending: f.pending ?? [],
	};
}

/** A new flow: round 1, `maxRounds` fix rounds of budget. */
export function newTestFlow(scope: string, maxRounds: number, snapshot?: Record<string, string[]>): TestFlow {
	return { scope, round: 1, items: {}, ran: [], nextId: 1, snapshot, strays: [], fixRounds: 0, fixBudget: maxRounds, fixed: [], skipped: [], answers: [], refails: {}, lastFixIds: [], pending: [] };
}

const idNum = (id: string) => Number(id.slice(1));
const byId = (a: string, b: string) => idNum(a) - idNum(b);

/** `[bug]` items to fix: not skipped, and not waiting on a refail question. */
export function openBugs(flow: TestFlow): string[] {
	const f = normalize(flow);
	const waiting = new Set(f.pending.filter((p) => p.kind === "refail").map((p) => p.id));
	return Object.entries(f.items)
		.filter(([id, i]) => i.tag === "bug" && !f.skipped.includes(id) && !waiting.has(id))
		.map(([id]) => id)
		.sort(byId);
}

/** What the end of a test round does next. `maxRounds` 0 = no limit. */
export function nextAction(flow: TestFlow, cfg: { maxRounds: number }): Next {
	const f = normalize(flow);
	if (openBugs(f).length) return cfg.maxRounds === 0 || f.fixBudget > 0 ? "fix" : "limit";
	return f.pending.length ? "ask" : "done";
}

const answered = (f: { answers: string[] }, id: string) => f.answers.some((a) => new RegExp(`^D\\d+\\. ${id}:`).test(a));

/** Step 3 of a round's end: stores the report, settles the last fix round's items and queues questions. */
export function recordReport(flow: TestFlow, report: Pick<TestReport, "items" | "ran">, refailsLimit: number): Full {
	const f = normalize(flow);
	const items = { ...f.items };
	let nextId = f.nextId;
	const fixed = new Set(f.fixed);
	for (const it of report.items) {
		items[it.id] = { tag: it.tag, title: it.title, body: it.body, round: f.round };
		nextId = Math.max(nextId, idNum(it.id) + 1);
		if (it.tag === "fixed") fixed.add(it.id);
		else fixed.delete(it.id);
	}
	const refails = { ...f.refails };
	let escalateNext = f.escalateNext;
	let pending = [...f.pending];
	const queue = (p: Pending) => {
		pending = [...pending.filter((x) => !(x.id === p.id && x.kind === p.kind)), p];
	};
	for (const id of f.lastFixIds) {
		const it = items[id];
		if (!it || it.tag !== "bug") continue;
		refails[id] = (refails[id] ?? 0) + 1;
		if (refails[id] === 1) escalateNext = true;
		if (refails[id] >= refailsLimit) queue({ kind: "refail", id, text: it.title });
	}
	for (const it of report.items) {
		if ((it.tag === "ask" || it.tag === "blocked") && !f.skipped.includes(it.id) && !answered(f, it.id)) queue({ kind: it.tag, id: it.id, text: it.title });
	}
	// An item that no longer needs an answer drops its question.
	pending = pending.filter((p) => p.kind === "dispute" || p.kind === "refail" || items[p.id]?.tag === p.kind);
	return { ...f, items, ran: report.ran, nextId, fixed: [...fixed].sort(byId), refails, escalateNext, pending, lastFixIds: [], nudged: undefined };
}

/** The user skipped an item: never asked again, never fixed. */
export function skipItem(flow: TestFlow, id: string): Full {
	const f = normalize(flow);
	return { ...f, skipped: f.skipped.includes(id) ? f.skipped : [...f.skipped, id].sort(byId), pending: f.pending.filter((p) => p.id !== id) };
}

/** The user answered a question: recorded as `D<n>. <ID>: <answer>`, n continuing after D1. */
export function answerItem(flow: TestFlow, id: string, answer: string): Full {
	const f = normalize(flow);
	const n = f.answers.length + 2;
	return { ...f, answers: [...f.answers, `D${n}. ${id}: ${answer.replace(/\s*\r?\n\s*/g, " ").trim()}`] };
}

/** Plan-flaw lines of the judge as dispute questions: the first `S<n>` of a line is the ID, else "plan". */
export function pendingFromFlaws(lines: string[]): Pending[] {
	return lines.map((l) => ({ kind: "dispute" as const, id: /\bS\d+\b/.exec(l)?.[0] ?? "plan", text: l.trim() }));
}

/** The fix round's step IDs: [bug] items in ID order. */
export function fixSteps(flow: TestFlow): string[] {
	return openBugs(flow);
}

/** The `[manual]` items nobody skipped, in ID order: checks only a person can do, listed on the end card instead of asked. */
export function manualChecks(flow: TestFlow): HumanCheck[] {
	const f = normalize(flow);
	return Object.entries(f.items)
		.filter(([id, i]) => i.tag === "manual" && !f.skipped.includes(id))
		.sort(([a], [b]) => byId(a, b))
		.map(([id, i]) => {
			const steps = bodyField(i.body, "Steps");
			const look = bodyField(i.body, "Look for");
			return { id, text: [i.title, steps && `do: ${steps}`, look && `look for: ${look}`].filter(Boolean).join(" — ") };
		});
}

/** The outcome line of a finished flow and whether it is ok (no [bug] item remains). */
export function testOutcome(flow: TestFlow): { text: string; ok: boolean } {
	const f = normalize(flow);
	const open = Object.entries(f.items)
		.filter(([id, i]) => i.tag !== "fixed" && i.tag !== "manual" && !f.skipped.includes(id) && (i.tag === "bug" || !answered(f, id)))
		.sort(([a], [b]) => byId(a, b))
		.map(([id, i]) => `${id} ${i.tag}`);
	const manual = manualChecks(f);
	const fixed = f.fixed.filter((id) => f.items[id]?.tag === "fixed").length;
	const text = [`test: ${fixed} fixed in ${f.fixRounds} fix round${f.fixRounds === 1 ? "" : "s"}`, open.length && `open: ${open.join(", ")}`, manual.length && `human checks: ${manual.map((m) => m.id).join(", ")}`, f.skipped.length && `skipped: ${f.skipped.join(", ")}`].filter(Boolean).join("; ");
	const ok = !Object.values(f.items).some((i) => i.tag === "bug");
	return { text, ok };
}

/** The part of an approved plan from its first amendment heading on, kept verbatim in regenerated plans. */
export function amendmentTail(plan: string | undefined): string {
	const m = /^## (?:Amendment \d+|Plan choices upheld)/m.exec(plan ?? "");
	return m ? (plan as string).slice(m.index).trimEnd() : "";
}

/** The fix-round plan: the open [bug] items as steps, followed by `tail` (amendments) verbatim. */
export function testPlan(flow: TestFlow, tail = ""): string {
	const f = normalize(flow);
	const first = f.scope.split(/\r?\n/)[0].trim().slice(0, 60) || "test";
	const steps = openBugs(f).map((id) => {
		const i = f.items[id];
		return `**${id}.** [bug] ${i.title}${i.body ? `\n${i.body}` : ""}`;
	});
	const text = [
		`## Plan: Test: ${first}`,
		"1. Goal and non-goals.",
		"Goal: every [bug] step below behaves as its Expected says, verified by its repro in the next test round, without changing behaviour outside them.",
		"Non-goals: new features; refactors; items tagged ask, blocked or manual until answered; skipped items.",
		"2. User decisions:",
		`D1. Test scope: ${f.scope.replace(/\s*\r?\n\s*/g, " ")}`,
		...f.answers,
		"3. Facts:",
		...f.ran.map((r) => `Ran: ${r}`),
		"5. Steps:",
		...steps,
		"7. Done when:",
		"- each step's Expected holds and its repro passes in the next test round",
		"- each step has a regression test that fails without the fix, or the executor's report says why none can exist for that layer",
		"- the suites under Facts pass",
		"9. Commits:",
		"- one commit per step: fix: <title> (S<n>), with its regression test",
	].join("\n");
	return tail.trim() ? `${text}\n\n${tail.trim()}` : text;
}

/** The text of a field line (`  Question: ...`) in an item's body, or "". */
export function bodyField(body: string, name: string): string {
	const re = new RegExp(`^\\s+${name}:\\s*(.*)$`, "im");
	return re.exec(body)?.[1].trim() ?? "";
}

/** The options of an `[ask]` item: "a) x b) y" split at the letters; the whole text when it has no letters. */
export function askOptions(body: string): string[] {
	const text = bodyField(body, "Options");
	if (!text) return [];
	const parts = text.split(/(?:^|\s)(?=[a-z]\)\s)/i).map((p) => p.trim()).filter(Boolean);
	return parts.length > 1 || /^[a-z]\)\s/i.test(parts[0] ?? "") ? parts : [text];
}
