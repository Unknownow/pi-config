/** Live rows and result rendering shared by the tools that run subagents (agents and workflow). */

import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type RunView, runLine } from "../shared/runs.ts";

export interface ToolDetails {
	runs: RunView[];
	verdict?: "PASS" | "FAIL";
}

/** Calls `fn` at most every `ms`, always delivering the last call. */
export function throttle(fn: () => void, ms: number): () => void {
	let last = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return () => {
		const wait = last + ms - Date.now();
		if (wait <= 0) {
			last = Date.now();
			fn();
		} else if (!timer) {
			timer = setTimeout(() => {
				timer = undefined;
				last = Date.now();
				fn();
			}, wait);
		}
	};
}

export function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

/** Streams a tool's live rows into its transcript entry. */
export function toolProgress(onUpdate: ((p: { content: { type: "text"; text: string }[]; details: ToolDetails }) => void) | undefined) {
	const runs: RunView[] = [];
	const push = throttle(() => {
		const summary = runs.map((r) => `${r.role} ${r.status}: ${r.activity}`).join("\n");
		onUpdate?.({ content: [{ type: "text", text: summary }], details: { runs: runs.map((r) => ({ ...r })) } });
	}, 150);
	return {
		runs,
		track: (run: RunView) => {
			if (!runs.includes(run)) runs.push(run);
			push();
		},
		snapshot: (): RunView[] => runs.map((r) => ({ ...r })),
	};
}

/** Live rows while running; rows plus the output (or a preview of it) when done. */
export function renderRuns(
	result: { content: { type: string; text?: string }[]; details?: unknown },
	opts: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	previewLines: number,
): Component {
	const details = result.details as ToolDetails | undefined;
	const rows = (details?.runs ?? []).map((r) => runLine(r, theme, { showRole: false }));
	if (opts.isPartial) return new Text(rows.join("\n") || theme.fg("dim", "starting…"), 0, 0);
	const body = textOf(result).trim();
	if (!details) return new Text(theme.fg("toolOutput", body), 0, 0);
	const lines = body.split("\n");
	const shown = opts.expanded || lines.length <= previewLines ? lines : [...lines.slice(0, previewLines), theme.fg("dim", `… ${lines.length - previewLines} more lines (expand to see all)`)];
	const colored = shown.map((l) =>
		/VERDICT:\s*PASS/i.test(l) ? theme.fg("success", theme.bold(l)) : /VERDICT:\s*FAIL/i.test(l) ? theme.fg("error", theme.bold(l)) : /\s-\s*blocker\s*-/i.test(l) ? theme.fg("error", l) : /\s-\s*major\s*-/i.test(l) ? theme.fg("warning", l) : theme.fg("toolOutput", l),
	);
	return new Text([...rows, ...(previewLines > 0 || opts.expanded ? ["", ...colored] : [])].join("\n"), 0, 0);
}
