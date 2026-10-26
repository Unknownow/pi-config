// node --experimental-strip-types --test view.test.ts
import assert from "node:assert/strict";
import * as os from "node:os";
import { registerHooks } from "node:module";
import { test } from "node:test";

// view.ts imports the pi packages, which are not installed next to the tests.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript,export const getAgentDir = () => " + JSON.stringify(os.tmpdir()), shortCircuit: true };
		if (specifier === "@earendil-works/pi-tui") return { url: "data:text/javascript,export const truncateToWidth = (s) => s", shortCircuit: true };
		return next(specifier, context);
	},
});
const { summaryLines, progressLine, STAGES, emptyStageTokens } = await import("./view.ts");

test("a flow summary saved before the test stage existed still renders, without a test row", () => {
	const stage = () => ({ tokens: { raw: 10, cost: 10 }, main: { raw: 10, cost: 10 }, models: [], subs: {} });
	const old = { ok: true, outcome: "done", stages: { plan: stage(), execute: stage(), judge: stage(), commit: stage() }, steps: [], findings: [] };
	const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
	const lines = summaryLines(old as never, theme as never);
	assert.ok(lines.length > 1);
	assert.ok(!lines.some((l) => l.trim().startsWith("test")));
});

test("progressLine shows stage, bar, current step, judge round and wait", () => {
	const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
	const line = progressLine({ stage: 2, stages: 3, done: 7, total: 10, current: "S8 Add x", judgeRound: 1, waiting: "approval" }, theme as never);
	for (const part of ["stage 2/3", "███████░░░ 7/10", "now S8 Add x", "judge round 1", "waiting: approval"]) assert.ok(line.includes(part), part);
});

test("progressLine omits empty parts and says all steps done", () => {
	const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
	const line = progressLine({ done: 3, total: 3, judgeRound: 0 }, theme as never);
	assert.ok(line.includes("all steps done"));
	for (const part of ["stage", "judge round", "waiting"]) assert.ok(!line.includes(part), part);
});

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const roles = { plan: { model: "p/claude-opus-5-5" }, explore: { model: "claude-bridge/claude-haiku-5-5" }, judge: { model: "claude-bridge/claude-opus-5-5" } } as never;
const w = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
const usage = (input: number, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test("per-model view: two models, sorted by cost, parts name the model", async () => {
	const { FlowView } = await import("./view.ts");
	const v = new FlowView(roles);
	v.weights = w;
	v.mainUsage({ raw: 100, cost: 100 }, true, "claude-opus-5-5", usage(60, 10, 20, 10));
	const run = v.start("explore", "q");
	v.event(run, { type: "usage", usage: usage(500, 50) as never, done: true }, ".");
	v.finish(run, true, "ok");
	const lines = summaryLines(v.peekFlow("done", true), theme as never);
	const model = lines.filter((l) => l.includes("· in "));
	assert.equal(model.length, 2);
	assert.ok(model[0].includes("haiku-5-5 550") && model[1].includes("opus-5-5 100"));
	assert.ok(model[1].includes("in 60 · out 10 · cache read 20 · cache write 10"));
	const plan = lines.find((l) => l.trim().startsWith("plan"))!;
	assert.ok(plan.includes("opus-5-5 100") && plan.includes("explore haiku-5-5 ×1 550"));
	assert.ok(!lines[0].includes("tokens"));
});

test("per-model view: one role on two models gives two parts", async () => {
	const { FlowView } = await import("./view.ts");
	const v = new FlowView(roles);
	v.weights = w;
	for (const model of ["claude-bridge/claude-opus-5-5", "claude-bridge/claude-haiku-5-5"]) {
		const r = v.start("judge", "j", model);
		v.event(r, { type: "usage", usage: usage(10) as never, done: true }, ".");
		v.finish(r, true, "ok");
	}
	const judge = summaryLines(v.peekFlow("done", true), theme as never).find((l) => l.trim().startsWith("judge"))!;
	assert.ok(judge.includes("judge opus-5-5 ×1 10") && judge.includes("judge haiku-5-5 ×1 10"));
});

test("cumulative usage events of one message count once, at the last event", async () => {
	const { FlowView } = await import("./view.ts");
	const v = new FlowView(roles);
	v.weights = w;
	const r = v.start("explore", "q");
	for (const [n, done] of [[10, false], [20, false], [30, true]] as const) v.event(r, { type: "usage", usage: usage(n, n) as never, done }, ".");
	v.finish(r, true, "ok");
	const total = v.peekFlow("done", true).stages.plan.byModel!["haiku-5-5"];
	assert.equal(total.input, 30);
	assert.equal(total.output, 30);
	assert.equal(total.tokens.raw, 60);
});

test("peekFlow adds in-flight tokens under the run's model", async () => {
	const { FlowView } = await import("./view.ts");
	const v = new FlowView(roles);
	v.weights = w;
	const r = v.start("explore", "q");
	v.event(r, { type: "usage", usage: usage(7, 3) as never, done: false }, ".");
	const st = v.peekFlow("x", true).stages.plan;
	assert.equal(st.byModel!["haiku-5-5"].input, 7);
	assert.equal(st.subs.explore!.byModel!["haiku-5-5"].tokens.raw, 10);
	v.finish(r, true, "ok");
	assert.equal(v.peekFlow("x", true).stages.plan.byModel!["haiku-5-5"].input, 7);
});

test("a summary without per-model data renders as before", () => {
	const stage = (main: number) => ({ tokens: { raw: main, cost: main }, main: { raw: main, cost: main }, models: ["claude-opus-5-5"], subs: { explore: { tokens: { raw: 5, cost: 5 }, runs: 2 } } });
	const old = { ok: true, outcome: "done", ended: 1, stages: { plan: stage(10), execute: stage(0), judge: stage(0), commit: stage(0) } };
	const lines = summaryLines(old as never, theme as never);
	assert.ok(lines[0].includes("tokens"));
	assert.ok(lines.find((l) => l.trim().startsWith("plan"))!.includes("opus-5-5 10 · explore ×2 5"));
});

test("discuss is the first stage", () => {
	assert.equal(STAGES[0], "discuss");
	assert.ok("discuss" in emptyStageTokens());
});

const flowLine = (v: unknown) => (v as { render(t: unknown): string[] }).render(theme).find((l) => l.startsWith("flow"))!;

test("flow line hides the commit node when git_task did not run", async () => {
	const { FlowView } = await import("./view.ts");
	const v = new FlowView(roles);
	v.phase = "execute";
	v.stage = "execute";
	const line = flowLine(v);
	assert.ok(line.includes("judge"));
	assert.ok(!line.toLowerCase().includes("commit"));
	assert.ok(!line.trim().endsWith("▸"));
});

test("flow line shows the commit node while git_task runs or after it spent tokens", async () => {
	const { FlowView } = await import("./view.ts");
	const a = new FlowView(roles);
	a.phase = "execute";
	a.stage = "commit";
	assert.ok(flowLine(a).includes("COMMIT"));
	const b = new FlowView(roles);
	b.weights = w;
	b.phase = "execute";
	b.stage = "commit";
	b.mainUsage({ raw: 10, cost: 10 }, true, "claude-opus-5-5", usage(10));
	b.stage = "execute";
	assert.ok(flowLine(b).includes("commit"));
});

test("summary card hides a zero commit row and keeps a used one", () => {
	const stage = (main: number) => ({ tokens: { raw: main, cost: main }, main: { raw: main, cost: main }, models: [], subs: {} });
	const mk = (c: number) => ({ ok: true, outcome: "done", ended: 1, stages: { plan: stage(10), execute: stage(5), judge: stage(1), commit: stage(c) } });
	assert.ok(!summaryLines(mk(0) as never, theme as never).some((l) => l.trim().startsWith("commit")));
	assert.ok(summaryLines(mk(7) as never, theme as never).some((l) => l.trim().startsWith("commit")));
});
