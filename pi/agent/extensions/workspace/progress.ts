/** Progress widget for /wt commands and the update at session start: stage, running git call and elapsed time. */

import * as path from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Git } from "./git-ops.ts";

export const WIDGET_KEY = "worktree-progress";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ProgressUI {
	setWidget(key: string, content: any, options?: any): void;
}

export interface Running {
	text: string;
	cwd: string;
	at: number;
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function progressLines(s: { title: string; stage: string; startedAt: number; running?: Running }, now: number, frame: string): string[] {
	const lines = [`${frame} ${s.title} · ${s.stage} · ${formatElapsed(now - s.startedAt)}`];
	if (s.running) lines.push(`  ${s.running.text} · ${path.basename(s.running.cwd)} · ${formatElapsed(now - s.running.at)}`);
	return lines;
}

export class Progress {
	private stageText = "";
	private startedAt = 0;
	private started = false;
	private mounted = false;
	private finished = false;
	private tui: TUI | undefined;
	private ticker: ReturnType<typeof setInterval> | undefined;
	private runs: Running[] = [];
	private gen = 0;

	private ui: ProgressUI | null;
	private title: string;
	private fit: (line: string, width: number) => string;
	private now: () => number;

	constructor(ui: ProgressUI | null, title: string, fit: (line: string, width: number) => string, now: () => number = Date.now) {
		this.ui = ui;
		this.title = title;
		this.fit = fit;
		this.now = now;
	}

	stage(text: string): void {
		if (this.finished) return;
		this.stageText = text;
		if (!this.started) {
			this.started = true;
			this.startedAt = this.now();
		}
		if (this.ui && !this.mounted) this.mount();
		else this.tui?.requestRender();
	}

	wrap(git: Git): Git {
		return (cwd, args) => this.track("git " + args.join(" "), cwd, git(cwd, args));
	}

	async track<T>(text: string, cwd: string, p: Promise<T>): Promise<T> {
		const run: Running = { text, cwd, at: this.now() };
		this.runs.push(run);
		this.tui?.requestRender();
		try {
			return await p;
		} finally {
			this.runs = this.runs.filter((r) => r !== run);
			this.tui?.requestRender();
		}
	}

	async pause<T>(f: () => Promise<T>): Promise<T> {
		const was = this.mounted;
		if (was) this.unmount();
		try {
			return await f();
		} finally {
			if (was && !this.finished) this.mount();
		}
	}

	done(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.mounted) this.unmount();
	}

	private mount(): void {
		this.mounted = true;
		const gen = ++this.gen;
		this.ui?.setWidget(WIDGET_KEY, (tui: TUI, theme: Theme): Component & { dispose(): void } => {
			this.tui = tui;
			const myTui = tui;
			if (!this.ticker) {
				this.ticker = setInterval(() => this.tui?.requestRender(), 100);
				this.ticker.unref?.();
			}
			return {
				render: (width: number) => this.render(theme).map((l) => this.fit(l, width)),
				invalidate: () => undefined,
				dispose: () => {
					if (this.gen !== gen || this.tui !== myTui) return;
					this.stopTicker();
					this.tui = undefined;
				},
			};
		});
	}

	private unmount(): void {
		this.mounted = false;
		this.stopTicker();
		this.tui = undefined;
		this.ui?.setWidget(WIDGET_KEY, undefined);
	}

	private stopTicker(): void {
		if (this.ticker) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private render(theme: Theme): string[] {
		const now = this.now();
		const frame = FRAMES[Math.floor((now - this.startedAt) / 100) % FRAMES.length];
		const lines = progressLines({ title: this.title, stage: this.stageText, startedAt: this.startedAt, running: this.runs[this.runs.length - 1] }, now, frame);
		return lines.map((l, i) => (i === 0 ? theme.fg("accent", frame) + l.slice(frame.length) : theme.fg("dim", l)));
	}
}
