/** Relay's lead-mode activation: relay.json `active` (the default, off unless set), `/relay on`, `RELAY_ROLE` and job-set detection. Relay and flow are switched by hand; they do not ask each other. */

import * as fs from "node:fs";
import * as path from "node:path";

/** True when `cwd` or a parent folder holds a `.pi-set.json`: any worktree set, a job's or a user's. */
export function inAnySet(cwd: string): boolean {
	let dir = path.resolve(cwd);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".pi-set.json"))) return true;
		const up = path.dirname(dir);
		if (up === dir) return false;
		dir = up;
	}
}

export const SET_REASON = "relay: this session is inside a worktree set; lead mode off (run the lead from the main checkouts)";

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

	get inSet(): boolean {
		return inAnySet(this.d.cwd);
	}

	/** Lead mode can still come on: not a worker or reviewer, relay.json active, not a job's worktree. */
	eligible(): boolean {
		return !this.d.role && this.d.active() && !this.inSet;
	}

	/** Decides once; true when lead mode is on. */
	decide(): Promise<boolean> {
		if (this.mode === "undecided") {
			if (this.d.role) this.set("off", "a relay worker or reviewer process");
			else if (!this.d.active()) this.set("off", "relay is off by default; /relay on turns it on");
			else if (this.inSet) this.set("off", SET_REASON);
			else this.set("on", "");
		}
		return Promise.resolve(this.mode === "on");
	}

	private set(mode: Mode, reason: string) {
		this.mode = mode;
		this.reason = reason;
	}

	/** `/relay on`: turns lead mode on for this session whatever relay.json `active` says; refused for workers and inside any worktree set. */
	async turnOn(): Promise<{ ok: true } | { ok: false; why: string }> {
		if (this.d.role) return { ok: false, why: "relay workers do not run a lead" };
		if (this.inSet) return { ok: false, why: SET_REASON };
		this.set("on", "");
		return { ok: true };
	}

	turnOff(): void {
		this.set("off", "relay off");
	}
}
