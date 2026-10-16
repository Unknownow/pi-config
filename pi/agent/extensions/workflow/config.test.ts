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
