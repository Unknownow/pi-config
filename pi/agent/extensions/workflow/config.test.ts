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

test("the commit role defaults to Haiku", () => {
	assert.deepEqual(DEFAULTS.roles.commit, { model: "claude-bridge/claude-haiku-5-5", thinking: "medium" });
});

test("the shipped workflow.json roles match the defaults", () => {
	const shipped = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "workflow.json"), "utf8"));
	assert.equal("test" in shipped || "test" in shipped.roles, false);
	assert.deepEqual(Object.keys(shipped.roles).sort(), Object.keys(DEFAULTS.roles).sort());
});

test("wait defaults and validation", () => {
	assert.deepEqual(DEFAULTS.wait, { pollMs: 120_000, maxMs: 3_600_000, checkTimeoutMs: 30_000, autoResume: true });
	const g = tmp();
	fs.writeFileSync(g, JSON.stringify({ wait: { pollMs: -1, maxMs: "x", autoResume: "x", checkTimeoutMs: 5000 } }));
	const w = loadConfig(g).config.wait;
	assert.equal(w.pollMs, DEFAULTS.wait.pollMs);
	assert.equal(w.maxMs, DEFAULTS.wait.maxMs);
	assert.equal(w.autoResume, true);
	assert.equal(w.checkTimeoutMs, 5000);
});

test("notify defaults and validation", () => {
	assert.deepEqual(DEFAULTS.notify, { enabled: true, idleMs: 10_000 });
	const g = tmp();
	fs.writeFileSync(g, JSON.stringify({ notify: { enabled: "x", idleMs: -1 } }));
	assert.deepEqual(loadConfig(g).config.notify, { enabled: true, idleMs: 10_000 });
	fs.writeFileSync(g, JSON.stringify({ notify: 5 }));
	assert.deepEqual(loadConfig(g).config.notify, { enabled: true, idleMs: 10_000 });
	fs.writeFileSync(g, JSON.stringify({ notify: { enabled: false, idleMs: 500 } }));
	assert.deepEqual(loadConfig(g).config.notify, { enabled: false, idleMs: 500 });
});

test("autopilot defaults to false", () => {
	assert.equal(loadConfig(tmp()).config.autopilot, false);
});

test("invalid autopilot falls back to false", () => {
	const f = tmp();
	fs.writeFileSync(f, '{"autopilot":"yes"}');
	assert.equal(loadConfig(f).config.autopilot, false);
	fs.writeFileSync(f, '{"autopilot":true}');
	assert.equal(loadConfig(f).config.autopilot, true);
});

test("settings that moved to agents.json are ignored and dropped", () => {
	const f = tmp();
	fs.writeFileSync(f, JSON.stringify({ roles: { explore: { model: "a/b" }, advisor: { model: "a/b" }, runner: { model: "a/b" }, plan: { model: "p/q" } }, explore: { maxQueries: 2 }, advisor: { tools: [] }, test: { concurrency: 9, runnerDeny: ["x"], refails: 3 } }));
	const c = loadConfig(f);
	assert.equal(c.error, undefined);
	const raw = c.config as unknown as Record<string, unknown>;
	assert.equal("explore" in raw || "advisor" in raw, false);
	for (const r of ["explore", "advisor", "runner"]) assert.equal(r in c.config.roles, false, r);
	assert.equal(c.config.roles.plan.model, "p/q");
	assert.equal("test" in raw || "test" in c.config.roles, false);
	assert.deepEqual(c.config.knowledge.roles, ["judge", "arbiter"]);
});

test("addedFolderRules defaults to paths; full is kept, anything else falls back", () => {
	assert.equal(DEFAULTS.addedFolderRules, "paths");
	for (const [v, want] of [["full", "full"], ["x", "paths"]] as const) {
		const f = tmp();
		fs.writeFileSync(f, JSON.stringify({ addedFolderRules: v }));
		assert.equal(loadConfig(f).config.addedFolderRules, want);
	}
});

test("finalFullReviewRepeatMaxShare defaults to 0.1", () => {
	assert.equal(DEFAULTS.judge.finalFullReviewRepeatMaxShare, 0.1);
});

test("discuss defaults", () => {
	const c = loadConfig(tmp()).config;
	assert.equal(c.startPhase, "discuss");
	assert.equal(c.returnTo, "discuss");
	assert.deepEqual(c.roles.discuss, c.roles.plan);
});

test("legacy returnToPlan and invalid values", () => {
	const get = (json: string) => {
		const f = tmp();
		fs.writeFileSync(f, json);
		return loadConfig(f).config;
	};
	// The old boolean is ignored and dropped; so are the removed finalizePlan and planRecap.
	const old = get('{"returnToPlan":false,"finalizePlan":false,"planRecap":"always"}') as unknown as Record<string, unknown>;
	assert.equal(old.returnTo, "discuss");
	for (const k of ["returnToPlan", "finalizePlan", "planRecap"]) assert.ok(!(k in old), k);
	assert.equal(get('{"returnTo":"plan","returnToPlan":false}').returnTo, "plan");
	assert.equal(get('{"returnTo":"bogus"}').returnTo, "discuss");
	assert.equal(get('{"startPhase":"x"}').startPhase, "discuss");
	assert.equal(get('{"startPhase":"plan"}').startPhase, "plan");
});

test("keys of the removed delivery menu and commit step load and are dropped", () => {
	const f = tmp();
	fs.writeFileSync(f, JSON.stringify({ delivery: { ask: true, default: "merge", runner: "main", base: "dev" } }));
	const c = loadConfig(f).config;
	for (const k of ["ask", "default", "runner"]) assert.equal(k in c.delivery, false, k);
	assert.equal(c.delivery.base, "dev");
});

test("minor findings get one fix round by default", () => {
	assert.equal(DEFAULTS.maxMinorRounds, 1);
});

test("the shipped planAllowedTools refuses test_run but admits explore, advisor and judge", () => {
	const shipped = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "..", "workflow.json"), "utf8"));
	const allowed = (name: string) => shipped.planAllowedTools.some((p: string) => new RegExp(p).test(name));
	assert.equal(allowed("test_run"), false);
	for (const n of ["explore", "advisor", "judge"]) assert.equal(allowed(n), true, n);
});
