// node --experimental-strip-types --test config.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULTS, loadConfig, parseConfig } from "./config.ts";

test("defaults", () => {
	assert.deepEqual(parseConfig(undefined), { config: DEFAULTS });
	assert.equal(DEFAULTS.maxSubs, 4);
	assert.equal(DEFAULTS.confirmPlans, false);
});

test("good values are taken, bad ones fall back with a warning", () => {
	const r = parseConfig({ maxSubs: 3, pollSeconds: 0, stallMinutes: 1.5, confirmPlans: "yes", extra: 1, askTimeoutMinutes: 15 });
	assert.equal(r.config.maxSubs, 3);
	assert.equal(r.config.pollSeconds, DEFAULTS.pollSeconds);
	assert.equal(r.config.stallMinutes, DEFAULTS.stallMinutes);
	assert.equal(r.config.confirmPlans, false);
	assert.equal("askTimeoutMinutes" in r.config, false); // an old key is ignored without a warning
	assert.match(r.warning!, /pollSeconds, stallMinutes, confirmPlans/);
	assert.equal(parseConfig({ confirmPlans: true }).config.confirmPlans, true);
	assert.ok(parseConfig([]).warning);
});

test("loadConfig: no file, a file, a corrupt file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cfg-"));
	assert.deepEqual(loadConfig(dir), { config: DEFAULTS });
	fs.writeFileSync(path.join(dir, "orchestrate.json"), '{"maxSubs":2}');
	assert.equal(loadConfig(dir).config.maxSubs, 2);
	fs.writeFileSync(path.join(dir, "orchestrate.json"), "{nope");
	const r = loadConfig(dir);
	assert.equal(r.config.maxSubs, 4);
	assert.ok(r.warning);
});

test("approvePattern: a bad regex falls back with a warning", () => {
	const r = parseConfig({ approvePattern: "(" });
	assert.equal(r.config.approvePattern, DEFAULTS.approvePattern);
	assert.match(r.warning!, /approvePattern/);
	assert.equal(parseConfig({ approvePattern: "^yes$" }).config.approvePattern, "^yes$");
	assert.ok(new RegExp(DEFAULTS.approvePattern, "i").test("ok go"));
});
