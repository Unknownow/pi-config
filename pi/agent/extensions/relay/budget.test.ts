// node --experimental-strip-types --test budget.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { budgetState, editBudgetProblem, longToolWall, measureEdits, toolTimeoutMs } from "./budget.ts";
import { DEFAULTS, parseConfig } from "./config.ts";
import { run } from "./sh.ts";
import { cleanup, git, makeRepo } from "./test/helpers.ts";

const lim = { lines: 40, files: 3 };

test("edit budget: the 40th line and a 4th file are refused; an already-touched file is not", () => {
	assert.equal(editBudgetProblem({ lines: 39, files: ["/a"] }, "/a", lim), undefined);
	assert.match(editBudgetProblem({ lines: 40, files: ["/a"] }, "/a", lim) ?? "", /relay_dispatch/);
	const three = ["/a", "/b", "/c"];
	assert.equal(editBudgetProblem({ lines: 5, files: three }, "/b", lim), undefined);
	assert.match(editBudgetProblem({ lines: 5, files: three }, "/d", lim) ?? "", /3 of 3 files/);
});

test("measureEdits counts tracked changes and untracked files; a commit resets it", async () => {
	const { dir } = makeRepo();
	fs.writeFileSync(path.join(dir, "a.txt"), "a1\nCHANGED\na3\nnew\n");
	fs.writeFileSync(path.join(dir, "new.txt"), "x\ny\nz\n");
	const m = await measureEdits(run, [dir]);
	assert.equal(m.files.length, 2);
	assert.equal(m.lines, 2 + 1 + 3 /* a.txt: +2 -1, new.txt: 3 */);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "x");
	assert.deepEqual(await measureEdits(run, [dir]), { lines: 0, files: [] });
	cleanup(dir);
});

const base = (used: { wallMs: number; tokens: number }, grace?: { startedAt: number; tokensAt: number }) => ({ budget: { wallMs: 120 * 60_000, tokens: 4_000_000 }, used, grace });

test("budget: ok, then grace on wall time, ending after 30 min", () => {
	assert.equal(budgetState(base({ wallMs: 1, tokens: 1 }), DEFAULTS, 0).state, "ok");
	const g = budgetState(base({ wallMs: 120 * 60_000, tokens: 10 }), DEFAULTS, 1000);
	assert.equal(g.state, "grace");
	if (g.state !== "grace") return;
	assert.deepEqual(g.grace, { startedAt: 1000, tokensAt: 10 });
	assert.equal(budgetState(base({ wallMs: 130 * 60_000, tokens: 10 }, g.grace), DEFAULTS, 1000 + 29 * 60_000).state, "grace");
	assert.equal(budgetState(base({ wallMs: 150 * 60_000, tokens: 10 }, g.grace), DEFAULTS, 1000 + 30 * 60_000).state, "over");
});

test("budget: grace on tokens ends after 10% (400k), whichever comes first", () => {
	const g = budgetState(base({ wallMs: 0, tokens: 4_000_000 }), DEFAULTS, 0);
	assert.equal(g.state, "grace");
	if (g.state !== "grace") return;
	assert.equal(budgetState(base({ wallMs: 0, tokens: 4_399_999 }, g.grace), DEFAULTS, 60_000).state, "grace");
	assert.equal(budgetState(base({ wallMs: 0, tokens: 4_400_000 }, g.grace), DEFAULTS, 60_000).state, "over");
});

test("the long-tool rule raises the wall budget to timeout x 2 + 60 min", () => {
	const cfg = parseConfig({ toolTimeouts: [{ pattern: "unity.*build", minutes: 90 }] }).config;
	const r = longToolWall(cfg, "Verify: run Unity build", 120 * 60_000);
	assert.equal(r?.wallMs, (90 * 2 + 60) * 60_000);
	assert.match(r?.note ?? "", /raised/);
	assert.equal(longToolWall(cfg, "Verify: npm test", 120 * 60_000), undefined);
	assert.equal(longToolWall(parseConfig({ toolTimeouts: [{ pattern: "x", minutes: 10 }] }).config, "x", 120 * 60_000), undefined);
});

test("tool timeouts: bash 60 min, configured patterns their own, others none", () => {
	const cfg = parseConfig({ toolTimeouts: [{ pattern: "unity", minutes: 90 }] }).config;
	assert.equal(toolTimeoutMs(cfg, "bash", { command: "npm test" }), 60 * 60_000);
	assert.equal(toolTimeoutMs(cfg, "bash", { command: "Unity -batchmode" }), 90 * 60_000);
	assert.equal(toolTimeoutMs(cfg, "read", { path: "x" }), 0);
});
