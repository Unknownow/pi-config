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

import { oneGoOnReply, pauseAction } from "./proposal-gate.ts";
import { JUDGE_RELAY_CHECKS } from "./prompts.ts";
import { blockingFindings, parseFindings } from "../shared/findings.ts";

test("one go (relay): a finished proposal starts the gate on its own; fix replies and pauses as before", () => {
	const r = { executor: "relay", mode: "propose", ready: true, running: false } as const;
	assert.equal(oneGoOnReply(r), "gate");
	assert.equal(oneGoOnReply({ ...r, status: "paused", answered: true }), "gate", "after the user's answer the next ready proposal is judged again, no go");
	assert.equal(oneGoOnReply({ ...r, status: "paused", answered: false }), "none", "not before the user answered");
	assert.equal(oneGoOnReply({ ...r, status: "idle" }), "gate");
	assert.equal(oneGoOnReply({ ...r, status: "awaiting-fix" }), "fix-reply");
	assert.equal(oneGoOnReply({ ...r, ready: false }), "none", "a reply that asks the user waits for the answer");
	assert.equal(oneGoOnReply({ ...r, running: true }), "none");
	assert.equal(oneGoOnReply({ ...r, mode: "discuss" }), "none");
	assert.equal(oneGoOnReply({ ...r, mode: "run" }), "none");
	// the workflow executor keeps the two-step go: only the fix reply is automatic
	assert.equal(oneGoOnReply({ ...r, executor: "workflow" }), "none");
	assert.equal(oneGoOnReply({ ...r, executor: "workflow", status: "awaiting-fix" }), "fix-reply");
	assert.equal(pauseAction("relay"), "ask-user");
	assert.equal(pauseAction("workflow"), "wait-go");
});

test("one go (relay): autoJudgeProposal off moves a ready proposal straight to the run", () => {
	assert.equal(proposalGateStart({ mode: "off", hash: "h" }), "move");
	assert.equal(proposalGateStart({ mode: "auto", hash: "h" }), "full");
});

test("relay judge prompt checks Authority, Verify and unstated grants; an unstated grant pauses for the user", () => {
	const p = proposalReviewPrompts({ proposal: "## Packages: x", executor: "relay" });
	assert.ok(p[0].includes(JUDGE_RELAY_CHECKS));
	assert.match(p[0], /Authority/);
	assert.match(p[0], /verify/);
	assert.match(p[0], /did not state is a blocker with fix: user/);
	assert.ok(!proposalReviewPrompts({ proposal: "x" }).join("\n").includes(JUDGE_RELAY_CHECKS), "workflow prompts unchanged");
	assert.ok(proposalReviewPrompts({ proposal: "x", executor: "relay", recheck: [] })[0].includes(JUDGE_RELAY_CHECKS));
	const judged = `- blocker - [authority] fix: user - publish: yes was not stated by the user
  Why: the agreed list says nothing about publishing
  Fix: ask the user or set publish: no
VERDICT: FAIL`;
	const findings = parseFindings(judged);
	assert.equal(blockingFindings(findings)[0].route, "user");
	assert.equal(proposalGateAfterVerdict({ verdict: "FAIL", findings, rounds: 1, max: 2 }), "pause");
	const missing = parseFindings(`- blocker - [authority] fix: auto - no run Authority
  Why: the proposal has no ## Authority
  Fix: add the six lines
VERDICT: FAIL`);
	assert.equal(proposalGateAfterVerdict({ verdict: "FAIL", findings: missing, rounds: 1, max: 2 }), "fix");
	assert.equal(proposalGateAfterVerdict({ verdict: "FAIL", findings: missing, rounds: 2, max: 2 }), "move-open");
});
