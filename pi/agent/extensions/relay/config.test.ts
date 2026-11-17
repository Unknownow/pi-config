// node --experimental-strip-types --test config.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { configPath, DEFAULTS, loadConfig, longToolWarnings, parseConfig, repoPolicy, saveRole, toolTimeoutFor } from "./config.ts";

test("no file or no object gives the defaults", () => {
	assert.deepEqual(parseConfig(undefined).config, DEFAULTS);
	assert.equal(parseConfig(5).warnings.length, 1);
	assert.equal(DEFAULTS.editBudget.lines, 40);
	assert.equal(DEFAULTS.maxJobs, 3);
	assert.equal(DEFAULTS.defaultMerge, "after-pass");
	assert.deepEqual(DEFAULTS.askUser, []);
});

test("relay is off by default; a bad active falls back to false; the default token cap is 8M", () => {
	assert.equal(DEFAULTS.active, false);
	assert.equal(parseConfig({}).config.active, false);
	assert.equal(parseConfig({ active: true }).config.active, true);
	const bad = parseConfig({ active: "yes" });
	assert.equal(bad.config.active, false);
	assert.match(bad.warnings.join("|"), /active: expected a boolean; using false/);
	assert.equal(DEFAULTS.budget.tokens, 8_000_000);
});

test("keys that moved to agents.json are ignored with one warning; relay keeps caps, escalate, worker sizes and the worker's knowledge", () => {
	const r = parseConfig({
		roles: { judge: { model: "q/n" }, critic: { model: "q/c" }, escalate: { model: "p/e", thinking: "high" } },
		reviewer: { extensions: ["/p/provider.ts"] },
		judge: { maxDiffChars: 5000 },
		tokenWeights: { input: 2 },
		knowledge: { server: "kb", roles: ["judge"], judgeCheck: false, tools: ["search"] },
	});
	assert.equal(r.warnings.length, 1, r.warnings.join("|"));
	assert.match(r.warnings[0], /roles\.judge, roles\.critic, reviewer, judge, tokenWeights, knowledge\.roles, knowledge\.judgeCheck: ignored.*agents\.json/);
	const c = r.config as unknown as Record<string, any>;
	assert.equal(c.roles.judge, undefined);
	assert.equal(c.roles.critic, undefined);
	assert.equal(c.reviewer, undefined);
	assert.equal(c.judge, undefined);
	assert.equal(c.tokenWeights, undefined);
	assert.deepEqual(c.knowledge, { server: "kb", tools: ["search"], env: DEFAULTS.knowledge.env });
	assert.deepEqual(c.roles.escalate, { model: "p/e", thinking: "high" });
	assert.deepEqual(c.caps, { critic: 3, judge: 3, escalate: 2, replans: 1 });
	assert.deepEqual(parseConfig({ roles: { escalate: { model: "p/e" } } }).warnings, []);
});

test("the repo's relay.json has no judge, critic, reviewer or tokenWeights keys and is off", () => {
	const repoCfg = new URL("../../relay.json", import.meta.url);
	const raw = JSON.parse(fs.readFileSync(repoCfg, "utf8"));
	assert.equal(raw.active, false);
	assert.equal(raw.roles?.judge, undefined);
	assert.equal(raw.roles?.critic, undefined);
	assert.equal(raw.reviewer, undefined);
	assert.equal(raw.tokenWeights, undefined);
	assert.deepEqual(parseConfig(raw).warnings, []);
});

test("configPath: RELAY_CONFIG wins, else agent dir", () => {
	assert.equal(configPath("/a", { RELAY_CONFIG: "/x/r.json" }), "/x/r.json");
	assert.equal(configPath("/a", {}), path.join("/a", "relay.json"));
});

test("invalid keys fall back with a warning", () => {
	const r = parseConfig({ maxJobs: "x", caps: { judge: -1, critic: 5 }, roles: { escalate: { model: "nonsense" }, worker: { small: { model: "p/m", thinking: "low" } } }, askUser: ["bogus"], defaultMerge: "yes" });
	assert.equal(r.config.maxJobs, 3);
	assert.equal(r.config.caps.judge, 3);
	assert.equal(r.config.caps.critic, 5);
	assert.equal(r.config.roles.escalate.model, DEFAULTS.roles.escalate.model);
	assert.deepEqual(r.config.roles.worker.small, { model: "p/m", thinking: "low" });
	assert.deepEqual(r.config.askUser, []);
	assert.equal(r.config.defaultMerge, "after-pass");
	assert.ok(r.warnings.length >= 5, r.warnings.join("|"));
});

test("a tool timeout longer than the wall budget warns on load", () => {
	const r = parseConfig({ toolTimeouts: [{ pattern: "unity.*build", minutes: 180 }, { pattern: "x", minutes: 5 }] });
	assert.equal(r.warnings.filter((w) => w.includes("unity.*build")).length, 1);
	assert.equal(longToolWarnings(r.config).length, 1);
	assert.equal(toolTimeoutFor(r.config, "run Unity -batchmode build"), 180);
	assert.equal(toolTimeoutFor(r.config, "nothing"), undefined);
});

test("repoPolicy: exact path, glob, owner/name suffix, defaults", () => {
	const c = parseConfig({ repos: { "D:/s/scratch": { merge: "after-pass" }, "D:/work/*": { protectedBranches: ["release"] }, "acme/app": { sensitivePaths: ["x/**"] } } }).config;
	assert.equal(repoPolicy(c, "d:\\s\\scratch").merge, "after-pass");
	assert.deepEqual(repoPolicy(c, "D:/work/foo").protectedBranches, ["release"]);
	assert.deepEqual(repoPolicy(c, "/home/u/acme/app").sensitivePaths, ["x/**"]);
	const d = repoPolicy(c, "/else");
	assert.equal(d.merge, "after-pass");
	assert.deepEqual(d.protectedBranches, ["main", "master"]);
	assert.ok(d.sensitivePaths.includes("**/package.json") && d.sensitivePaths.includes(".github/workflows/**"));
});

test("loadConfig reads a file; a broken file gives defaults and a warning; saveRole keeps other keys", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cfg-"));
	const f = path.join(d, "relay.json");
	assert.deepEqual(loadConfig(f).warnings, []);
	fs.writeFileSync(f, "{bad");
	assert.equal(loadConfig(f).warnings.length, 1);
	fs.writeFileSync(f, JSON.stringify({ maxJobs: 2 }));
	saveRole(f, "worker.normal", { model: "p/m", thinking: "high" });
	saveRole(f, "escalate", { model: "q/n" });
	const c = loadConfig(f).config;
	assert.equal(c.maxJobs, 2);
	assert.deepEqual(c.roles.worker.normal, { model: "p/m", thinking: "high" });
	assert.deepEqual(c.roles.escalate, { model: "q/n" });
	fs.rmSync(d, { recursive: true, force: true });
});

test("worker.extensions is a list of paths", () => {
	const r = parseConfig({ worker: { extensions: ["/p/provider.ts"] } });
	assert.deepEqual(r.config.worker.extensions, ["/p/provider.ts"]);
	const bad = parseConfig({ worker: { extensions: "x" } });
	assert.deepEqual(bad.config.worker.extensions, []);
	assert.equal(bad.warnings.length, 1);
});
