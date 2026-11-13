/** Desktop notifications when a session needs the user. Pure helpers; index.ts spawns the command. */

/** Minimum time between two notifications from one session. */
export const NOTIFY_GAP_MS = 15_000;

import { notifyCommand } from "../shared/notify.ts";

export { notifyCommand };

/** Why the session is idle, for the notification text. */
export function idleReason(o: { phase: string; waiting?: string }): string {
	if (o.waiting) return `waiting for you: ${o.waiting}`;
	if (o.phase === "discuss") return "discuss reply ready";
	return o.phase === "plan" ? "plan reply ready" : "turn finished";
}

/** Whether a notification may be shown now. */
export function notifyDue(o: { enabled: boolean; hasUI: boolean; now: number; last?: number }): boolean {
	if (!o.enabled || !o.hasUI) return false;
	return o.last === undefined || o.now - o.last >= NOTIFY_GAP_MS;
}
