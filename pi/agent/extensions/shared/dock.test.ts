// node --experimental-strip-types --test dock.test.ts
// The dock: the layout rule, and one owner drawing the one widget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attachDock, currentDockOwner, layoutDock, publishDock, unpublishDock, type DockFns } from "./dock.ts";

const fns: DockFns = {
	visibleWidth: (s) => [...s].length,
	truncate: (s, w, e) => (w <= 0 ? "" : [...s].length <= w ? s : [...s].slice(0, w - [...e].length).join("") + e),
};
const left = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`.padEnd(50, "l"));
const long = ["R".repeat(200)];
const w = (ls: string[]) => ls.map((l) => [...l].length);

test("both sides, width 80: stacked, left then right block, each within the width", () => {
	const out = layoutDock(left(2), long, 80, fns);
	assert.equal(out.length, 3);
	assert.deepEqual(w(out), [50, 50, 80]);
	assert.ok(out[2].endsWith("…"));
});

test("both sides, width 100, 120, 250: R and L from the rule", () => {
	for (const [width, r, l] of [[100, 49, 49], [120, 59, 59], [250, 60, 188]] as const) {
		const out = layoutDock(left(2), [long[0], long[0]], width, fns);
		assert.equal(out.length, 2, `rows at ${width}`);
		for (const row of out) {
			assert.equal([...row].length, width, `row at ${width}`);
			assert.equal(row.slice(0, l).trimEnd().length > 0, true);
			assert.equal(row.slice(l, l + 2), "  ", `gap at ${width}`);
			assert.ok(row.slice(l + 2).endsWith("…") && [...row.slice(l + 2)].length === r, `right column at ${width}`);
		}
	}
	// 50-char left lines are cut to L=49 at width 100
	assert.ok(layoutDock(left(1), long, 100, fns)[0].startsWith("L0" + "l".repeat(46) + "…"));
});

test("left only: full width, no gap; right only: right-aligned in its own width", () => {
	assert.deepEqual(layoutDock(left(2), [], 80, fns).map((l) => [...l].length), [50, 50]);
	assert.deepEqual(layoutDock(left(1), [], 30, fns).map((l) => [...l].length), [30]);
	assert.deepEqual(layoutDock([], ["abc", "abcdef"], 250, fns), [" ".repeat(244) + "abc", " ".repeat(244) + "abcdef"]);
	const cut = layoutDock([], long, 80, fns);
	assert.equal([...cut[0]].length, 80);
	assert.ok(cut[0].endsWith("…"));
	assert.deepEqual(layoutDock([], [], 80, fns), []);
});

test("unequal line counts: the shorter side is blank in the missing rows", () => {
	const out = layoutDock(left(1), ["a", "b", "c"], 250, fns);
	assert.equal(out.length, 3);
	assert.equal(out[1].trim(), "b");
	assert.equal(out[2].trim(), "c");
	const out2 = layoutDock(left(3), ["a"], 250, fns);
	assert.equal(out2.length, 3);
	assert.ok(out2[1].startsWith("L1") && out2[1].trimEnd() === out2[1]);
});

function bus() {
	const h = new Map<string, ((d: unknown) => void)[]>();
	return {
		events: {
			on: (n: string, f: (d: unknown) => void) => {
				h.set(n, [...(h.get(n) ?? []), f]);
				return () => h.set(n, (h.get(n) ?? []).filter((x) => x !== f));
			},
			emit: (n: string, d: unknown) => {
				for (const f of [...(h.get(n) ?? [])]) f(d);
			},
		},
	};
}
function ui() {
	const widgets = new Map<string, { content: any; options: any }>();
	const u = {
		widgets,
		renders: 0,
		setWidget(key: string, content: any, options?: any) {
			if (content === undefined) widgets.delete(key);
			else {
				widgets.set(key, { content, options });
				content({ requestRender: () => u.renders++ });
			}
		},
	};
	return u;
}
const draw = (u: ReturnType<typeof ui>, width = 250) => u.widgets.get("dock")!.content({ requestRender: () => {} }).render(width) as string[];
const reset = () => {
	currentDockOwner()?.release();
};

test("two separately imported copies of dock.ts: one dock widget, whoever attaches last draws", async () => {
	reset();
	const a = (await import("./dock.ts?a")) as typeof import("./dock.ts");
	const b = (await import("./dock.ts?b")) as typeof import("./dock.ts");
	const pi = bus();
	const u = ui();
	const offA = a.attachDock(pi, u, fns);
	const offB = b.attachDock(pi, u, fns);
	a.publishDock(pi, "wt-sessions", "left", ["session one"]);
	b.publishDock(pi, "relay", "right", ["job x working"]);
	assert.equal(u.widgets.size, 1);
	assert.equal(u.widgets.get("dock")!.options.placement, "belowEditor");
	const rows = draw(u);
	assert.equal(rows.length, 1);
	assert.ok(rows[0].startsWith("session one") && rows[0].endsWith("job x working"));
	offA();
	assert.equal(u.widgets.size, 1, "the released copy was no longer the owner");
	offB();
	assert.equal(u.widgets.size, 0);
	reset();
});

test("empty lines clear the widget, new lines set it again; every dock:lines repaints", () => {
	reset();
	const pi = bus();
	const u = ui();
	const off = attachDock(pi, u, fns);
	assert.equal(u.widgets.size, 0);
	publishDock(pi, "relay", "right", ["a"]);
	assert.equal(u.widgets.size, 1);
	const before = u.renders;
	publishDock(pi, "relay", "right", ["b"]);
	assert.equal(u.renders, before + 1);
	assert.deepEqual(draw(u, 80).map((l) => l.trim()), ["b"]);
	publishDock(pi, "relay", "right", []);
	assert.equal(u.widgets.size, 0);
	publishDock(pi, "relay", "right", ["c"]);
	assert.equal(u.widgets.size, 1);
	pi.events.emit("dock:lines", { v: 2, key: "x", side: "left", lines: ["ignored"] });
	assert.equal(draw(u).length, 1);
	off();
	unpublishDock(pi, "relay");
});

test("reload: shutdown, attach again: one widget, producers republish on dock:hello", () => {
	reset();
	const pi = bus();
	const u = ui();
	let off = attachDock(pi, u, fns);
	publishDock(pi, "wt-sessions", "left", ["s1"]);
	assert.equal(u.widgets.size, 1);
	off();
	assert.equal(u.widgets.size, 0);
	assert.equal(currentDockOwner(), undefined);
	off = attachDock(pi, u, fns);
	assert.equal(u.widgets.size, 1, "the producer republished on hello");
	assert.deepEqual(draw(u, 80).map((l) => l.trim()), ["s1"]);
	off();
	unpublishDock(pi, "wt-sessions");
	attachDock(pi, u, fns)();
	assert.equal(u.widgets.size, 0, "an unpublished producer is gone");
});

test("a stale owner that never released is replaced by the next attach", () => {
	reset();
	const pi = bus();
	const u1 = ui();
	const u2 = ui();
	attachDock(pi, u1, fns);
	publishDock(pi, "relay", "right", ["j"]);
	assert.equal(u1.widgets.size, 1);
	const off2 = attachDock(pi, u2, fns);
	assert.equal(u1.widgets.size, 0, "the old owner was released");
	assert.equal(u2.widgets.size, 1, "the new owner got the lines through hello");
	publishDock(pi, "relay", "right", ["k"]);
	assert.equal(u1.widgets.size, 0);
	off2();
	unpublishDock(pi, "relay");
});
