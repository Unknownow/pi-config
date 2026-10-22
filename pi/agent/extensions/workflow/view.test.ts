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
const { summaryLines, progressLine } = await import("./view.ts");

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
