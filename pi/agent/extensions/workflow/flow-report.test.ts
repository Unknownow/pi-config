import assert from "node:assert/strict";
import { test } from "node:test";
import { recordFindings, reportFindings, reportLines, type FlowFinding, type ReportFinding } from "./flow-report.ts";

await import("./test-hooks.ts");
const { parseFindings } = await import("../agents/api.ts");

const strip = (l: FlowFinding[]) => l.map((f) => ({ line: f.line, open: f.open }));

test("recordFindings marks findings missing from the next report as fixed (agents' findings format)", () => {
	const a = recordFindings(undefined, undefined, parseFindings("- major - [bug] `a.ts:1` - x fix: auto\n  Why: w\n- minor - [bug] `a.ts:2` - y fix: auto\nVERDICT: FAIL"));
	const before = JSON.stringify(a);
	const b = recordFindings(a, undefined, parseFindings("- minor - [bug] `a.ts:2` - y fix: auto\nVERDICT: PASS"));
	assert.deepEqual(strip(b), [
		{ line: "major - [bug] `a.ts:1` - x fix: auto", open: false },
		{ line: "minor - [bug] `a.ts:2` - y fix: auto", open: true },
	]);
	assert.equal(JSON.stringify(a), before);
});

test("recordFindings keeps other stages untouched and caps at 50", () => {
	let l = recordFindings(undefined, 1, parseFindings("- major - [bug] `a.ts:1` - one"));
	l = recordFindings(l, 2, parseFindings("- major - [bug] `b.ts:1` - two"));
	assert.equal(l.find((f) => f.stage === 1)?.open, true);
	let m: FlowFinding[] | undefined;
	for (let i = 1; i <= 60; i++) m = recordFindings(m, 3, parseFindings(`- minor - [bug] f.ts:${i} - n${i}`));
	assert.equal(m!.length, 50);
	assert.equal(m![49].line, "minor - [bug] f.ts:60 - n60");
});

test("reportFindings marks [plan] findings written into the plan as noted", () => {
	const list: FlowFinding[] = [
		{ line: "minor - [plan] `plan S3` - p", open: true },
		{ line: "minor - [bug] `b.ts:1` - q", open: true },
		{ line: "major - [bug] `c.ts:1` - r", open: false },
	];
	assert.deepEqual(reportFindings(list, "...\n- minor - [plan] `plan S3` - p").map((f) => f.status), ["noted", "open", "fixed"]);
	assert.equal(reportFindings(list, undefined)[0].status, "open");
});

test("reportLines formats steps and findings", () => {
	const findings: ReportFinding[] = [
		{ line: "f1", status: "fixed" },
		{ line: "f2", status: "open" },
		{ line: "f3", status: "noted" },
	];
	const lines = reportLines(
		[
			{ id: "S1", text: "do x\nmore", done: true },
			{ id: "S2", text: "do y", done: false },
		],
		findings,
	);
	assert.deepEqual(lines.map((l) => l.text), [
		"Steps 1/2 done",
		"  ✓ S1 do x",
		"  ○ S2 do y",
		"Findings: 1 open · 1 fixed · 1 noted",
		"  open  f2",
		"  noted f3",
		"  fixed f1",
	]);
	assert.deepEqual(lines.map((l) => l.tone), ["head", "done", "open", "head", "open", "noted", "fixed"]);
});

test("reportLines caps findings at 30 and is empty with nothing to show", () => {
	const many: ReportFinding[] = Array.from({ length: 35 }, (_, i) => ({ line: `f${i}`, status: "open" as const }));
	const lines = reportLines(undefined, many);
	assert.equal(lines.length, 32);
	assert.equal(lines[31].text, "  +5 more");
	assert.deepEqual(reportLines(undefined, []), []);
	const long = reportLines(undefined, [{ line: "x".repeat(150), status: "open" }]);
	assert.equal(long[1].text, `  open  ${"x".repeat(119)}…`);
});

test("reportLines adds the human checks", () => {
	const lines = reportLines(undefined, undefined, [{ id: "S5", text: "play it" }, { text: "look" }]);
	assert.deepEqual(lines, [
		{ text: "Human checks (after the flow): 2", tone: "head" },
		{ text: "  ☐ S5 play it", tone: "human" },
		{ text: "  ☐ look", tone: "human" },
	]);
	assert.deepEqual(reportLines(undefined, undefined), []);
});
