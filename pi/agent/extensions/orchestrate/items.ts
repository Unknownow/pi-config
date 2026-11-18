/**
 * Items: what a sub-session waits on from the orchestrator (a question, a workflow menu or wait, an idle report, a plan review, an accept
 * request), with the reminder and escalation timing and the caps that stop an endless auto-answer loop. Pure: the clock is passed in and
 * the file object is changed in place (the orchestrator session is its only writer; see store.ts readItems/writeItems).
 */

export type ItemKind = "question" | "menu" | "wait" | "idle" | "plan-review" | "accept-request";
export type ItemState = "open" | "answered" | "escalated" | "stale";

export interface UserMsg {
	at: number;
	text: string;
}

export interface Item {
	/** question: message id; menu and wait: the K12 id; idle: message id; plan-review: `plan-<n>`; accept-request: `accept-<repo>-<tree>`. */
	ref: string;
	sub: string;
	kind: ItemKind;
	key?: string;
	stage?: number;
	postedAt: number;
	state: ItemState;
	reminders: number;
	lastReminderAt?: number;
	/** ms of orchestrator idle time since it was posted. */
	idleMs: number;
	escalatedAt?: number;
	/** The overdue notice was sent once (the timeouts no longer escalate). */
	overdueNotified?: boolean;
	/** The question shown to the user. */
	escalation?: string;
	/** What the user typed after the escalation. */
	userMsgs: UserMsg[];
	byUser?: boolean;
	instance?: string;
	summary: string;
	options?: string[];
	roles?: Record<string, string>;
	repo?: string;
	tree?: string;
	n?: number;
	/** wait: "external" = nothing for a person (another package's PR, CI, a release); its check resumes it. */
	waitKind?: "external";
	/** wait: what the sub's check is doing: pending, stopped, broken or passed. */
	checkStatus?: string;
	/** wait: the sub's check command. */
	check?: string;
	/** wait: an external wait whose check is still polling; it is not escalated and has no timers. */
	parked?: true;
}

export interface SubCounters {
	planRejections: number;
	replans: number;
	autoAnswers: Record<string, { count: number; stage?: number; fp?: string }>;
	idleNoProgress: number;
	/** phase|stage|done|head|porcelainHash, from the last poll. */
	fingerprint?: string;
	/** The fingerprint at the last idle item. */
	idleFp?: string;
	instance?: string;
}

export interface ItemsFile {
	v: 1;
	items: Item[];
	subs: Record<string, SubCounters>;
}

export interface Caps {
	maxPlanRejections: number;
	maxReplans: number;
	maxAutoAnswers: number;
	maxIdleAnswers: number;
}

/** `step-back`: a limit was reached; the item stays open and the orchestrator re-plans instead of asking the user. `remind` with `overdue` is a late reminder plus a UI notice. */
export type Action = { type: "remind"; item: Item; overdue?: string } | { type: "escalate"; item: Item; why: string } | { type: "step-back"; item: Item; why: string };

/** These keys loop on the same problem: their count resets only when the stage changes. */
export const LOOP_KEYS = ["judge-cap", "plan-flaw", "accept", "merge-early"];
export const REMIND_AT_MS = [60_000, 5 * 60_000, 10 * 60_000];
export const ESCALATE_IDLE_MS = 15 * 60_000;
export const ESCALATE_CEILING_MS = 30 * 60_000;

export const emptyItems = (): ItemsFile => ({ v: 1, items: [], subs: {} });

export function countersOf(file: ItemsFile, sub: string): SubCounters {
	return (file.subs[sub] ??= { planRejections: 0, replans: 0, autoAnswers: {}, idleNoProgress: 0 });
}

export const isLive = (i: Item): boolean => i.state === "open" || i.state === "escalated";
export const liveItems = (file: ItemsFile, sub?: string): Item[] => file.items.filter((i) => isLive(i) && (sub === undefined || i.sub === sub));
export const findItem = (file: ItemsFile, sub: string, ref: string): Item | undefined => file.items.find((i) => i.sub === sub && i.ref === ref);
/** Escalated items that wait for the user. */
export const waitingForUser = (file: ItemsFile): Item[] => file.items.filter((i) => i.state === "escalated");

export const planRef = (n: unknown): string => `plan-${String(n ?? "?")}`;
export const acceptRef = (repo: string, tree: string): string => `accept-${repo || "-"}-${tree.slice(0, 12)}`;

/** A wait is parked (not escalated) when it is external, has a check and that check is still polling. `manual` does not matter. */
export function isParkedWait(w: { waitKind?: unknown; check?: unknown; checkStatus?: unknown } | undefined): boolean {
	return !!w && w.waitKind === "external" && typeof w.check === "string" && w.check.trim() !== "" && w.checkStatus === "pending";
}

/** The data of one sub outbox message that may open an item. */
export interface OpenMsg {
	sub: string;
	type: string;
	id: string;
	text: string;
	data?: Record<string, unknown>;
	stage?: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Fingerprint of a sub's progress. */
export const fingerprintOf = (o: { phase: string; stage?: number; done?: number; head: string; porcelainHash: string }): string => `${o.phase}|${o.stage ?? ""}|${o.done ?? ""}|${o.head}|${o.porcelainHash}`;

export function setFingerprint(file: ItemsFile, sub: string, fp: string): void {
	countersOf(file, sub).fingerprint = fp;
}

/** Marks an item escalated (the user must answer it). */
export function escalate(item: Item, now: number, why: string, question?: string): Action {
	item.state = "escalated";
	item.escalatedAt = now;
	item.escalation = question || `${item.summary}\n(${why})`;
	item.userMsgs = [];
	return { type: "escalate", item, why };
}

/**
 * One item per outbox message of type question, ask, idle, plan-review or accept-request. Applies the caps; returns the escalations.
 * An item that is already open is left alone; a closed one with the same ref is reopened.
 */
export function openItem(file: ItemsFile, m: OpenMsg, caps: Caps, now: number): Action[] {
	const c = countersOf(file, m.sub);
	let item: Item;
	const base = { sub: m.sub, stage: m.stage, postedAt: now, state: "open" as ItemState, reminders: 0, idleMs: 0, userMsgs: [] as UserMsg[], instance: c.instance };
	if (m.type === "question") item = { ...base, ref: m.id, kind: "question", summary: m.text };
	else if (m.type === "ask") {
		const wait = m.data?.kind === "wait";
		const w = wait ? (m.data?.wait as { waitKind?: unknown; check?: unknown; checkStatus?: unknown } | undefined) : undefined;
		item = {
			...base,
			ref: str(m.data?.id),
			kind: wait ? "wait" : "menu",
			key: wait ? "wait" : str(m.data?.key),
			summary: wait ? str((m.data?.wait as { reason?: unknown } | undefined)?.reason) || str(m.data?.title) : str(m.data?.title),
			options: Array.isArray(m.data?.options) ? (m.data.options as unknown[]).filter((o): o is string => typeof o === "string") : undefined,
			roles: m.data?.roles && typeof m.data.roles === "object" ? (m.data.roles as Record<string, string>) : undefined,
			...(w?.waitKind === "external" ? { waitKind: "external" as const } : {}),
			...(typeof w?.checkStatus === "string" ? { checkStatus: w.checkStatus } : {}),
			...(typeof w?.check === "string" && w.check ? { check: w.check } : {}),
			...(isParkedWait(w) ? { parked: true as const } : {}),
		};
		if (!item.ref) return [];
	} else if (m.type === "idle") item = { ...base, ref: m.id, kind: "idle", summary: m.text };
	else if (m.type === "plan-review") item = { ...base, ref: planRef(m.data?.n), kind: "plan-review", n: typeof m.data?.n === "number" ? m.data.n : undefined, summary: m.text };
	else if (m.type === "accept-request") {
		const repo = str(m.data?.repo);
		const tree = str(m.data?.tree);
		item = { ...base, ref: acceptRef(repo, tree), kind: "accept-request", key: "accept", repo, tree, summary: m.text };
	} else return [];

	const same = findItem(file, m.sub, item.ref);
	if (same && isLive(same)) return [];
	if (same) file.items.splice(file.items.indexOf(same), 1);

	if (item.kind === "accept-request") for (const o of file.items) if (o.sub === m.sub && o.kind === "accept-request" && o.repo === item.repo && isLive(o)) o.state = "stale";
	if (item.kind === "plan-review") {
		for (const o of file.items) if (o.sub === m.sub && o.kind === "plan-review" && isLive(o)) o.state = "stale";
		if (c.autoAnswers["plan-menu"]) c.autoAnswers["plan-menu"].count = 0;
	}
	// safety net: the workflow ends the old ask itself (setWaiting)
	if (item.kind === "wait") for (const o of file.items) if (o.sub === m.sub && o.kind === "wait" && isLive(o)) o.state = "stale";
	file.items.push(item);

	let why = "";
	if (item.kind === "wait") why = item.parked ? "" : waitWhy(item);
	else if (item.kind === "plan-review") {
		if (c.planRejections >= caps.maxPlanRejections) why = `${c.planRejections} plans were rejected in a row`;
	} else if (item.kind === "menu" || item.kind === "accept-request") {
		const key = item.key ?? "";
		const e = c.autoAnswers[key];
		if (e) {
			if (LOOP_KEYS.includes(key) ? e.stage !== item.stage : e.fp !== c.fingerprint) e.count = 0;
			if (e.count >= caps.maxAutoAnswers) why = `${key} was answered ${e.count} times without getting out of the loop`;
		}
	} else if (item.kind === "idle") {
		c.idleNoProgress = c.idleFp !== undefined && c.idleFp === c.fingerprint ? c.idleNoProgress + 1 : 1;
		c.idleFp = c.fingerprint;
		if (c.idleNoProgress > caps.maxIdleAnswers) why = `idle ${c.idleNoProgress} times without progress`;
	}
	return why ? (item.kind === "wait" ? [escalate(item, now, why)] : [{ type: "step-back", item, why }]) : [];
}

/** Why a wait that is not parked goes to the user. */
function waitWhy(item: Item): string {
	const check = waitCheckOf(item);
	if (item.waitKind === "external" && item.checkStatus === "stopped") return `the sub stopped checking "${check}"`;
	if (item.waitKind === "external" && item.checkStatus === "broken") return "its check can't run";
	if (item.waitKind === "external" && item.checkStatus === "passed") return "the check passed; the sub waits for a person to resume it (autoResume is off)";
	return "a wait always needs a person";
}
const waitCheckOf = (item: Item): string => item.check ?? "";

/** Time passes: `elapsedMs` counts as idle time only while the orchestrator is idle. Returns the reminders and escalations due. */
export function tick(file: ItemsFile, now: number, orchestratorIdle: boolean, elapsedMs: number): Action[] {
	const out: Action[] = [];
	for (const item of file.items) {
		if (item.state !== "open" || item.parked) continue;
		if (orchestratorIdle) item.idleMs += Math.max(0, elapsedMs);
		const overdue = item.idleMs >= ESCALATE_IDLE_MS ? "the orchestrator did not answer for 15 minutes" : now - item.postedAt >= ESCALATE_CEILING_MS ? "30 minutes without an answer" : "";
		if (overdue) {
			if (!item.overdueNotified) {
				item.overdueNotified = true;
				out.push({ type: "remind", item, overdue });
			}
		} else if (item.reminders < REMIND_AT_MS.length && item.idleMs >= REMIND_AT_MS[item.reminders]) {
			item.reminders++;
			item.lastReminderAt = now;
			out.push({ type: "remind", item });
		}
	}
	return out;
}

export type Outcome = "choice" | "replan" | "approved" | "rejected" | "accepted" | "refused";

/**
 * Closes an item and updates the counters. The orchestrator's answers count towards the caps; the user's answer (`byUser`) resets the cap
 * of that item (not `replans`). A withdrawn or stale item, or one the sub resolved itself, changes no counter.
 */
export function close(file: ItemsFile, sub: string, ref: string, o: { how: "answered" | "withdrawn" | "stale"; byUser?: boolean; outcome?: Outcome }): Item | undefined {
	const item = findItem(file, sub, ref);
	if (!item || !isLive(item)) return undefined;
	item.state = o.how === "answered" ? "answered" : "stale";
	if (o.byUser) item.byUser = true;
	const c = countersOf(file, sub);
	if (o.how !== "answered") return item;
	const key = item.key ?? "";
	if (o.byUser) {
		if (item.kind === "plan-review") c.planRejections = 0;
		else if (item.kind === "idle") c.idleNoProgress = 0;
		else if ((item.kind === "menu" || item.kind === "accept-request") && c.autoAnswers[key]) c.autoAnswers[key].count = 0;
		return item;
	}
	const bump = () => {
		const e = (c.autoAnswers[key] ??= { count: 0 });
		e.count++;
		e.stage = item.stage;
		e.fp = c.fingerprint;
	};
	if (o.outcome === "choice" || o.outcome === "replan") bump();
	if (o.outcome === "replan") c.replans++;
	if (o.outcome === "refused") bump();
	if (o.outcome === "rejected") c.planRejections++;
	if (o.outcome === "approved") c.planRejections = 0;
	return item;
}

/** The sub-session restarted (`instance` is new): its open menus and plan reviews of earlier instances are stale. Returns the stale items. */
export function markStale(file: ItemsFile, sub: string, instance: string): Item[] {
	const c = countersOf(file, sub);
	c.instance = instance;
	const out: Item[] = [];
	for (const i of file.items) {
		if (i.sub !== sub || !isLive(i) || i.instance === instance) continue;
		if (i.kind !== "menu" && i.kind !== "plan-review") continue;
		i.state = "stale";
		out.push(i);
	}
	return out;
}

/** An `idle-end` or a message to the sub ends its open idle items; an escalated one only when `force`. */
export function closeIdle(file: ItemsFile, sub: string, force: boolean): Item[] {
	const out: Item[] = [];
	for (const i of file.items) if (i.sub === sub && i.kind === "idle" && (i.state === "open" || (force && i.state === "escalated"))) out.push(close(file, sub, i.ref, { how: "answered" })!);
	return out;
}

/** What the user typed is kept on every escalated item (the evidence for `userQuote`). */
export function recordUserMessage(file: ItemsFile, text: string, now: number): void {
	const t = text.trim();
	if (!t) return;
	for (const i of file.items) if (i.state === "escalated") i.userMsgs.push({ at: now, text: t });
}

/** A quote is valid when it is an exact piece of a message the user typed after the escalation: at least 8 characters, or the whole message when that is shorter. */
export function quoteOk(item: Item, quote: string | undefined): boolean {
	const q = (quote ?? "").trim();
	return q.length > 0 && item.userMsgs.some((m) => m.text.includes(q) && q.length >= Math.min(8, m.text.length));
}

/** Sub states in which an `idle` report makes sense. */
export const IDLE_STATES = ["spawned", "planning", "executing"];

/** Whether the sub may post an `idle`: not while it waits on something else, not after its work is done. */
export function idleAllowed(subState: string, open: { plan: boolean; ask: boolean; question: boolean; accept: boolean }): boolean {
	return IDLE_STATES.includes(subState) && !open.plan && !open.ask && !open.question && !open.accept;
}

/** D10: a sub tells the user that the orchestrator is not running, once per item older than 30 min, when the owner's pid is dead on this host. */
export function orphanDue(o: { ownerHost: string; host: string; ownerAlive: boolean; ageMs: number; alreadyNotified: boolean }): boolean {
	return !o.alreadyNotified && o.ownerHost === o.host && !o.ownerAlive && o.ageMs >= ESCALATE_CEILING_MS;
}
