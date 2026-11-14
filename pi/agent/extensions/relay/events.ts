/** Relay's side of the event bus: K16 (`flow:active`, one flow owner per session), the job-set detection, and the versioned `relay:*` payloads. */

import * as fs from "node:fs";
import * as path from "node:path";
import { emitClaims } from "../shared/claims.ts";
import { JOB_ID } from "./job.ts";

// ----------------------------------------------------------------------------------------------- K16

/** K16 payload check: `{ v: 1, from: "workflow" | "relay", claim }`. */
export function parseFlowActive(data: unknown): { from: "workflow" | "relay"; claim?: (answer: unknown) => void } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "flow:active needs an object payload" };
	const o = data as { v?: unknown; from?: unknown; claim?: unknown };
	if (o.v !== 1) return { error: "flow:active: unsupported version (v must be 1)" };
	if (o.from !== "workflow" && o.from !== "relay") return { error: 'flow:active: from must be "workflow" or "relay"' };
	return { from: o.from, claim: typeof o.claim === "function" ? (o.claim as (answer: unknown) => void) : undefined };
}

/** Only `answer.owner` counts: null, `{error}` (timeout or rejection) and anything else are no claim. */
export function ownerOf(answer: unknown): string | undefined {
	const owner = (answer as { owner?: unknown } | null | undefined)?.owner;
	return typeof owner === "string" ? owner : undefined;
}

/** Walks up from `cwd` to the nearest `.pi-set.json`; true when the folder holding it is named like a job set (`r1a2b3c`, `r1a2b3c-f1`). */
export function inJobSet(cwd: string): boolean {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".pi-set.json"))) return JOB_ID.test(path.basename(dir));
		const up = path.dirname(dir);
		if (up === dir) return false;
		dir = up;
	}
}

export type Mode = "undecided" | "on" | "off";

export interface ActivationDeps {
	/** relay.json `active`. */
	active: () => boolean;
	cwd: string;
	role: string | undefined;
	/** Emits K16 (`pi.events.emit("flow:active", data)`). */
	emit: (data: unknown) => void;
	timeoutMs?: number;
}

/** Lead mode: decided lazily and once, so load order does not matter. */
export class Activation {
	mode: Mode = "undecided";
	/** Why lead mode is off, for a notice. */
	reason = "";
	private readonly d: ActivationDeps;
	private deciding: Promise<boolean> | undefined;

	constructor(d: ActivationDeps) {
		this.d = d;
	}

	get jobSet(): boolean {
		return inJobSet(this.d.cwd);
	}

	/** What relay's K16 listener claims: undefined, or `{ owner: "relay" }`. */
	claim(from: "workflow" | "relay"): { owner: "relay" } | undefined {
		if (from === "relay" || this.d.role || this.jobSet) return undefined;
		if (this.mode === "on") return { owner: "relay" };
		if (this.mode === "off") return undefined;
		return this.d.active() ? { owner: "relay" } : undefined;
	}

	private async ask(): Promise<boolean> {
		const claims = emitClaims(this.d.emit, { v: 1, from: "relay" }, this.d.timeoutMs ?? 2000);
		return ownerOf(await claims.answer) !== "workflow";
	}

	/** Decides once; true when lead mode is on. */
	decide(): Promise<boolean> {
		if (this.mode !== "undecided") return Promise.resolve(this.mode === "on");
		this.deciding ??= (async () => {
			if (this.d.role) this.set("off", "a relay worker or reviewer process");
			else if (!this.d.active()) this.set("off", "relay.json active is false");
			else if (this.jobSet) this.set("off", "relay: this is a job's worktree; lead mode off");
			else if (await this.ask()) this.set("on", "");
			else this.set("off", "relay: workflow owns this session; lead mode off");
			return this.mode === "on";
		})();
		return this.deciding;
	}

	private set(mode: Mode, reason: string) {
		this.mode = mode;
		this.reason = reason;
	}

	/** `/relay on`: asks again; refused while workflow claims or in a job set. */
	async turnOn(): Promise<{ ok: true } | { ok: false; why: string }> {
		if (this.d.role) return { ok: false, why: "relay workers do not run a lead" };
		if (this.jobSet) return { ok: false, why: "this is a job's worktree" };
		if (!this.d.active()) return { ok: false, why: "relay.json active is false" };
		const prev = this.mode;
		this.mode = "off"; // our own listener must not answer for us while we ask
		if (!(await this.ask())) {
			this.mode = prev === "undecided" ? "off" : prev;
			this.reason = "relay: workflow owns this session; lead mode off";
			return { ok: false, why: "workflow owns this session" };
		}
		this.set("on", "");
		this.deciding = Promise.resolve(true);
		return { ok: true };
	}

	turnOff(): void {
		this.set("off", "relay off");
		this.deciding = Promise.resolve(false);
	}
}

// ---------------------------------------------------------------------------------------------- events

export const JOB_START = "relay:job-start";
export const JOB_END = "relay:job-end";
export const APPROVAL = "relay:approval";

export const jobStartPayload = (job: string, title: string, repos: string[]) => ({ v: 1, job, title, repos });
export const jobEndPayload = (job: string, how: "delivered" | "stopped" | "failed", report: string) => ({ v: 1, job, how, report });
export const approvalPayload = (job: string, category: string, item: string, by: "brief" | "lead", reason: string) => ({ v: 1, job, category, item, by, reason });
