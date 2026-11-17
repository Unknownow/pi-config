/** Relay's lead-mode activation: relay.json `active` (the default, off unless set), `/relay on`, `RELAY_ROLE` and job-set detection. Relay and flow are switched by hand; they do not ask each other. */

import * as fs from "node:fs";
import * as path from "node:path";
import { JOB_ID } from "./job.ts";

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
	/** relay.json `active`: whether lead mode starts on (default false; `/relay on` turns it on anyway). */
	active: () => boolean;
	cwd: string;
	role: string | undefined;
}

/** Lead mode: decided lazily and once. */
export class Activation {
	mode: Mode = "undecided";
	/** Why lead mode is off, for a notice. */
	reason = "";
	private readonly d: ActivationDeps;

	constructor(d: ActivationDeps) {
		this.d = d;
	}

	get jobSet(): boolean {
		return inJobSet(this.d.cwd);
	}

	/** Lead mode can still come on: not a worker or reviewer, relay.json active, not a job's worktree. */
	eligible(): boolean {
		return !this.d.role && this.d.active() && !this.jobSet;
	}

	/** Decides once; true when lead mode is on. */
	decide(): Promise<boolean> {
		if (this.mode === "undecided") {
			if (this.d.role) this.set("off", "a relay worker or reviewer process");
			else if (!this.d.active()) this.set("off", "relay is off by default; /relay on turns it on");
			else if (this.jobSet) this.set("off", "relay: this is a job's worktree; lead mode off");
			else this.set("on", "");
		}
		return Promise.resolve(this.mode === "on");
	}

	private set(mode: Mode, reason: string) {
		this.mode = mode;
		this.reason = reason;
	}

	/** `/relay on`: turns lead mode on for this session whatever relay.json `active` says; refused for workers and job worktrees. */
	async turnOn(): Promise<{ ok: true } | { ok: false; why: string }> {
		if (this.d.role) return { ok: false, why: "relay workers do not run a lead" };
		if (this.jobSet) return { ok: false, why: "this is a job's worktree" };
		this.set("on", "");
		return { ok: true };
	}

	turnOff(): void {
		this.set("off", "relay off");
	}
}
