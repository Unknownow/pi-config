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
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wfcfg-")), "workflow.json");
}

test("missing file gives defaults", () => {
	const f = tmp();
	assert.strictEqual(loadConfig(f).config, DEFAULTS);
	assert.equal(loadConfig(f).error, undefined);
});

test("edit is picked up", () => {
	const f = tmp();
	fs.writeFileSync(f, '{"maxJudgeRounds":3}');
	assert.equal((loadConfig(f).config as unknown as { maxJudgeRounds: number }).maxJudgeRounds, 3);
	fs.writeFileSync(f, '{"maxJudgeRounds":44}');
	assert.equal((loadConfig(f).config as unknown as { maxJudgeRounds: number }).maxJudgeRounds, 44);
});

test("saveRole clears the cache even within the same millisecond", () => {
	const f = tmp();
	fs.writeFileSync(f, "{}");
	loadConfig(f);
	saveRole("judge", { model: "p/x" }, f);
	assert.equal(loadConfig(f).config.roles.judge.model, "p/x");
});

test("unchanged file returns the cached result", () => {
	const f = tmp();
	fs.writeFileSync(f, "{}");
	assert.strictEqual(loadConfig(f), loadConfig(f));
});

test("bad JSON reports an error and uses defaults", () => {
	const f = tmp();
	fs.writeFileSync(f, "{nope");
	const r = loadConfig(f);
	assert.ok(r.error?.includes(f));
	assert.ok(r.config);
});

test("idleTimeoutMs: bad value falls back to the default, 0 is kept", () => {
	const idle = (v: string) => {
		const f = tmp();
		fs.writeFileSync(f, `{"subagent":{"idleTimeoutMs":${v}}}`);
		return loadConfig(f).config.subagent.idleTimeoutMs;
	};
	assert.equal(idle("-1"), 300000);
	assert.equal(idle('"x"'), 300000);
	assert.equal(idle("0"), 0);
	assert.equal(idle("1000"), 1000);
});

test("test block defaults", () => {
	const t = DEFAULTS.test;
	assert.equal(t.concurrency, 4);
	assert.equal(t.maxTasks, 8);
	assert.equal(t.runnerTimeoutMs, 2700000);
	assert.equal(t.maxRounds, 3);
	assert.equal(t.refails, 2);
	assert.equal(t.delivery, "commit");
	assert.deepEqual(DEFAULTS.roles.test, { model: "claude-bridge/claude-opus-5-5", thinking: "medium" });
	assert.deepEqual(DEFAULTS.roles.runner, { model: "claude-bridge/claude-haiku-5-5", thinking: "low" });
});

test("test block validation: bad values fall back, concurrency 1 is kept", () => {
	const f = tmp();
	fs.writeFileSync(f, JSON.stringify({ test: { concurrency: 0, maxTasks: 99, runnerTimeoutMs: 5, refails: 0, delivery: "x", runnerDeny: "str" } }));
	const t = loadConfig(f).config.test;
	assert.equal(t.concurrency, 4);
	assert.equal(t.maxTasks, 8);
	assert.equal(t.runnerTimeoutMs, 2700000);
	assert.equal(t.refails, 2);
	assert.equal(t.delivery, "commit");
	assert.deepEqual(t.runnerDeny, DEFAULTS.test.runnerDeny);
	const g = tmp();
	fs.writeFileSync(g, JSON.stringify({ test: { concurrency: 1, maxRounds: 0 } }));
	assert.equal(loadConfig(g).config.test.concurrency, 1);
	assert.equal(loadConfig(g).config.test.maxRounds, 0);
});

test("the shipped workflow.json test block matches the defaults", () => {
	const shipped = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "workflow.json"), "utf8"));
	assert.deepEqual(shipped.test, DEFAULTS.test);
	assert.deepEqual(shipped.roles.test, DEFAULTS.roles.test);
	assert.deepEqual(shipped.roles.runner, DEFAULTS.roles.runner);
});
