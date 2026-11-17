// node --experimental-strip-types --test discussion-review.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

// discussion-review.ts loads prompts.ts, which reads agents/api.ts: stub the pi packages first.
await import("./test-hooks.ts");
const { discussionCriticRequest, discussionVerdict, lastAgreedList } = await import("./discussion-review.ts");
const { DISCUSSION_CRITERIA } = await import("./prompts.ts");
const { parseFindings } = await import("../agents/api.ts");

test("lastAgreedList: none", () => {
	assert.equal(lastAgreedList(["hello", "world"]), undefined);
});

test("lastAgreedList picks the newest list and starts at its line", () => {
	const r = lastAgreedList(["x\nAgreed so far:\n- old", "intro\nAgreed so far:\n- new\n"]);
	assert.equal(r, "Agreed so far:\n- new");
});

test("lastAgreedList matches bold", () => {
	assert.equal(lastAgreedList(["a\n**Agreed so far:**\n- k"]), "**Agreed so far:**\n- k");
});

test("discussionVerdict", () => {
	assert.equal(discussionVerdict("VERDICT: PASS"), "PASS");
	assert.equal(discussionVerdict("VERDICT: PASS or VERDICT: FAIL"), "FAIL");
	assert.equal(discussionVerdict("nothing"), "FAIL");
});

test("discussionCriticRequest: the agreed list plus the transcript as the document, flow's rules and folders as criteria", () => {
	const a = discussionCriticRequest({ transcript: "T", folders: [] });
	assert.equal(a.about, "flow discussion");
	assert.ok(a.document.includes("No `Agreed so far:` list yet"));
	assert.ok(a.document.endsWith("### Discussion transcript\n\nT"));
	assert.equal(a.criteria, DISCUSSION_CRITERIA);
	assert.equal("previousFindings" in a || "disputes" in a, false);
	const b = discussionCriticRequest({ list: "Agreed so far:\n- x", transcript: "T", folders: ["D:/f"] });
	assert.ok(b.document.startsWith("### Conclusion under review\n\nAgreed so far:\n- x"));
	assert.ok(b.criteria!.startsWith(DISCUSSION_CRITERIA) && b.criteria!.includes("D:/f"));
});

test("discussionCriticRequest on a recheck: the transcript since the last review, the previous findings and the disputes", () => {
	const findings = parseFindings("- major - [gap] `Agreed so far` - no migration fix: auto\n  Why: w");
	const r = discussionCriticRequest({ list: "Agreed so far:\n- y", transcript: "SINCE", folders: [], recheck: { findings }, disputes: "Disputes: the migration is not needed" });
	assert.ok(r.document.endsWith("### Discussion since the last review\n\nSINCE"));
	assert.deepEqual(r.previousFindings, findings);
	assert.equal(r.disputes, "Disputes: the migration is not needed");
});
