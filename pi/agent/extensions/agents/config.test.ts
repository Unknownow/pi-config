// node --experimental-strip-types --test config.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerHooks } from "node:module";
import { test } from "node:test";

// config.ts reads the agent folder from the pi package, which is not installed next to the tests.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript,export const getAgentDir = () => " + JSON.stringify(os.tmpdir()), shortCircuit: true };
		return next(specifier, context);
	},
});
const { AGENT_ROLES, DEFAULTS, loadConfig, parseModelCost, saveRole } = await import("./config.ts");
const { costOf, modelMultiplier } = await import("./cost.ts");

function tmp(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agcfg-")), "agents.json");
}

test("no file gives the defaults; explore thinks at medium", () => {
	const c = loadConfig(tmp());
	assert.equal(c.error, undefined);
	assert.deepEqual(c.config, DEFAULTS);
	assert.deepEqual(DEFAULTS.roles.explore, { model: "claude-bridge/claude-haiku-5-5", thinking: "medium" });
	assert.deepEqual(DEFAULTS.knowledge.roles, ["explore", "advisor", "judge", "critic"]);
	for (const r of ["judge", "critic"] as const) assert.deepEqual(DEFAULTS.roles[r], { model: "claude-bridge/claude-opus-5-5", thinking: "medium" });
	assert.deepEqual(DEFAULTS.judge, { tools: ["read", "grep", "find", "ls"], maxDiffChars: 400_000 });
	assert.deepEqual(DEFAULTS.critic, { tools: ["read", "grep", "find", "ls"] });
	assert.deepEqual(DEFAULTS.modelCost, { haiku: 0.2, sonnet: 0.6, opus: 1.0 });
});

test("unknown keys are ignored, known keys override", () => {
	const f = tmp();
	fs.writeFileSync(f, JSON.stringify({ _comment: "x", future: { a: 1 }, roles: { explore: { model: "a/b", thinking: "low" } }, explore: { maxQueries: 3, nope: true } }));
	const c = loadConfig(f).config as unknown as Record<string, unknown> & typeof DEFAULTS;
	assert.equal("future" in c, false);
	assert.deepEqual(c.roles.explore, { model: "a/b", thinking: "low" });
	assert.deepEqual(c.roles.advisor, DEFAULTS.roles.advisor);
	assert.equal(c.explore.maxQueries, 3);
	assert.equal("nope" in c.explore, false);
	assert.equal(c.explore.concurrency, DEFAULTS.explore.concurrency);
});

test("bad values fall back", () => {
	const f = tmp();
	fs.writeFileSync(f, JSON.stringify({ roles: { runner: { model: 5 }, advisor: { model: "a/b", thinking: "loud" } }, explore: { maxQueries: 0, contextFiles: "yes", tools: "x" }, test: { concurrency: 0, maxTasks: 99, runnerTimeoutMs: 5, runnerDeny: "str" }, subagent: { idleTimeoutMs: -1 } }));
	const c = loadConfig(f).config;
	assert.deepEqual(c.roles.runner, DEFAULTS.roles.runner);
	assert.deepEqual(c.roles.advisor, { model: "a/b" });
	assert.equal(c.explore.maxQueries, DEFAULTS.explore.maxQueries);
	assert.equal(c.explore.contextFiles, false);
	assert.deepEqual(c.explore.tools, DEFAULTS.explore.tools);
	assert.equal(c.test.concurrency, 4);
	assert.equal(c.test.maxTasks, 8);
	assert.equal(c.test.runnerTimeoutMs, 2700000);
	assert.deepEqual(c.test.runnerDeny, DEFAULTS.test.runnerDeny);
	assert.equal(c.subagent.idleTimeoutMs, 300000);
});

test("a broken file gives the defaults and an error", () => {
	const f = tmp();
	fs.writeFileSync(f, "{ nope");
	const c = loadConfig(f);
	assert.deepEqual(c.config, DEFAULTS);
	assert.ok(c.error);
});

test("saveRole rewrites one role and keeps the rest of the file", () => {
	const f = tmp();
	fs.writeFileSync(f, JSON.stringify({ explore: { maxQueries: 2 } }));
	saveRole("advisor", { model: "x/y", thinking: "high" }, f);
	const raw = JSON.parse(fs.readFileSync(f, "utf8"));
	assert.deepEqual(raw.roles.advisor, { model: "x/y", thinking: "high" });
	assert.equal(raw.explore.maxQueries, 2);
	assert.deepEqual(loadConfig(f).config.roles.advisor, { model: "x/y", thinking: "high" });
});

test("the shipped agents.json loads to the defaults", () => {
	const c = loadConfig(path.join(import.meta.dirname, "..", "..", "agents.json"));
	assert.equal(c.error, undefined);
	assert.deepEqual(c.config, DEFAULTS);
});

test("AGENT_ROLES has judge and critic, so /agents model judge|critic works", () => {
	assert.ok(AGENT_ROLES.includes("judge") && AGENT_ROLES.includes("critic"));
});

test("modelCost is a free map: keys beyond the defaults are kept; invalid falls back with a warning", () => {
	const f = tmp();
	fs.writeFileSync(f, JSON.stringify({ modelCost: { haiku: 0.1, "gpt-5": 0.8 } }));
	const c = loadConfig(f);
	assert.deepEqual(c.config.modelCost, { haiku: 0.1, "gpt-5": 0.8 });
	assert.equal(c.warning, undefined);
	const g = tmp();
	fs.writeFileSync(g, JSON.stringify({ modelCost: { haiku: -1 } }));
	const d = loadConfig(g);
	assert.deepEqual(d.config.modelCost, DEFAULTS.modelCost);
	assert.match(d.warning ?? "", /modelCost/);
	assert.equal(d.error, undefined);
	assert.ok(parseModelCost([1]).warning);
	assert.ok(parseModelCost({ a: Infinity }).warning);
	assert.deepEqual(parseModelCost(undefined), { table: DEFAULTS.modelCost });
});

test("modelMultiplier: case-insensitive substring, longest key first, no match = 1.0", () => {
	const table = { haiku: 0.2, sonnet: 0.6, opus: 1.0, "my-model": 0.3, "my-model-mini": 0.05 };
	assert.equal(modelMultiplier("claude-bridge/claude-HAIKU-5-5", table), 0.2);
	assert.equal(modelMultiplier("x/My-Model-Mini-2", table), 0.05, "a non-default key, the longest match wins");
	assert.equal(modelMultiplier("x/my-model-2", table), 0.3);
	assert.equal(modelMultiplier("gpt-5", table), 1);
	assert.equal(modelMultiplier(undefined, table), 1);
});

test("costOf: cost-weighted tokens times the multiplier", () => {
	const usage = { input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 0 };
	// 1000 + 100×5 + 10000×0.1 = 2500
	assert.equal(costOf(usage, "claude-sonnet-5", DEFAULTS.modelCost), 1500);
	assert.equal(costOf(usage, "unknown", DEFAULTS.modelCost), 2500);
	assert.equal(costOf(undefined, "opus", DEFAULTS.modelCost), 0);
	assert.equal(costOf(usage, "claude-haiku"), 500, "the table defaults to agents.json");
});
