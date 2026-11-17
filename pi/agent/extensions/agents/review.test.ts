// node --experimental-strip-types --test review.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import "./test-hooks.ts";

const { criticPrompt, fitDiffs, judgeFiles, judgePrompt, reviewVerdict, runCritic, runJudge } = await import("./review.ts");
const { CRITIC, JUDGE, judgeKnowledgeStep } = await import("./prompts.ts");
const { parseFindings } = await import("../shared/findings.ts");
const { emptyUsage } = await import("./subagent.ts");
const { REVIEWER_EXTENSION } = await import("./run-role.ts");
const { USAGE_FILE_ENV } = await import("./env.ts");
type RunOptions = import("./subagent.ts").RunOptions;

const part = (key: string, full: string, names: string[]) => ({ key, base: "abcdef0123456789", full, names });

test("fitDiffs: all parts when they fit; past the limit the file lists and the smallest diffs that fit", () => {
	const parts = [part("a", "x".repeat(50), ["a1"]), part("b", "y".repeat(10), ["b1", "b2"])];
	const all = fitDiffs(parts, 1000);
	assert.match(all, /### Repo a \(base abcdef0123\)/);
	assert.ok(all.includes("y".repeat(10)) && all.includes("x".repeat(50)));
	const cut = fitDiffs(parts, 20);
	assert.match(cut, /over the limit of 20/);
	assert.match(cut, /- b1\n- b2/);
	assert.ok(cut.includes("y".repeat(10)) && !cut.includes("x".repeat(50)));
});

test("judgeFiles: given files win; else the parts' names, with the repo in front when there are several", () => {
	assert.deepEqual(judgeFiles({ files: ["z"], diff: [part("a", "", ["a1"])] }), ["z"]);
	assert.deepEqual(judgeFiles({ diff: "text" }), []);
	assert.deepEqual(judgeFiles({ diff: [part("D:/r", "", ["a1"])] }), ["a1"]);
	assert.deepEqual(judgeFiles({ diff: [part("D:/r/", "", ["a1"]), part("D:\\s", "", ["b1"])] }), ["D:/r/a1", "D:/s/b1"]);
});

test("judgePrompt: base JUDGE, caller sections after it, the diff in the task; incremental says so", () => {
	const full = judgePrompt({ diff: "DIFF", mode: "full", cwd: ".", criteria: "check X", output: "## Notes", spec: "SPEC", focus: "FOCUS", previousFindings: "- major - [bug] `a:1` - t fix: auto", disputes: "D" }, 1000);
	assert.equal(full.systemPrompts[0], JUDGE);
	assert.match(full.systemPrompts[1], /## Criteria\n\ncheck X/);
	assert.match(full.systemPrompts[2], /after your findings and before the VERDICT line[\s\S]*never change the findings format/i);
	for (const s of ["## Focus\n\nFOCUS", "## Spec\n\nSPEC", "`a:1`", "## Disputes", "## Diff\n\nDIFF"]) assert.ok(full.task.includes(s), s);
	const inc = judgePrompt({ diff: [part("r", "D2", ["f"])], mode: "incremental", cwd: "." }, 1000);
	assert.match(inc.systemPrompts[1], /\[late\]/);
	assert.match(inc.task, /only the change since the last round/);
	assert.match(inc.task, /### Repo r/);
});

test("criticPrompt: base CRITIC, about and document in the task", () => {
	const p = criticPrompt({ document: "DOC", about: "a plan for X", cwd: ".", criteria: "C" });
	assert.equal(p.systemPrompts[0], CRITIC);
	assert.match(p.systemPrompts[1], /## Criteria\n\nC/);
	assert.match(p.task, /## About\n\na plan for X/);
	assert.match(p.task, /## Document\n\nDOC/);
});

test("prompts name no other extension and use the shared findings format", () => {
	for (const text of [JUDGE, CRITIC, judgeKnowledgeStep("knowledge", ["a.ts"])]) {
		assert.doesNotMatch(text, /workflow|\bflow\b|relay|orchestrat/i);
	}
	for (const text of [JUDGE, CRITIC]) {
		assert.ok(text.includes("- blocker|major|minor - [category] `path:line` - one-line title fix: auto|user"));
		assert.match(text, /Why:/);
		assert.match(text, /Fix:/);
		assert.match(text, /\[plan\]/);
		assert.match(text, /VERDICT: PASS`.*VERDICT: FAIL/s);
	}
});

test("a knowledge deviation finding in the knowledge step's form is parsed by parseFindings", () => {
	const step = judgeKnowledgeStep("knowledge", ["src/a.ts"]);
	assert.match(step, /Files to check \(1\):\nsrc\/a\.ts/);
	assert.match(step, /mcp__knowledge__get_rule_pack/);
	const reply = [
		"- minor - [knowledge R12] `src/a.ts:4` - deviation from a recommended rule fix: user",
		"  Rule: use the logger.",
		"  Code: console.log.",
		"  Reason: none given.",
		"  Impact: noise.",
		"  To follow it: call log().",
		"KNOWLEDGE: checked 1 rules (R12); 0 broken",
		"VERDICT: PASS",
	].join("\n");
	const [f] = parseFindings(reply);
	assert.equal(f.severity, "minor");
	assert.equal(f.category, "knowledge R12");
	assert.equal(f.route, "user");
	assert.match(f.body, /Rule: use the logger\.[\s\S]*To follow it: call log\(\)\./);
	assert.equal(reviewVerdict(reply).verdict, "PASS");
});

test("reviewVerdict: a late major does not block; without [late] it equals PASS-and-no-blocker-or-major", () => {
	const major = "- major - [bug] `a:1` - t fix: auto\n  Why: w\n  Fix: f\nVERDICT: PASS";
	assert.equal(reviewVerdict(major).verdict, "FAIL");
	assert.equal(reviewVerdict("- major - [bug][late] `a:1` - t fix: auto\nVERDICT: PASS").verdict, "PASS");
	assert.equal(reviewVerdict("- blocker - [bug][late] `a:1` - t fix: auto\nVERDICT: PASS").verdict, "FAIL");
	assert.equal(reviewVerdict("- minor - [x] `a:1` - t fix: auto\nVERDICT: PASS").verdict, "PASS");
	assert.equal(reviewVerdict("VERDICT: FAIL").verdict, "FAIL");
});

/** A runner stub that records its options and replies `text`. */
function stub(text: string, ok = true) {
	const seen: RunOptions[] = [];
	const runner = async (o: RunOptions) => {
		seen.push(o);
		const usage = { ...emptyUsage(), input: 1000, output: 100 };
		return { ok, text: ok ? text : "", error: ok ? undefined : "boom", model: "claude-sonnet-x", turns: 1, usage, toolCalls: [] };
	};
	return { seen, runner };
}

test("runJudge: read-only reviewer process, knowledge step with mcpServers, event and usage line", async () => {
	const usageFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rv-")), "usage.jsonl");
	process.env[USAGE_FILE_ENV] = usageFile;
	try {
		const { seen, runner } = stub("- minor - [bug] `a.ts:1` - t fix: auto\n  Why: w\n  Fix: f\nVERDICT: PASS");
		const events: [string, Record<string, unknown>][] = [];
		const r = await runJudge({ diff: [part("r", "D", ["a.ts"])], mode: "full", cwd: ".", runner, events: { emit: (n, d) => events.push([n, d as Record<string, unknown>]) }, mcpServers: [{ name: "knowledge", config: { command: "k" } }] });
		assert.equal(r.ok, true);
		assert.equal(r.verdict, "PASS");
		assert.equal(r.findings.length, 1);
		assert.equal(r.model, "claude-sonnet-x");
		assert.equal(r.weightedCost, Math.round((1000 + 500) * 0.6));
		const o = seen[0];
		assert.ok(o.extensions.includes(REVIEWER_EXTENSION));
		assert.deepEqual(o.tools.slice(0, 4), ["read", "grep", "find", "ls"]);
		assert.ok(o.tools.includes("mcp__knowledge__get_rule_pack"));
		assert.ok(o.env?.PI_AGENTS_REVIEW_ALLOW?.split(",").includes("mcp__knowledge__get_rule_pack"));
		assert.ok(o.systemPrompts.some((p) => p.includes("## Knowledge check") && p.includes("Files to check (1):\na.ts")));
		assert.ok(o.mcp?.servers.knowledge);
		assert.equal(events.length, 1);
		assert.equal(events[0][0], "agents:subagent-finished");
		assert.equal(events[0][1].role, "judge");
		assert.equal(events[0][1].weightedCost, r.weightedCost);
		const lines = fs.readFileSync(usageFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.equal(lines.length, 1);
		assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "model", "ok", "role", "usage", "weightedCost"]);
		assert.equal(lines[0].role, "judge");
	} finally {
		delete process.env[USAGE_FILE_ENV];
	}
});

test("runJudge without mcpServers: no knowledge tools, no forward, empty allow list", async () => {
	const { seen, runner } = stub("VERDICT: FAIL");
	const r = await runJudge({ diff: "D", mode: "incremental", cwd: ".", runner });
	assert.equal(r.verdict, "FAIL");
	assert.deepEqual(seen[0].tools, ["read", "grep", "find", "ls"]);
	assert.equal(seen[0].mcp, undefined);
	assert.equal(seen[0].env?.PI_AGENTS_REVIEW_ALLOW, "");
	assert.ok(!seen[0].systemPrompts.some((p) => p.includes("## Knowledge check")));
});

test("runCritic: same shape and verdict rule; a failed run is FAIL with its error", async () => {
	const ok = stub("- major - [plan] `brief` - t fix: user\nVERDICT: PASS");
	const r = await runCritic({ document: "DOC", about: "a brief", cwd: ".", runner: ok.runner });
	assert.equal(r.verdict, "FAIL");
	assert.equal(r.findings[0].category, "plan");
	assert.ok(ok.seen[0].extensions.includes(REVIEWER_EXTENSION));
	const bad = stub("", false);
	const f = await runCritic({ document: "DOC", about: "a brief", cwd: ".", runner: bad.runner });
	assert.equal(f.ok, false);
	assert.equal(f.verdict, "FAIL");
	assert.equal(f.error, "boom");
	for (const k of ["ok", "text", "findings", "verdict", "usage", "weightedCost", "model"]) assert.ok(k in f, k);
});
