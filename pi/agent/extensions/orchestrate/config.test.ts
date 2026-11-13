// node --experimental-strip-types --test config.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BRIDGE, DEFAULTS, loadConfig, parseConfig } from "./config.ts";

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

test("the caps: defaults, and positive integers only", () => {
	assert.deepEqual([DEFAULTS.maxPlanRejections, DEFAULTS.maxReplans, DEFAULTS.maxAutoAnswers, DEFAULTS.maxIdleAnswers], [3, 2, 2, 3]);
	const ok = parseConfig({ maxPlanRejections: 5, maxReplans: 1, maxAutoAnswers: 4, maxIdleAnswers: 6 });
	assert.deepEqual([ok.config.maxPlanRejections, ok.config.maxReplans, ok.config.maxAutoAnswers, ok.config.maxIdleAnswers], [5, 1, 4, 6]);
	const bad = parseConfig({ maxReplans: 0, maxAutoAnswers: "2" });
	assert.equal(bad.config.maxReplans, 2);
	assert.equal(bad.config.maxAutoAnswers, 2);
	assert.match(bad.warning!, /maxReplans, maxAutoAnswers/);
});

const D1 = {
	confirmPlans: true,
	roles: { orchestrator: { model: "claude-bridge/claude-opus-5-5", thinking: "high" }, judge: { model: "claude-bridge/claude-opus-5-5", thinking: "high" } },
	autoJudgeProposal: "auto",
	maxProposalJudgeRounds: 2,
	judge: { tools: ["read", "grep", "find", "ls"], timeoutMs: 900000, idleTimeoutMs: 300000, extensions: ["~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts"] },
};

test("proposal-judge defaults: the bridge only when it exists", () => {
	const yes = parseConfig(undefined, () => true).config;
	const no = parseConfig(undefined, () => false).config;
	assert.deepEqual(yes.judge.extensions, [BRIDGE]);
	assert.deepEqual(no.judge.extensions, []);
	assert.deepEqual(no.roles, {});
	assert.equal(no.autoJudgeProposal, "auto");
	assert.equal(no.maxProposalJudgeRounds, 2);
	assert.deepEqual(no.judge.tools, ["read", "grep", "find", "ls"]);
});

test("the full D1 object parses without a warning; nothing leaks into later calls", () => {
	const r = parseConfig(D1, () => false);
	assert.equal(r.warning, undefined);
	assert.deepEqual(r.config.roles.orchestrator, { model: "claude-bridge/claude-opus-5-5", thinking: "high" });
	assert.deepEqual(r.config.roles.judge, { model: "claude-bridge/claude-opus-5-5", thinking: "high" });
	assert.deepEqual(r.config.judge.extensions, [D1.judge.extensions[0]]);
	const again = parseConfig({}, () => false);
	assert.deepEqual(again.config.roles, {});
	assert.deepEqual(again.config.judge.extensions, []);
	assert.deepEqual(DEFAULTS.roles, {});
});

test("bad new values fall back and are named by key path", () => {
	const cases: [Record<string, unknown>, RegExp][] = [
		[{ roles: { judge: { model: "nope" } } }, /roles\.judge/],
		[{ roles: { orchestrator: { model: "a/b", thinking: "ultra" } } }, /roles\.orchestrator/],
		[{ autoJudgeProposal: "yes" }, /autoJudgeProposal/],
		[{ maxProposalJudgeRounds: 0 }, /maxProposalJudgeRounds/],
		[{ judge: { tools: [] } }, /judge\.tools/],
		[{ judge: { timeoutMs: 0, idleTimeoutMs: -1 } }, /judge\.timeoutMs, judge\.idleTimeoutMs/],
	];
	for (const [raw, re] of cases) {
		const r = parseConfig(raw, () => false);
		assert.match(r.warning!, re);
		assert.deepEqual(r.config.roles, {});
		assert.equal(r.config.maxProposalJudgeRounds, 2);
	}
});

test("roles.orchestrator: false means none; idleTimeoutMs 0 is allowed", () => {
	const r = parseConfig({ roles: { orchestrator: false }, judge: { idleTimeoutMs: 0 } }, () => false);
	assert.equal(r.warning, undefined);
	assert.equal(r.config.roles.orchestrator, undefined);
	assert.equal(r.config.judge.idleTimeoutMs, 0);
});
