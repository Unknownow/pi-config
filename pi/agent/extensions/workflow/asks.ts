/**
 * Pure parts of the contracts K12 (workflow:ask) and K13 (workflow:idle); see README.md.
 * A listener (the orchestrator) claims an ask to answer it in place of the person at the keyboard;
 * an ask nobody claims is shown locally exactly as before.
 */
import { emitClaims } from "../shared/claims.ts";

/** What an option means, so a listener never matches label text. */
export type AskRole = "approve" | "discuss" | "stop" | "replan" | "wait" | "other";

/** The fixed keys of K12: where in the flow the ask comes from. */
export const ASK_KEYS = {
	"executor-error": "the executor's last reply ended in an error",
	"judge-error": "the judge failed to run",
	"judge-cap": "the judge failed the maximum number of rounds in a row",
	"plan-flaw": "the judge questions the approved plan",
	"merge-early": "a merge before the end of the flow",
	"steps-open": "all changes were delivered but plan steps are still open",
	"stage-empty": "a stage ended with no changes",
	"run-judge": "the diff is ready for the judge",
	"plan-menu": "the plan is ready (or blocked) and waits for approval",
	wait: "the flow waits for a person",
} as const;
export type AskKey = keyof typeof ASK_KEYS;

export interface OpenAsk {
	id: string;
	key: AskKey;
	kind: "menu";
	title: string;
	options: string[];
	detail?: string;
}

export const nextAskId = (flowId: string | undefined, seq: number): string => `${flowId ?? "flow"}:${seq}`;

export const isValidChoice = (options: readonly string[], choice: unknown): choice is string => typeof choice === "string" && options.includes(choice);

export type AskAnswer = { kind: "choice"; choice: string; text?: string } | { kind: "resume"; text?: string } | { kind: "invalid" } | { kind: "local" };

/** Classifies the settled answer of a K12 claim. `null` and `{ error }` mean "show it locally". */
export function askAnswer(answer: unknown, options: readonly string[] | undefined, kind: "menu" | "wait"): AskAnswer {
	if (answer === null || answer === undefined) return { kind: "local" };
	if (typeof answer !== "object") return { kind: "invalid" };
	const o = answer as { choice?: unknown; resume?: unknown; text?: unknown; error?: unknown };
	if ("error" in o && o.error !== undefined) return { kind: "local" };
	const text = typeof o.text === "string" && o.text.trim() ? o.text.trim() : undefined;
	if (kind === "menu" && o.choice !== undefined) return isValidChoice(options ?? [], o.choice) ? { kind: "choice", choice: o.choice, ...(text ? { text } : {}) } : { kind: "invalid" };
	if (kind === "wait" && o.resume === true) return { kind: "resume", ...(text ? { text } : {}) };
	return { kind: "invalid" };
}

export type CheckStatus = "pending" | "stopped" | "broken" | "passed";

export interface WaitInfo {
	reason: string;
	check?: string;
	manual?: boolean;
	/** "external": nothing for a person (another package's PR, CI, a release); the check resumes it. */
	waitKind?: "external";
}

export function waitPayload(id: string, w: WaitInfo, detail?: string, checkStatus?: CheckStatus): object {
	const wait = { reason: w.reason, ...(w.check ? { check: w.check } : {}), manual: !!w.manual, ...(w.waitKind ? { waitKind: w.waitKind } : {}), ...(w.check && checkStatus ? { checkStatus } : {}) };
	return { v: 1, id, key: "wait", kind: "wait", title: `Waiting: ${w.reason}`, wait, ...(detail ? { detail } : {}) };
}

export interface MenuRequest {
	key: AskKey;
	title: string;
	options: string[];
	detail?: string;
	roles?: Record<string, AskRole>;
	/** Called when the ask is shown locally (nobody claimed it), before the menu. */
	localNotice?: () => void;
	/** When nobody claims the ask, show no menu: the caller's notice is all there is. */
	skipLocal?: boolean;
}

export interface MenuDeps {
	/** Bumps the saved sequence and returns the id of the new ask. */
	newId(): string;
	setOpen(open: OpenAsk | undefined): void;
	emit(channel: string, data: unknown): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(title: string): void;
	/** Delivers the answer's follow-up text once the caller has applied the choice. */
	deliverText(text: string): void;
}

/** A listener that keeps answering with a bad choice must not hold the flow forever. */
export const MAX_REASKS = 20;

/** The menu of `askUser`: claimed → the listener answers; unclaimed or answered `null` → as before. */
export async function askMenu(deps: MenuDeps, req: MenuRequest): Promise<string | undefined> {
	const id = deps.newId();
	deps.setOpen({ id, key: req.key, kind: "menu", title: req.title, options: req.options, ...(req.detail ? { detail: req.detail } : {}) });
	const done = (how: "answered" | "withdrawn"): void => {
		deps.setOpen(undefined);
		deps.emit("workflow:ask-done", { v: 1, id, how });
	};
	for (let i = 0; i <= MAX_REASKS; i++) {
		const payload = { v: 1, id, key: req.key, kind: "menu", title: req.title, options: req.options, ...(req.roles ? { roles: req.roles } : {}), ...(req.detail ? { detail: req.detail } : {}) };
		const claims = emitClaims((d) => deps.emit("workflow:ask", d), payload, 0);
		if (!claims.claimed) break;
		const a = askAnswer(await claims.answer, req.options, "menu");
		if (a.kind === "choice") {
			done("answered");
			if (a.text) deps.deliverText(a.text);
			return a.choice;
		}
		if (a.kind === "local") break;
		// invalid: ask again with the same id
	}
	deps.setOpen(undefined);
	req.localNotice?.();
	if (req.skipLocal) return undefined;
	deps.notify(req.title);
	return deps.select(req.title, req.options);
}

/** What `session_start` does with the ask state it restored. */
export function restoreAsks(saved: { openAsk?: OpenAsk; waiting?: { askId?: string } & WaitInfo }): { withdraw?: string; resendWait?: { id: string; wait: WaitInfo } } {
	const out: { withdraw?: string; resendWait?: { id: string; wait: WaitInfo } } = {};
	if (saved.openAsk) out.withdraw = saved.openAsk.id;
	if (saved.waiting?.askId) out.resendWait = { id: saved.waiting.askId, wait: { reason: saved.waiting.reason, ...(saved.waiting.check ? { check: saved.waiting.check } : {}), ...(saved.waiting.manual ? { manual: true } : {}), ...(saved.waiting.waitKind ? { waitKind: saved.waiting.waitKind } : {}) } };
	return out;
}

/** Whether the K13 idle timer may fire now. */
export function idleDue(o: { phase: string; idle: boolean; compacting: boolean; compactPending: boolean; pendingHandover: boolean }): boolean {
	return (o.phase === "plan" || o.phase === "execute") && o.idle && !o.compacting && !o.compactPending && !o.pendingHandover;
}

export const IDLE_TEXT_MAX = 4000;

export function idlePayload(flowId: string | undefined, phase: string, lastText: string): object {
	return { v: 1, ...(flowId ? { flowId } : {}), phase, lastText: lastText.length > IDLE_TEXT_MAX ? lastText.slice(0, IDLE_TEXT_MAX) : lastText };
}

/** What ends a wait that a listener resumed: the check must pass (or be absent) first. */
export function waitResumeOutcome(w: { check?: string; checkPassed?: boolean }, verdict: { status: string } | undefined): "end" | "reask" {
	if (w.check && !w.checkPassed && verdict?.status !== "pass") return "reask";
	return "end";
}

/** The message that resumes the executor after a wait: the same text whether a person typed it or a listener sent it. */
export function resumeContent(prefix: string, held: string | undefined, text: string | undefined): string {
	return `${prefix}\n\n${held ? `${held}\n\n` : ""}${text ?? "Continue with the open steps of the plan."}`;
}

/** The local idle notification stays off while K13 handled the idle period or its claim is still open. */
export function idleNoticeAllowed(o: { handled: boolean; pending: boolean }): boolean {
	return !o.handled && !o.pending;
}

export const PLAN_APPROVE = "Approve";
export const PLAN_ARBITER = "Approve, arbiter solves plan flaws →";
export const PLAN_FULL = "Full flow instead";
export const PLAN_BACK = "Back to discussion";

/** The `plan-menu` ask: its options and what each means. `skipLocal`: with planPrompt off an unclaimed ask shows no menu. */
export function planMenuRequest(o: { blocked: boolean; quick: boolean; planFlawAsk: boolean; planPrompt: boolean }): { key: "plan-menu"; options: string[]; roles: Record<string, AskRole>; skipLocal: boolean } {
	const options = [...(o.blocked ? [] : [PLAN_APPROVE, ...(o.planFlawAsk && !o.quick ? [PLAN_ARBITER] : [])]), o.quick ? PLAN_FULL : PLAN_BACK, "Keep discussing"];
	return { key: "plan-menu", options, roles: { [PLAN_APPROVE]: "approve", [PLAN_ARBITER]: "approve", [PLAN_FULL]: "discuss", [PLAN_BACK]: "discuss" }, skipLocal: !o.planPrompt };
}

/** Bumps the saved ask counter and returns the id of the new ask. */
export function bumpAskId(state: { askSeq?: number; planDoc?: { flowId: string } }): string {
	state.askSeq = (state.askSeq ?? 0) + 1;
	return nextAskId(state.planDoc?.flowId, state.askSeq);
}

/** The `ask-done` payload for a wait that ended; none when the wait has no ask. */
export function waitDonePayload(w: { askId?: string } | undefined): { v: 1; id: string; how: "answered" } | undefined {
	return w?.askId ? { v: 1, id: w.askId, how: "answered" } : undefined;
}
