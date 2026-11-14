/** The step contract and what a step may use. A new step is one module plus one entry in the engine's list. */

import type { RelayConfig } from "./config.ts";
import type { Job } from "./job.ts";
import type { Run } from "./sh.ts";
import type { RunOptions, RunResult } from "./subagent.ts";

export type StepName = "dispatch" | "work" | "judge" | "deliver" | "report" | "cleanup";

export interface Step {
	name: StepName;
	/** The next step, "wait" (parked until something resumes the job) or "end". The engine persists `job.state` before each step. */
	run(job: Job, ctx: StepCtx): Promise<StepName | "wait" | "end">;
}

export interface WtRepo {
	top: string;
	cwd: string;
}
export interface WtCreateReply {
	name: string;
	branch: string;
	cwd: string;
	setRoot: string;
	launched: boolean;
	text: string;
	repos: WtRepo[];
}
export interface WtRemoveReply {
	removed: boolean;
	paths: string[];
	backups: string[];
	kept: string[];
	warnings: string[];
}
export interface Wt {
	create(req: { name: string; bases: Record<string, string>; folders?: string[] }): Promise<WtCreateReply | { error: string }>;
	remove(req: { name: string; force?: boolean }): Promise<WtRemoveReply | { error: string }>;
}

export type Shell = (cmd: string, cwd: string, timeoutMs?: number) => Promise<{ code: number; out: string }>;

/** The worker as a step sees it. */
export interface WorkerState {
	alive: boolean;
	/** `agent_settled` seen since the last prompt. */
	settled: boolean;
	exited: boolean;
	/** The summary of a `done` message not yet taken. */
	done?: string;
	/** Prompts sent only to make it call report_done. */
	nudges: number;
	/** Open asks and approvals (answered ones are removed). */
	openAsks: string[];
}

export interface StepCtx {
	dir: string;
	cfg: RelayConfig;
	run: Run;
	shell: Shell;
	/** The current brief text, amendments included. */
	brief(): string;
	save(job: Job): void;
	log(kind: string, text: string): void;
	/** A one-line notice to the lead; never starts a turn. */
	notify(line: string): void;
	/** Starts a turn of the lead (a question, an approval, the cap, a plan flaw, a crash, PASS or delivery). */
	wake(text: string): void;
	isOwner(): boolean;
	wt: Wt;
	worker: WorkerState;
	startWorker(job: Job, o: { prompt: string; resume?: boolean }): Promise<void>;
	/** Sends a prompt to the running worker and clears `settled`. */
	prompt(text: string): Promise<void>;
	stopWorker(): Promise<void>;
	review(role: "critic" | "judge", task: string, cwd: string): Promise<RunResult>;
	emit(name: string, payload: object): void;
	now(): number;
	relayDir: string;
	leadCwd: string;
	folders(): string[];
}

export type { RunOptions };
