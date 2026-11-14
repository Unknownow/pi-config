/**
 * The dock: one widget below the editor with two columns. Extensions publish lines on `pi.events` (`dock:lines`), exactly one
 * extension (the owner, elected through a globalThis entry) draws them. Imports nothing from pi, so tests run it as is.
 *
 * Contracts (v1): `dock:lines` `{v, key, side: "left"|"right", lines}` (empty `lines` removes the producer) and `dock:hello` `{v}`
 * (a new owner attached: producers publish their current lines again).
 */

export interface DockFns {
	visibleWidth(s: string): number;
	/** Shortens `s` to `width` columns, ending in `ellipsis` when it was cut. */
	truncate(s: string, width: number, ellipsis: string): string;
}

export type DockSide = "left" | "right";

interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}
interface PiLike {
	events: Bus;
}
interface UiLike {
	setWidget(key: string, content: any, options?: any): void;
}

export const DOCK_KEY = "dock";
const GAP = 2;
const RIGHT_MAX = 60;

/** Lines of the dock for a terminal of `width` columns. Every line fits its column; nothing wraps. */
export function layoutDock(left: string[], right: string[], width: number, fns: DockFns): string[] {
	const cut = (s: string, w: number) => (fns.visibleWidth(s) > w ? fns.truncate(s, w, "…") : s);
	const spaces = (n: number) => " ".repeat(Math.max(0, n));
	const widest = (ls: string[]) => ls.reduce((m, l) => Math.max(m, fns.visibleWidth(l)), 0);
	const rightBlock = (): string[] => {
		const w = Math.min(widest(right), width);
		return right.map((l) => spaces(width - w) + cut(l, w));
	};
	if (!right.length) return left.map((l) => cut(l, width));
	if (!left.length) return rightBlock();
	const r = Math.min(widest(right), RIGHT_MAX, Math.floor((width - GAP) / 2));
	const l = width - r - GAP;
	if (width < 100 || l < 40) return [...left.map((x) => cut(x, width)), ...rightBlock()];
	const out: string[] = [];
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const a = i < left.length ? cut(left[i], l) : "";
		const b = i < right.length ? cut(right[i], r) : "";
		out.push(b ? a + spaces(l - fns.visibleWidth(a)) + spaces(GAP) + b : a);
	}
	return out;
}

interface Owner {
	id: symbol;
	release: () => void;
}
const OWNER = Symbol.for("pi.dock");
const slot = globalThis as unknown as Record<symbol, Owner | undefined>;

/** The owner of the dock right now (tests). */
export const currentDockOwner = (): Owner | undefined => slot[OWNER];

/**
 * Makes this extension the dock owner (the latest with a UI wins; it releases the previous one first) and draws the lines
 * producers publish. Returns the release function; call it at `session_shutdown`.
 */
export function attachDock(pi: PiLike, ui: UiLike, fns: DockFns): () => void {
	const lines = new Map<string, { side: DockSide; lines: string[] }>();
	let tui: { requestRender(): void } | undefined;
	let shown = false;
	let released = false;
	const side = (s: DockSide): string[] => [...lines.values()].filter((e) => e.side === s).flatMap((e) => e.lines);
	const factory = (t: { requestRender(): void }) => {
		tui = t;
		return {
			render: (width: number) => layoutDock(side("left"), side("right"), width, fns),
			invalidate: () => {},
			dispose: () => {
				if (tui === t) tui = undefined;
			},
		};
	};
	const update = () => {
		if (released) return;
		try {
			const any = side("left").length + side("right").length > 0;
			if (!any && shown) {
				shown = false;
				ui.setWidget(DOCK_KEY, undefined);
			} else if (any && !shown) {
				shown = true;
				ui.setWidget(DOCK_KEY, factory, { placement: "belowEditor" });
			}
			tui?.requestRender();
		} catch {
			// a missing or stale UI is fine
		}
	};
	const offLines = pi.events.on("dock:lines", (data) => {
		const d = data as { v?: number; key?: unknown; side?: unknown; lines?: unknown } | null;
		if (!d || d.v !== 1 || typeof d.key !== "string" || (d.side !== "left" && d.side !== "right") || !Array.isArray(d.lines)) return;
		const ls = d.lines.filter((l): l is string => typeof l === "string");
		if (ls.length) lines.set(d.key, { side: d.side, lines: ls });
		else lines.delete(d.key);
		update();
	});
	const id = Symbol("dock-owner");
	const release = () => {
		if (released) return;
		released = true;
		offLines();
		if (shown) {
			try {
				ui.setWidget(DOCK_KEY, undefined);
			} catch {
				// a stale UI is fine
			}
		}
		shown = false;
		if (slot[OWNER]?.id === id) slot[OWNER] = undefined;
	};
	const prev = slot[OWNER];
	if (prev) {
		try {
			prev.release();
		} catch {
			// a broken previous owner must not block this one
		}
	}
	slot[OWNER] = { id, release };
	pi.events.emit("dock:hello", { v: 1 });
	return release;
}

const published = new WeakMap<object, Map<string, { side: DockSide; lines: string[]; off: () => void }>>();

/** Publishes the lines of `key` and publishes them again whenever a new owner says hello. Empty `lines` removes the producer. */
export function publishDock(pi: PiLike, key: string, side: DockSide, lines: string[]): void {
	let m = published.get(pi);
	if (!m) published.set(pi, (m = new Map()));
	let e = m.get(key);
	if (!e) {
		const entry = { side, lines, off: () => {} };
		entry.off = pi.events.on("dock:hello", (data) => {
			if ((data as { v?: number } | null)?.v === 1) pi.events.emit("dock:lines", { v: 1, key, side: entry.side, lines: entry.lines });
		});
		m.set(key, (e = entry));
	}
	e.side = side;
	e.lines = lines;
	pi.events.emit("dock:lines", { v: 1, key, side, lines });
}

/** Stops republishing `key` (at `session_shutdown`) and removes its lines from the dock. */
export function unpublishDock(pi: PiLike, key: string): void {
	const e = published.get(pi)?.get(key);
	if (!e) return;
	e.off();
	published.get(pi)!.delete(key);
	pi.events.emit("dock:lines", { v: 1, key, side: e.side, lines: [] });
}
