// node --experimental-strip-types --test progress.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Progress, formatElapsed, progressLines } from "./progress.ts";

const theme = { fg: (_c: string, s: string) => s } as any;
const fit = (s: string, w: number) => s.slice(0, w);

function setup() {
	const calls: any[][] = [];
	const ui = { setWidget: (...a: any[]) => void calls.push(a) };
	const tui = { renders: 0, requestRender() { this.renders++; } };
	let t = 1000;
	const p = new Progress(ui, "/wt update a", fit, () => t);
	const render = (width = 200) => {
		const factories = calls.filter((c) => typeof c[1] === "function");
		return factories[factories.length - 1][1](tui, theme).render(width) as string[];
	};
	return { calls, p, render, tick: (n: number) => (t += n) };
}

test("formatElapsed formats seconds and minutes", () => {
	assert.equal(formatElapsed(0), "0s");
	assert.equal(formatElapsed(12999), "12s");
	assert.equal(formatElapsed(65000), "1m 05s");
});

test("progressLines without a running call", () => {
	assert.deepEqual(progressLines({ title: "/wt update a", stage: "updating a", startedAt: 0 }, 3000, "⠋"), ["⠋ /wt update a · updating a · 3s"]);
});

test("progressLines with a running call", () => {
	const l = progressLines({ title: "/wt update a", stage: "updating a", startedAt: 0, running: { text: "git fetch origin", cwd: "D:/x/repo", at: 1000 } }, 3000, "⠋");
	assert.equal(l[1], "  git fetch origin · repo · 2s");
});

test("stage mounts once and renders the stage", () => {
	const { calls, p, render } = setup();
	p.stage("a");
	p.stage("b");
	assert.equal(calls.length, 1);
	assert.equal(typeof calls[0][1], "function");
	assert.ok(render()[0].includes("b"));
	p.done();
});

test("wrap shows the running git call and removes it after", async () => {
	const { p, render } = setup();
	p.stage("s");
	let resolve!: (v: any) => void;
	const inner = p.wrap(() => new Promise((r) => (resolve = r)));
	const res = inner("D:/x/repo", ["fetch", "--quiet"]);
	const lines = render();
	assert.equal(lines.length, 2);
	assert.ok(lines[1].includes("git fetch --quiet") && lines[1].includes("repo"));
	resolve({ code: 0, stdout: "ok", stderr: "" });
	assert.deepEqual(await res, { code: 0, stdout: "ok", stderr: "" });
	assert.equal(render().length, 1);
	p.done();
});

test("wrap removes the call when git rejects", async () => {
	const { p, render } = setup();
	p.stage("s");
	const inner = p.wrap(async () => {
		throw new Error("boom");
	});
	await assert.rejects(inner("D:/x/repo", ["fetch"]), /boom/);
	assert.equal(render().length, 1);
	p.done();
});

test("pause hides the widget and restores it", async () => {
	const { calls, p } = setup();
	p.stage("s");
	assert.equal(await p.pause(async () => 42), 42);
	assert.deepEqual(calls.map((c) => typeof c[1]), ["function", "undefined", "function"]);
	p.done();
});

test("pause before any stage does not mount", async () => {
	const { calls, p } = setup();
	assert.equal(await p.pause(async () => 1), 1);
	assert.equal(calls.length, 0);
});

test("done clears and later stage does nothing", () => {
	const { calls, p } = setup();
	p.stage("s");
	p.done();
	p.done();
	p.stage("t");
	assert.deepEqual(calls.map((c) => typeof c[1]), ["function", "undefined"]);
});

test("null ui is a no-op", async () => {
	const p = new Progress(null, "x", fit);
	p.stage("s");
	const r = await p.wrap(async () => ({ code: 0, stdout: "k", stderr: "" }))("d", ["status"]);
	assert.equal(r.stdout, "k");
	assert.equal(await p.pause(async () => 5), 5);
	p.done();
});

test("render fits lines to the width", async () => {
	const { p, render } = setup();
	p.stage("a long stage name");
	const pending = p.wrap(() => new Promise(() => {}))("D:/x/repo", ["fetch"]);
	void pending;
	for (const l of render(10)) assert.ok(l.length <= 10);
	p.done();
});

test("a stale component dispose does not stop the new mount", async () => {
	const { calls, p } = setup();
	const tuiA = { renders: 0, requestRender() { this.renders++; } };
	const tuiB = { renders: 0, requestRender() { this.renders++; } };
	p.stage("s");
	const a = calls[0][1](tuiA, theme);
	await p.pause(async () => 0);
	calls[calls.length - 1][1](tuiB, theme);
	a.dispose();
	await p.wrap(async () => ({ code: 0, stdout: "", stderr: "" }))("d", ["status"]);
	assert.ok(tuiB.renders > 0);
	p.done();
});
