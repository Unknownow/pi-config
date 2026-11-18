/** A pure function from two snapshots to events. No repeat of an event until its condition clears and comes back. */

import { outsideOwned } from "./paths.ts";

export interface Snapshot {
	head: string;
	porcelainHash: string;
	done: number | undefined;
	/** Files changed against the base, plus the dirty ones. */
	files: string[];
	/** ms since epoch of the sub-session's last heartbeat. */
	heartbeat: number;
	phase: string;
	waiting: boolean;
	/** ms since epoch of the last change of head, porcelain or done. */
	changedAt: number;
	reported: { drift: string[]; overlap: string[]; offline: boolean; stalled: boolean };
}

export interface MonitorEvent {
	type: "drift" | "overlap" | "offline" | "stalled";
	text: string;
	files?: string[];
}

export interface CheckCtx {
	now: number;
	owns: string[];
	forbids: string[];
	/** Changed files of the other sub-sessions, by id. */
	otherFiles: Map<string, string[]>;
	cfg: { stallMinutes: number };
	offlineSeconds?: number;
}

export const OFFLINE_SECONDS = 180;

export function check(prev: Snapshot | undefined, cur: Snapshot, ctx: CheckCtx): { events: MonitorEvent[]; next: Snapshot } {
	const events: MonitorEvent[] = [];
	const changed = !prev || prev.head !== cur.head || prev.porcelainHash !== cur.porcelainHash || prev.done !== cur.done || prev.waiting !== cur.waiting || prev.phase !== cur.phase;
	const changedAt = changed ? ctx.now : prev!.changedAt;
	const was = prev?.reported ?? { drift: [], overlap: [], offline: false, stalled: false };

	const outside = outsideOwned(cur.files, ctx.owns, ctx.forbids);
	const freshDrift = outside.filter((f) => !was.drift.includes(f));
	if (freshDrift.length) events.push({ type: "drift", text: `changed files outside its package: ${freshDrift.join(", ")}`, files: freshDrift });

	const overlapKeys: string[] = [];
	const overlapText: string[] = [];
	const overlapFiles: string[] = [];
	for (const [other, files] of ctx.otherFiles) {
		const set = new Set(files.map((f) => f.toLowerCase()));
		for (const f of cur.files) {
			if (!set.has(f.toLowerCase())) continue;
			const key = `${other}:${f}`;
			overlapKeys.push(key);
			if (!was.overlap.includes(key)) {
				overlapText.push(`${f} (also changed by ${other})`);
				overlapFiles.push(f);
			}
		}
	}
	if (overlapText.length) events.push({ type: "overlap", text: `changed the same files as another sub-session: ${overlapText.join(", ")}`, files: overlapFiles });

	const offlineAfter = (ctx.offlineSeconds ?? OFFLINE_SECONDS) * 1000;
	const offline = ctx.now - cur.heartbeat > offlineAfter;
	if (offline && !was.offline) events.push({ type: "offline", text: `no heartbeat for ${Math.round((ctx.now - cur.heartbeat) / 1000)} s; the session may have crashed (reopen with /wt open)` });

	const stalled = !offline && cur.phase === "execute" && !cur.waiting && ctx.now - changedAt >= ctx.cfg.stallMinutes * 60_000;
	if (stalled && !was.stalled) events.push({ type: "stalled", text: `no change in HEAD, files or steps for ${Math.round((ctx.now - changedAt) / 60_000)} min` });

	return { events, next: { ...cur, changedAt, reported: { drift: outside, overlap: overlapKeys, offline, stalled } } };
}

