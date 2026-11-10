/**
 * Pure logic for quiet-tools: wraps a pi tool definition so finished tool rows render nothing.
 * Only type imports, so tests run without pi installed.
 */

import type { Component } from "@earendil-works/pi-tui";

export interface QuietParts {
	empty(): Component;
	running(toolName: string, args: unknown, theme: unknown, ctx: unknown): Component;
}

/**
 * Wrap `base` with getters for renderShell/renderCall/renderResult (never spread: the getters must survive).
 * The first renderShell read comes from the TUI constructor and must return the base shell, so that the
 * default content box is attached; a wrapper whose renderShell was never read is an export and always delegates.
 */
export function quietDefinition<D extends object>(base: D, isQuiet: () => boolean, parts: QuietParts, toolName: string): D {
	const b = base as any;
	const baseShell = b.renderShell ?? "default";
	let tuiRow = false;
	const hide = () => tuiRow && isQuiet();
	return Object.create(base, {
		renderShell: {
			enumerable: true,
			get() {
				if (b.renderShell === "self") return "self";
				if (!tuiRow) {
					tuiRow = true;
					return baseShell;
				}
				return isQuiet() ? "self" : baseShell;
			},
		},
		renderCall: {
			enumerable: true,
			get() {
				if (!hide()) return b.renderCall;
				return (args: unknown, theme: unknown, ctx: any) => (ctx?.isPartial ? parts.running(toolName, args, theme, ctx) : parts.empty());
			},
		},
		renderResult: {
			enumerable: true,
			get() {
				if (!hide()) return b.renderResult;
				return () => parts.empty();
			},
		},
	}) as D;
}

const KEYS = ["command", "path", "file_path", "pattern", "url", "focus", "question", "step", "code", "queries", "tasks", "done"];

function oneLine(s: string): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function describe(v: unknown): string {
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		if (v.length && v.every((x) => typeof x === "string")) return v.length > 1 ? `${v[0]} (+${v.length - 1})` : v[0];
		if (v.length && v.every((x) => x && typeof x === "object" && "id" in x)) return v.map((x) => String((x as any).id)).join(", ");
	}
	return JSON.stringify(v) ?? "";
}

export function summarizeArgs(args: unknown): string {
	if (typeof args === "string") return oneLine(args);
	if (args && typeof args === "object") {
		const o = args as Record<string, unknown>;
		const key = KEYS.find((k) => o[k] !== undefined) ?? Object.keys(o).find((k) => typeof o[k] === "string");
		if (key) return oneLine(describe(o[key]));
	}
	return oneLine(JSON.stringify(args) ?? "");
}
