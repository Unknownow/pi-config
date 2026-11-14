/** Relay's side of the event bus: K16 (`flow:active`, one flow owner per session), the job-set detection, and the versioned `relay:*` payloads. */

import * as fs from "node:fs";
import * as path from "node:path";
import { emitClaims } from "../shared/claims.ts";
import { JOB_ID, type Job } from "./job.ts";

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
		// relay's listener ignores from:"relay", so it cannot answer its own question; the mode stays as it is while we ask
		if (!(await this.ask())) {
			if (this.mode === "undecided") this.mode = "off";
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
export const JOB_PROGRESS = "relay:job-progress";
export const APPROVAL = "relay:approval";

/** Who a job belongs to for an orchestrator: echoed in the job events, wake prefix `[<package>] `. */
export interface Tag {
	run: string;
	package: string;
}
export interface Used {
	tokens: number;
	wallMs: number;
}
export interface RepoOut {
	key: string;
	pr?: string;
	merged: boolean;
}

export const reposOf = (j: Job): RepoOut[] => j.repos.map((r) => ({ key: r.key, ...(r.pr ? { pr: r.pr } : {}), merged: !!r.merged }));
const tagPart = (tag?: Tag) => (tag ? { tag } : {});
export const jobStartPayload = (job: string, title: string, repos: string[], tag?: Tag) => ({ v: 1, job, title, repos, ...tagPart(tag) });
export const jobEndPayload = (job: string, how: "delivered" | "stopped" | "failed", report: string, tag?: Tag, used?: Used, repos?: RepoOut[], reason?: string) => ({ v: 1, job, how, report, ...tagPart(tag), ...(used ? { used } : {}), ...(repos ? { repos } : {}), ...(reason ? { reason } : {}) });
export const approvalPayload = (job: string, category: string, item: string, by: "brief" | "lead", reason: string, tag?: Tag) => ({ v: 1, job, category, item, by, reason, ...tagPart(tag) });
export const jobProgressPayload = (job: string, state: string, round: number, used: Used, tag?: Tag) => ({ v: 1, job, ...tagPart(tag), state, round, used });

// ------------------------------------------------------------------------------------- contract parsers

type Claim = (answer: unknown) => void;
const isObj = (d: unknown): d is Record<string, unknown> => typeof d === "object" && d !== null;
const claimOf = (o: Record<string, unknown>): Claim | undefined => (typeof o.claim === "function" ? (o.claim as Claim) : undefined);

export function parseTag(raw: unknown): Tag | undefined | { error: string } {
	if (raw === undefined) return undefined;
	if (!isObj(raw) || typeof raw.run !== "string" || !raw.run || typeof raw.package !== "string" || !raw.package) return { error: "tag must be {run, package} (non-empty strings)" };
	return { run: raw.run, package: raw.package };
}

export interface DispatchReq {
	brief: string;
	size?: "small" | "normal" | "large";
	tag?: Tag;
	claim?: Claim;
}
/** `relay:dispatch {v:1, brief, size?, tag?, claim}` */
export function parseDispatch(data: unknown): DispatchReq | { error: string; claim?: Claim } {
	if (!isObj(data)) return { error: "relay:dispatch needs an object payload" };
	const claim = claimOf(data);
	const bad = (error: string) => ({ error: `relay:dispatch: ${error}`, claim });
	if (data.v !== 1) return bad("unsupported version (v must be 1)");
	if (typeof data.brief !== "string" || !data.brief.trim()) return bad("brief must be a non-empty string");
	if (data.size !== undefined && data.size !== "small" && data.size !== "normal" && data.size !== "large") return bad('size must be "small", "normal" or "large"');
	const tag = parseTag(data.tag);
	if (tag && "error" in tag) return bad(tag.error);
	return { brief: data.brief, size: data.size as DispatchReq["size"], tag: tag as Tag | undefined, claim };
}

export interface ControlReq {
	job: string;
	action: "stop" | "followup";
	text?: string;
	claim?: Claim;
}
/** `relay:control {v:1, job, action, text?, claim}` */
export function parseControl(data: unknown): ControlReq | { error: string; claim?: Claim } {
	if (!isObj(data)) return { error: "relay:control needs an object payload" };
	const claim = claimOf(data);
	const bad = (error: string) => ({ error: `relay:control: ${error}`, claim });
	if (data.v !== 1) return bad("unsupported version (v must be 1)");
	if (typeof data.job !== "string" || !JOB_ID.test(data.job)) return bad("job must be a job id");
	if (data.action !== "stop" && data.action !== "followup") return bad('action must be "stop" or "followup"');
	if (data.action === "followup" && (typeof data.text !== "string" || !data.text.trim())) return bad("followup needs text");
	return { job: data.job, action: data.action, text: typeof data.text === "string" ? data.text : undefined, claim };
}

/** `relay:job-query {v:1, ids, claim}` */
export function parseJobQuery(data: unknown): { ids: string[]; claim?: Claim } | { error: string; claim?: Claim } {
	if (!isObj(data)) return { error: "relay:job-query needs an object payload" };
	const claim = claimOf(data);
	if (data.v !== 1) return { error: "relay:job-query: unsupported version (v must be 1)", claim };
	if (!Array.isArray(data.ids) || !data.ids.every((x) => typeof x === "string")) return { error: "relay:job-query: ids must be a list of strings", claim };
	return { ids: data.ids as string[], claim };
}

/** `relay:hosted {v:1, on, claim?}` */
export function parseHosted(data: unknown): { on: boolean; claim?: Claim } | { error: string } {
	if (!isObj(data)) return { error: "relay:hosted needs an object payload" };
	if (data.v !== 1) return { error: "relay:hosted: unsupported version (v must be 1)" };
	if (typeof data.on !== "boolean") return { error: "relay:hosted: on must be a boolean" };
	return { on: data.on, claim: claimOf(data) };
}
