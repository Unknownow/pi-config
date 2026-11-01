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
const { DEFAULTS, loadConfig, saveRole } = await import("./config.ts");

function tmp(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agcfg-")), "agents.json");
}

test("no file gives the defaults; explore thinks at medium", () => {
	const c = loadConfig(tmp());
	assert.equal(c.error, undefined);
	assert.deepEqual(c.config, DEFAULTS);
	assert.deepEqual(DEFAULTS.roles.explore, { model: "claude-bridge/claude-haiku-5-5", thinking: "medium" });
	assert.deepEqual(DEFAULTS.knowledge.roles, ["explore", "advisor"]);
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
