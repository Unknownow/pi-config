// node --experimental-strip-types --test gates.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Finding, type PlanGate, findingText, isClean, isEscKey, menuJudgeLines, parseFindings, planDisputes, planGateAfterVerdict, planGateDecide, planGateReset, planOfferAction, planReadyJudge, planReviewPrompts, planTextDiff, textHash } from "./gates.ts";
import { JUDGE_PLAN, JUDGE_PLAN_RECHECK, NO_SPEC_NOTE } from "./prompts.ts";

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

test("isClean: a PASS with findings is not clean", () => {
	assert.equal(isClean("PASS", []), true);
	assert.equal(isClean("PASS", [f("auto", "minor")]), false);
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
	const base = { mode: "auto" as const, quick: false, planHash: "h2" };
	assert.equal(planGateDecide({ ...base, mode: "off" }), "off");
	assert.equal(planGateDecide({ ...base, quick: true }), "off");
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
});

test("planGateAfterVerdict", () => {
	const o = { verdict: "FAIL", rounds: 1, max: 3, confirm: false };
	assert.equal(planGateAfterVerdict({ ...o, verdict: "PASS", findings: [] }).action, "offer");
	assert.equal(planGateAfterVerdict({ ...o, findings: [f("auto")] }).action, "fix");
	assert.equal(planGateAfterVerdict({ ...o, verdict: "PASS", findings: [f("auto", "minor")] }).action, "fix");
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

test("planReadyJudge", () => {
	const j = planReadyJudge(gate({ autoFindings: [f("auto")], userFindings: [f("user")], rounds: 3 }), true);
	assert.equal(j.ran, true);
	assert.equal(j.verdict, "FAIL");
	assert.equal(j.rounds, 3);
	assert.equal(j.findings.length, 1);
	assert.match(j.userFindings[0], /Why: w/);
	const c = planReadyJudge(gate({ verdict: "cancelled", spec: "none" }), false);
	assert.deepEqual([c.ran, c.verdict, c.spec], [false, "cancelled", "none"]);
	assert.equal(planReadyJudge(gate({ verdict: "error" }), false).verdict, "error");
});

test("planGateReset", () => {
	assert.equal(planGateReset(gate(), "enter-plan"), undefined);
	const r = planGateReset(gate({ rounds: 3, cappedHash: "h1", judgedPlan: "p", autoFindings: [f("auto")] }), "rejected")!;
	assert.deepEqual([r.rounds, r.cappedHash, r.judgedPlan, r.autoFindings.length], [0, undefined, "p", 1]);
	assert.equal(planGateReset(undefined, "rejected"), undefined);
});

test("planReviewPrompts", () => {
	const none = planReviewPrompts({ plan: "P", folders: [] });
	assert.deepEqual(none, [JUDGE_PLAN, NO_SPEC_NOTE, "## Plan under review", "P"]);
	const brief = planReviewPrompts({ plan: "P", spec: { kind: "brief", text: "do X" }, folders: ["/a"] });
	assert.match(brief[1], /the brief[\s\S]*do X/);
	assert.match(brief[2], /\/a/);
	const re = planReviewPrompts({ plan: "P", folders: [], recheck: { findings: [f("auto", "major", "needs caller")], disputes: "Disputes: no", diff: "+new" } });
	assert.equal(re[0], JUDGE_PLAN_RECHECK);
	const all = re.join("\n");
	assert.match(all, /needs caller/);
	assert.match(all, /Disputes: no/);
	assert.match(all, /\+new/);
	assert.equal(re[re.length - 1], "P");
});

test("menuJudgeLines", () => {
	assert.deepEqual(menuJudgeLines(gate({ verdict: "PASS", rounds: 2 })), ["Plan judge: PASS (2 runs)"]);
	const open = menuJudgeLines(gate({ autoFindings: [f("auto")], userFindings: [f("user", "minor", "pick")], cappedHash: "h1", spec: "none" }));
	assert.match(open[0], /1 open finding after the cap/);
	assert.ok(open.includes("Needs your decision:"));
	assert.ok(open.includes("spec: none"));
	assert.deepEqual(menuJudgeLines(undefined, "plan judge cancelled"), ["plan judge cancelled"]);
	assert.equal(menuJudgeLines(gate({ verdict: "cancelled" }), "plan judge did not run: boom")[0], "plan judge did not run: boom");
});

// ---- discussion gate ----
import { type DiscussionReview, discussionGateAfterFixReply, discussionGateAfterVerdict, discussionGateOnInput, discussionGateStart, discussionRecheckPrompts } from "./gates.ts";
import { JUDGE_DISCUSSION, JUDGE_DISCUSSION_RECHECK } from "./prompts.ts";

const rev = (o: Partial<DiscussionReview> = {}): DiscussionReview => ({ listHash: "L1", verdict: "FAIL", findings: [f("auto")], afterEntryId: "e1", rounds: 1, status: "idle", ...o });
const startBase = { mode: "auto" as const, quick: false, listHash: "L2", sinceChars: 100, cap: 30000 };

test("discussionGateStart", () => {
	assert.equal(discussionGateStart({ ...startBase, mode: "off" }), "move");
	assert.equal(discussionGateStart({ ...startBase, quick: true }), "move");
	assert.equal(discussionGateStart({ ...startBase, listHash: undefined }), "warn-move");
	assert.equal(discussionGateStart({ ...startBase, listHash: "L1", last: rev({ verdict: "PASS", findings: [] }) }), "move");
	// a PASS with a minor auto finding on the same hash does not skip
	assert.equal(discussionGateStart({ ...startBase, listHash: "L1", last: rev({ verdict: "PASS", findings: [f("auto", "minor")] }) }), "recheck");
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
	assert.equal(discussionGateAfterVerdict({ ...o, verdict: "PASS", findings: [f("auto", "minor")] }), "fix");
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

test("discussionRecheckPrompts carries findings, since-text and list; the format has fix tags", () => {
	const p = discussionRecheckPrompts([f("auto", "major", "needle")], "SINCE-TEXT", "Agreed so far: NEWLIST", ["D:/x"]).join("\n");
	assert.ok(p.includes(JUDGE_DISCUSSION_RECHECK) && p.includes("needle") && p.includes("SINCE-TEXT") && p.includes("NEWLIST") && p.includes("D:/x"));
	assert.ok(JUDGE_DISCUSSION.includes("fix: auto|user"));
});
