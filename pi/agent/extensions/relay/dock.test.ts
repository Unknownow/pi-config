// node --experimental-strip-types --test dock.test.ts
// The relay column of the dock: Engine.dockLines (stream model) and the lead publishing it on dock:lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtElapsed, toolArg, toolSummary } from "./engine.ts";
import { brief, world, type World } from "./test/env.ts";
import { fakeCtx, makeBus, relayOn } from "./test/fake-api.ts";
import { cleanup, makeRepo } from "./test/helpers.ts";

async function start(w: World): Promise<string> {
	const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
	assert.ok("id" in r, JSON.stringify(r));
	return (r as { id: string }).id;
}
const verdict = (round: number, v: "PASS" | "FAIL", b = 1, m = 2, n = 3) => ({ round, briefVersion: 1, verdict: v, blockers: b, majors: m, minors: n });

test("toolArg shortens, toolSummary is unchanged; elapsed formats", () => {
	assert.equal(toolArg({ command: "a  b\nc" }), "a b c");
	assert.equal(toolArg({ command: "x".repeat(100) }).length, 80);
	assert.equal(toolArg({ command: "x".repeat(100) }, Infinity).length, 100);
	assert.equal(toolSummary("bash", { command: "x".repeat(100) }), `bash: ${"x".repeat(77)}...`);
	assert.equal(toolSummary("bash", {}), "bash");
	assert.deepEqual([45_000, 372_000, 3_780_000].map(fmtElapsed), ["45s", "6m12s", "1h03m"]);
	assert.equal(fmtElapsed(59_999), "59s");
});

test("dockLines: header, running and finished tools (newest first, 3 at most), judge phase, verdict line, header-only states", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }] });
		const id = await start(w);
		const jr = w.engine.get(id)!;
		jr.job.state = "working";
		const head = w.engine.widgetLines()[0].replace(/^relay /, "");
		assert.ok(head.startsWith(id));
		assert.deepEqual(w.engine.dockLines(1000), [head]);
		jr.ring = [
			{ id: "1", name: "read", arg: "a.ts", startedAt: 100, endedAt: 150 },
			{ id: "2", name: "edit", arg: "b.ts", startedAt: 200, endedAt: 250 },
			{ id: "3", name: "bash", arg: "npm test", startedAt: 300, endedAt: 350 },
			{ id: "4", name: "bash", arg: "x".repeat(200), startedAt: 400 },
		];
		let lines = w.engine.dockLines(400 + 45_000);
		assert.equal(lines[0], head);
		assert.equal(lines[1], `▸ bash ${"x".repeat(200)} 45s`, "the whole argument: only the dock truncates");
		assert.deepEqual(lines.slice(2), ["· bash npm test", "· edit b.ts", "· read a.ts"]);
		assert.equal(lines.length, 5);
		assert.equal(w.engine.dockLines(400 + 372_000)[1].slice(-5), "6m12s");
		assert.equal(w.engine.dockLines(400 + 3_780_000)[1].slice(-5), "1h03m");
		jr.ring = jr.ring.slice(1); // the model keeps 3; formatting of the finished ones
		assert.deepEqual(w.engine.dockLines(500).slice(2), ["· bash npm test", "· edit b.ts"]);

		// verdict newer than every tool call is shown; the next tool call hides it
		jr.job.lastVerdict = verdict(1, "FAIL");
		jr.verdictAt = 1000;
		lines = w.engine.dockLines(1100);
		assert.equal(lines[1], "judge round 1: FAIL (6 findings)");
		jr.ring.push({ id: "5", name: "read", arg: "c.ts", startedAt: 1200 });
		assert.ok(!w.engine.dockLines(1300).some((l) => l.startsWith("judge round")));
		jr.ring[jr.ring.length - 1].endedAt = 1250;
		assert.ok(!w.engine.dockLines(1300).some((l) => l.startsWith("judge round")), "an ended tool call is newer too");

		// judging: one line; other states: header only
		jr.job.state = "judging";
		jr.job.round = 1;
		assert.deepEqual(w.engine.dockLines(1300), [w.engine.widgetLines()[0].replace(/^relay /, ""), "judge reviewing round 2"]);
		for (const s of ["queued", "paused", "delivering", "critic"] as const) {
			(jr.job as { state: string }).state = s;
			assert.equal(w.engine.dockLines(1300).length, 1, s);
		}
		jr.job.state = "done";
		assert.deepEqual(w.engine.dockLines(1300), [], "finished jobs leave");
		jr.job.state = "working";
		await w.engine.stop(id);
	} finally {
		w.end();
	}
});

test("a real worker tool call lands in the ring and the stream; more than 2 jobs collapse to headers", async () => {
	const w = world();
	try {
		w.write({ worker: [{ tool: { name: "bash", args: { command: "echo hi" }, hang: true }, done: "x" }, { hang: true }] });
		const a = await start(w);
		const t0 = Date.now();
		while (!w.engine.get(a)!.ring.length) {
			if (Date.now() - t0 > 30_000) throw new Error("no tool call seen");
			await new Promise((r) => setTimeout(r, 50));
		}
		const lines = w.engine.dockLines(Date.now());
		assert.ok(lines.some((l) => /^▸ bash echo hi \d+s$/.test(l)), lines.join("|"));
		const b = await start(w);
		const c = await start(w);
		const all = w.engine.dockLines(Date.now());
		assert.equal(all.length, 3, all.join("|"));
		assert.ok([a, b, c].every((id, i) => all[i].startsWith(id)));
		for (const id of [a, b, c]) await w.engine.stop(id);
	} finally {
		w.end();
	}
});

test("the lead attaches the dock at session_start only with a UI, and releases it at session_shutdown", async () => {
	const { dir } = makeRepo();
	try {
		const bus = makeBus();
		const got: any[] = [];
		bus.on("dock:lines", (d) => got.push(d));
		const fns = { visibleWidth: (s: string) => s.length, truncate: (s: string, n: number) => s.slice(0, n) };
		const r = relayOn(bus, dir, { dock: fns, widgetMs: 20 });
		const widgets = new Map<string, unknown>();
		const ctx: any = fakeCtx(dir);
		ctx.ui.setWidget = (k: string, c: unknown) => (c === undefined ? widgets.delete(k) : widgets.set(k, c));
		let hello = 0;
		bus.on("dock:hello", () => hello++);
		await r.hooks.get("session_start")!({}, ctx);
		assert.equal(hello, 1);
		await r.hooks.get("session_shutdown")!({}, ctx);
		assert.equal(widgets.size, 0);
		// no UI: never an owner
		const r2 = relayOn(bus, dir, { dock: fns });
		await r2.hooks.get("session_start")!({}, { ...fakeCtx(dir), hasUI: false });
		assert.equal(hello, 1);
		assert.equal(got.every((g) => g.v === 1 && g.key === "relay" && g.side === "right"), true);
	} finally {
		cleanup(dir);
	}
});

test("the footer shows `relay lead` while lead mode is on and clears it on /relay off and at shutdown", async () => {
	const { dir } = makeRepo();
	try {
		const r = relayOn(makeBus(), dir);
		const status = new Map<string, string>();
		const ctx: any = fakeCtx(dir);
		ctx.ui.setStatus = (k: string, v: string | undefined) => (v === undefined ? status.delete(k) : status.set(k, v));
		assert.equal(await r.lead.leadOn(ctx), true);
		assert.equal(status.get("relay"), "relay lead");
		await r.commands.get("relay")!.handler("off", ctx);
		assert.equal(status.has("relay"), false);
		await r.commands.get("relay")!.handler("on", ctx);
		assert.equal(status.get("relay"), "relay lead");
		await r.hooks.get("session_shutdown")!({}, ctx);
		assert.equal(status.has("relay"), false);
	} finally {
		cleanup(dir);
	}
});
