/** What the orchestrator may answer on its own, and what needs the user's quote. Pure. */

import { isLive, quoteOk, type Caps, type Item, type SubCounters } from "./items.ts";

export interface Answer {
	choice?: string;
	resume?: boolean;
	text?: string;
	userQuote?: string;
}

export type Decision = { ok: true; role?: string; byUser: boolean; outcome: "choice" | "replan" } | { ok: false; reason: string; escalate: boolean };

const refuse = (reason: string, escalate = false): Decision => ({ ok: false, reason, escalate });

const NO_QUOTE = "needs a userQuote: an exact piece of a message the user typed after the escalation. Show the item to the user and relay their answer.";

/** For any answer to any item, by any tool: stale, answered and unknown items are refused; an escalated one needs a valid quote. Returns the refusal, or null. */
export function checkItemAnswer(item: Item | undefined, userQuote: string | undefined): string | null {
	if (!item) return "unknown item";
	if (item.state === "answered") return "this item was already answered";
	if (item.state === "stale") return "this item is stale (the sub-session restarted or the request was replaced); send it a directive with orch_send instead";
	if (!isLive(item)) return "this item is closed";
	if (item.state === "escalated") {
		if (!(userQuote ?? "").trim()) return `this item is escalated to the user; answering it ${NO_QUOTE}`;
		if (!quoteOk(item, userQuote)) return "the userQuote matches no message the user typed after the escalation";
	}
	return null;
}

/** The checks of `orch_decide` for a menu or wait item. `counters` are the sub's. */
export function checkDecision(item: Item | undefined, answer: Answer, counters: SubCounters, caps: Caps): Decision {
	const bad = checkItemAnswer(item, answer.userQuote);
	if (bad || !item) return refuse(bad ?? "unknown item");
	if (item.kind !== "menu" && item.kind !== "wait") return refuse(`${item.kind} items are answered with ${item.kind === "question" ? "orch_send (replyTo)" : item.kind === "plan-review" ? "orch_review_plan" : item.kind === "accept-request" ? "orch_accept" : "orch_send"}, not orch_decide`);
	const quote = quoteOk(item, answer.userQuote);
	if (item.kind === "wait") {
		if (answer.choice !== undefined) return refuse("a wait is answered with resume: true (and text)");
		if (answer.resume !== true) return refuse("resume must be true to end a wait");
		if (!quote) return refuse(`a wait always needs a person: resuming it ${NO_QUOTE}`, true);
		return { ok: true, byUser: true, outcome: "choice" };
	}
	if (answer.resume) return refuse("resume is only for waits; pick one of the options");
	const choice = answer.choice;
	if (choice === undefined || !(item.options ?? []).includes(choice)) return refuse(`choice must be one of: ${(item.options ?? []).join(" | ")}`);
	const role = item.roles?.[choice] ?? "other";
	if (item.key === "plan-menu" && role === "approve") return refuse("approve plans with orch_review_plan (a plan is reviewed by the orchestrator), not through this menu");
	if (item.key === "plan-menu" && role === "discuss") return refuse("not available in an orchestrated sub-session: pick another option, or reject the plan with reasons");
	if (role === "wait" && (item.key === "stage-empty" || item.key === "steps-open") && !(answer.text ?? "").trim()) return refuse("'Wait' needs text: what the sub-session should wait for or do meanwhile");
	if (role === "stop" && !quote) return refuse(`stopping the flow ${NO_QUOTE}`, true);
	if (role === "replan" && counters.replans >= caps.maxReplans && !quote) return refuse(`${counters.replans} replans were already used in this run (maxReplans ${caps.maxReplans}); another one ${NO_QUOTE}`, true);
	return { ok: true, role, byUser: quote, outcome: role === "replan" ? "replan" : "choice" };
}
