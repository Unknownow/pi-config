// node --experimental-strip-types --test gates.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Finding, PlanGate, DiscussionReview } from "./gates.ts";

// gates.ts reads findings through agents/api.ts, which loads the pi packages: stub them first.
await import("./test-hooks.ts");
const { findingText, forcedOpenFindings, isClean, isEscKey, parseFindings, planCriticRequest, planDisputes, planGateAfterVerdict, planGateDecide, planGateReset, planOfferAction, planTextDiff, textHash, discussionGateAfterFixReply, discussionGateAfterVerdict, discussionGateOnInput, discussionGateStart } = await import("./gates.ts");
const { NO_SPEC_NOTE, PLAN_CRITERIA } = await import("./prompts.ts");

const f = (route: "auto" | "user", severity: Finding["severity"] = "major", head = "x"): Finding => ({ severity, category: "gap", route, head: `${severity} - [gap] fix: ${route} - ${head}`, body: "Why: w\nFix: f" });
const gate = (o: Partial<PlanGate> = {}): PlanGate => ({ planHash: "h1", rounds: 1, verdict: "FAIL", autoFindings: [], userFindings: [], spec: "agreed", ...o });

test("parseFindings: tags, category, body, ignored text", () => {
	const text = `Intro text.
- major - [gap] fix: auto - step 3 misses the caller
  Why: index.ts:10
  Fix: add it
- minor - [fact] FIX: USER - which name?
Why: unknown
- blocker - [risk] no tag here
VERDICT: FAIL
trailing`;
	const r = parseFindings(text);
	assert.equal(r.length, 3);
	assert.deepEqual(r.map((x) => [x.severity, x.category, x.route]), [["major", "gap", "auto"], ["minor", "fact", "user"], ["blocker", "risk", "user"]]);
	assert.equal(r[0].body, "Why: index.ts:10\nFix: add it");
	assert.equal(r[1].body, "Why: unknown");
	assert.equal(r[2].body, "");
	assert.equal(findingText(r[2]), r[2].head);
	assert.deepEqual(parseFindings("nothing\nVERDICT: PASS"), []);
});

test("isClean: a PASS with a blocker or major is not clean; minors are notes", () => {
	assert.equal(isClean("PASS", []), true);
	assert.equal(isClean("PASS", [f("auto", "minor")]), true);
	assert.equal(isClean("PASS", [f("auto", "major")]), false);
	assert.equal(isClean("FAIL", []), false);
});

test("textHash ignores CRLF and outer whitespace", () => {
	assert.equal(textHash("a\r\nb\n"), textHash("  a\nb"));
	assert.notEqual(textHash("a"), textHash("b"));
});

test("planTextDiff", () => {
	assert.equal(planTextDiff("a\nb\nc", "a\nb\nc"), "");
	const d = planTextDiff("a\nb\nc\nd", "a\nB\nc\nd\ne")!;
	assert.match(d, /^-b$/m);
	assert.match(d, /^\+B$/m);
	assert.match(d, /^\+e$/m);
	assert.match(d, /^ a$/m);
	const far = planTextDiff(Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), Array.from({ length: 30 }, (_, i) => (i === 2 || i === 25 ? "X" : `l${i}`)).join("\n"))!;
	assert.match(far, /^@@$/m);
	assert.equal(planTextDiff("a\nb", "c\nd\ne\nf", 3), null);
	const big = Array.from({ length: 2100 }, (_, i) => `l${i}`).join("\n");
	assert.equal(planTextDiff(big, `${big}\nx`), null);
});

test("planDisputes", () => {
	assert.equal(planDisputes("Disputes:\n- finding 1 is wrong: a.ts:3\n\n## Plan: T\nbody"), "Disputes:\n- finding 1 is wrong: a.ts:3");
	assert.equal(planDisputes("## Plan: T\nbody"), undefined);
	assert.equal(planDisputes("Disputes: none held\n"), "Disputes: none held");
});

test("isEscKey", () => {
	assert.equal(isEscKey("\x1b"), true);
	assert.equal(isEscKey("\x1b[27u"), true);
	assert.equal(isEscKey("\x1b[A"), false);
	assert.equal(isEscKey("a"), false);
});

test("planGateDecide", () => {
	const base = { mode: "auto" as const, plan: "P2", planHash: "h2" };
	assert.equal(planGateDecide({ ...base, mode: "off" }), "off");
	assert.equal(planGateDecide({ ...base, gate: gate({ planHash: "h2" }) }), "reuse");
	assert.equal(planGateDecide({ ...base, gate: gate({ planHash: "h2", verdict: "cancelled" }) }), "full");
	assert.equal(planGateDecide({ ...base, gate: gate({ planHash: "h2", verdict: "error" }) }), "full");
	assert.equal(planGateDecide({ ...base, gate: gate({ planHash: "h2", verdict: "cancelled", judgedPlan: "p" }) }), "recheck");
	assert.equal(planGateDecide({ ...base, gate: gate({ cappedHash: "h1", judgedPlan: "p" }) }), "confirm");
	assert.equal(planGateDecide({ ...base, gate: gate({ judgedPlan: "p" }) }), "recheck");
	assert.equal(planGateDecide({ ...base, gate: gate() }), "full");
	// disputes on an unchanged plan
	const same = { ...base, gate: gate({ planHash: "h2", judgedPlan: "p", autoFindings: [f("auto")] }) };
	assert.equal(planGateDecide({ ...same, hasDisputes: true }), "recheck");
	assert.equal(planGateDecide(same), "reuse");
	assert.equal(planGateDecide({ ...same, hasDisputes: true, gate: { ...same.gate, cappedHash: "h2" } }), "reuse");
	assert.equal(planGateDecide({ ...same, hasDisputes: true, gate: { ...same.gate, autoFindings: [], verdict: "PASS" } }), "reuse");
	assert.equal(planGateDecide(base), "full");
	// planTextDiff decides: the same text under another hash is reused; a plan rewritten past the diff cap gets a full review
	assert.equal(planGateDecide({ ...base, plan: "p", gate: gate({ judgedPlan: "p" }) }), "reuse");
	const long = (tag: string) => Array.from({ length: 500 }, (_, i) => `${tag} ${i}`).join("\n");
	assert.equal(planGateDecide({ ...base, plan: long("new"), gate: gate({ judgedPlan: long("old") }) }), "full");
});

test("planGateAfterVerdict", () => {
	const o = { verdict: "FAIL", rounds: 1, max: 3, confirm: false };
	assert.equal(planGateAfterVerdict({ ...o, verdict: "PASS", findings: [] }).action, "offer");
	assert.equal(planGateAfterVerdict({ ...o, findings: [f("auto")] }).action, "fix");
	const minorOnly = planGateAfterVerdict({ ...o, verdict: "PASS", findings: [f("auto", "minor")] });
	assert.deepEqual([minorOnly.action, minorOnly.auto.length, minorOnly.notes.length], ["offer", 0, 1]);
	const onlyUser = planGateAfterVerdict({ ...o, findings: [f("user")] });
	assert.equal(onlyUser.action, "offer");
	assert.equal(onlyUser.user.length, 1);
	const mixed = planGateAfterVerdict({ ...o, findings: [f("auto"), f("user")] });
	assert.equal(mixed.action, "fix");
	assert.deepEqual([mixed.auto.length, mixed.user.length], [1, 1]);
	const cap = planGateAfterVerdict({ ...o, rounds: 3, findings: [f("auto")] });
	assert.deepEqual([cap.action, cap.capped], ["offer", true]);
	assert.equal(planGateAfterVerdict({ ...o, confirm: true, findings: [f("auto")] }).action, "offer");
});

test("planOfferAction", () => {
	assert.equal(planOfferAction({ clean: true, queuedGo: true }), "approve");
	assert.equal(planOfferAction({ clean: false, queuedGo: true }), "offer");
	assert.equal(planOfferAction({ clean: true, queuedGo: false }), "offer");
});

test("planGateReset", () => {
	assert.equal(planGateReset(gate(), "enter-plan"), undefined);
	assert.equal(planGateReset(undefined, "enter-plan"), undefined);
});

test("planCriticRequest: always the whole plan; the agreed list and folders in the criteria; previous findings and disputes on a recheck", () => {
	const none = planCriticRequest({ plan: "P", folders: [] });
	assert.deepEqual(none, { about: "flow plan", document: "P", criteria: `${PLAN_CRITERIA}\n\n${NO_SPEC_NOTE}` });
	const brief = planCriticRequest({ plan: "P", spec: { kind: "agreed", text: "do X" }, folders: ["/a"] });
	assert.match(brief.criteria!, /The agreed list \(the spec\):\n\ndo X/);
	assert.match(brief.criteria!, /- \/a/);
	const findings = [f("auto", "major", "needs caller")];
	const re = planCriticRequest({ plan: "P", folders: [], recheck: { findings, disputes: "Disputes: no" } });
	assert.equal(re.document, "P");
	assert.deepEqual(re.previousFindings, findings);
	assert.equal(re.disputes, "Disputes: no");
	assert.equal("disputes" in planCriticRequest({ plan: "P", folders: [], recheck: { findings } }), false);
});

// ---- discussion gate ----

const rev = (o: Partial<DiscussionReview> = {}): DiscussionReview => ({ listHash: "L1", verdict: "FAIL", findings: [f("auto")], afterEntryId: "e1", rounds: 1, status: "idle", ...o });
const startBase = { mode: "auto" as const, listHash: "L2", sinceChars: 100, cap: 30000 };

test("discussionGateStart", () => {
	assert.equal(discussionGateStart({ ...startBase, mode: "off" }), "move");
	assert.equal(discussionGateStart({ ...startBase, listHash: undefined }), "warn-move");
	assert.equal(discussionGateStart({ ...startBase, listHash: "L1", last: rev({ verdict: "PASS", findings: [] }) }), "move");
	// a PASS with only a minor finding moves on: minors never start another review
	assert.equal(discussionGateStart({ ...startBase, listHash: "L1", last: rev({ verdict: "PASS", findings: [f("auto", "minor")] }) }), "move");
	assert.equal(discussionGateStart({ ...startBase, last: rev() }), "recheck");
	assert.equal(discussionGateStart({ ...startBase, last: rev(), sinceChars: 40000 }), "full");
	assert.equal(discussionGateStart({ ...startBase, last: rev(), sinceChars: Infinity }), "full");
	assert.equal(discussionGateStart({ ...startBase, last: rev({ afterEntryId: undefined }) }), "full");
	assert.equal(discussionGateStart({ ...startBase }), "full");
});

test("discussionGateAfterVerdict", () => {
	const o = { rounds: 1, max: 2 };
	assert.equal(discussionGateAfterVerdict({ ...o, verdict: "PASS", findings: [] }), "move");
	assert.equal(discussionGateAfterVerdict({ ...o, verdict: "FAIL", findings: [f("auto")] }), "fix");
	assert.equal(discussionGateAfterVerdict({ ...o, verdict: "PASS", findings: [f("auto", "minor")] }), "move");
	assert.equal(discussionGateAfterVerdict({ ...o, verdict: "FAIL", findings: [f("auto"), f("user")] }), "pause");
	assert.equal(discussionGateAfterVerdict({ rounds: 2, max: 2, verdict: "FAIL", findings: [f("user")] }), "pause");
	assert.equal(discussionGateAfterVerdict({ rounds: 2, max: 2, verdict: "FAIL", findings: [f("auto")] }), "move-open");
});

test("discussionGateAfterFixReply", () => {
	assert.equal(discussionGateAfterFixReply({ prevListHash: "a", replyListHash: "b", reply: "Agreed so far: x" }), "recheck");
	assert.equal(discussionGateAfterFixReply({ prevListHash: "a", reply: "no list" }), "pause");
	assert.equal(discussionGateAfterFixReply({ prevListHash: "a", replyListHash: "a", reply: "same" }), "pause");
	assert.equal(discussionGateAfterFixReply({ prevListHash: "a", replyListHash: "b", reply: "Which one do you want?" }), "pause");
});

test("discussionGateOnInput", () => {
	assert.equal(discussionGateOnInput({ running: true, isGo: true }), "notice");
	assert.equal(discussionGateOnInput({ running: true, isGo: false }), "cancel");
	assert.equal(discussionGateOnInput({ running: false, isGo: false }), "pass");
});

test("forcedOpenFindings: only the findings of the current list", () => {
	const rev = { listHash: "abc", verdict: "FAIL" as const, findings: [f("auto")], rounds: 1, status: "paused" as const };
	assert.deepEqual(forcedOpenFindings(rev, "abc"), rev.findings);
	assert.deepEqual(forcedOpenFindings(rev, "old"), []);
	assert.deepEqual(forcedOpenFindings(undefined, "abc"), []);
	assert.deepEqual(forcedOpenFindings(rev, ""), []);
});
