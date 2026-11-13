// node --experimental-strip-types --test proposal-gate.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODE_ENTRY } from "./mode.ts";
import { roleOnRestore, roleSwitch, roleWarnText } from "./proposal-gate.ts";

const base = { from: "off", to: "discuss", isSub: false, hasRole: true, hasPrev: false } as const;

test("roleSwitch", () => {
	assert.equal(roleSwitch(base), "apply");
	assert.equal(roleSwitch({ ...base, from: "discuss", to: "propose" }), "none");
	assert.equal(roleSwitch({ ...base, from: "run", to: "off", hasPrev: true }), "restore");
	assert.equal(roleSwitch({ ...base, from: "run", to: "off", hasPrev: false }), "none");
	assert.equal(roleSwitch({ ...base, isSub: true }), "none");
	assert.equal(roleSwitch({ ...base, workflowPhase: "plan" }), "warn");
	assert.equal(roleSwitch({ ...base, workflowPhase: "off" }), "apply");
	assert.equal(roleSwitch({ ...base, hasRole: false }), "none");
	assert.equal(roleSwitch({ ...base, from: "run", to: "off", hasPrev: true, workflowPhase: "execute" }), "warn");
});

test("roleWarnText", () => {
	assert.match(roleWarnText("on", "plan"), /was not switched/);
	const t = roleWarnText("off", "plan", { model: "a/b", thinking: "low" });
	assert.ok(t.includes("/model a/b") && t.includes("thinking low"));
	assert.ok(!roleWarnText("off", "plan").includes("/model"));
});

const entry = (mode: string, prevModel?: unknown) => ({ type: "custom", customType: MODE_ENTRY, data: { v: 1, mode, prevModel } });

test("roleOnRestore", () => {
	const P = { model: "a/b", thinking: "high" };
	assert.deepEqual(roleOnRestore([entry("off"), entry("discuss", P), entry("propose", P)]), P);
	assert.equal(roleOnRestore([entry("discuss", P), entry("off")]), undefined);
	assert.equal(roleOnRestore([entry("discuss")]), undefined);
	assert.equal(roleOnRestore([]), undefined);
});

import { GATE_ENTRY, nextLastProposal, proposalGateAfterFixReply, proposalGateAfterVerdict, proposalGateFromEntries, proposalGateOnInput, proposalGateRounds, proposalGateStart, proposalReviewPrompts, type ProposalReview } from "./proposal-gate.ts";

const fa = { severity: "major", category: "owns", route: "auto", head: "h", body: "Why: x" } as const;
const fu = { ...fa, route: "user" } as const;
const rev = (o: Partial<ProposalReview> = {}): ProposalReview => ({ hash: "h1", verdict: "FAIL", findings: [fa], rounds: 1, status: "idle", ...o });

test("proposalGateStart", () => {
	assert.equal(proposalGateStart({ mode: "off", hash: "h1" }), "move");
	assert.equal(proposalGateStart({ mode: "auto", hash: "h1", last: rev({ verdict: "PASS", findings: [] }) }), "move");
	assert.equal(proposalGateStart({ mode: "auto", hash: "h2", last: rev() }), "recheck");
	assert.equal(proposalGateStart({ mode: "auto", hash: "h1" }), "full");
});

test("proposalGateAfterVerdict", () => {
	const o = { verdict: "FAIL", max: 2 };
	assert.equal(proposalGateAfterVerdict({ verdict: "PASS", findings: [], rounds: 1, max: 2 }), "move");
	assert.equal(proposalGateAfterVerdict({ ...o, findings: [fa], rounds: 1 }), "fix");
	assert.equal(proposalGateAfterVerdict({ ...o, findings: [fa], rounds: 2 }), "move-open");
	assert.equal(proposalGateAfterVerdict({ ...o, findings: [fu], rounds: 2 }), "pause");
});

test("proposalGateAfterFixReply, OnInput, Rounds", () => {
	assert.equal(proposalGateAfterFixReply({ prevHash: "a", ready: true, replyHash: "b" }), "recheck");
	assert.equal(proposalGateAfterFixReply({ prevHash: "a", ready: true, replyHash: "a" }), "pause");
	assert.equal(proposalGateAfterFixReply({ prevHash: "a", ready: false, replyHash: undefined }), "pause");
	assert.equal(proposalGateOnInput({ running: false, isGo: true }), "pass");
	assert.equal(proposalGateOnInput({ running: true, isGo: true }), "notice");
	assert.equal(proposalGateOnInput({ running: true, isGo: false }), "cancel");
	assert.equal(proposalGateRounds({ resetRounds: true, last: rev({ rounds: 2, status: "paused" }) }), 0);
	assert.equal(proposalGateRounds({ resetRounds: false, last: rev({ rounds: 2 }) }), 2);
	assert.equal(proposalGateRounds({ resetRounds: false }), 0);
});

test("proposalReviewPrompts", () => {
	const full = proposalReviewPrompts({ proposal: "PROP", list: "LIST", repoTable: "TABLE" }).join("\n");
	assert.ok(full.includes("LIST") && full.includes("TABLE") && full.includes("PROP") && !full.includes("Previous findings"));
	assert.ok(proposalReviewPrompts({ proposal: "P" }).join("\n").includes("No Agreed so far"));
	const re = proposalReviewPrompts({ proposal: "P", recheck: [fa] }).join("\n");
	assert.ok(re.includes("Previous findings") && re.includes(fa.head));
});

test("proposalGateFromEntries", () => {
	const e = (data: unknown) => ({ type: "custom", customType: GATE_ENTRY, data });
	assert.equal(proposalGateFromEntries([e({ v: 1, ...rev({ status: "awaiting-fix" }) })])?.status, "idle");
	assert.equal(proposalGateFromEntries([e({ v: 1, ...rev({ status: "paused" }) })])?.status, "paused");
	assert.equal(proposalGateFromEntries([e({ junk: 1 })]), undefined);
	assert.equal(proposalGateFromEntries([]), undefined);
});

test("nextLastProposal", () => {
	const body = "## Packages: t\n### a\ngoal";
	assert.equal(nextLastProposal("propose", body, true)?.text, body);
	assert.equal(nextLastProposal("propose", "which one?", true), undefined);
	assert.equal(nextLastProposal("discuss", body, true), undefined);
});
