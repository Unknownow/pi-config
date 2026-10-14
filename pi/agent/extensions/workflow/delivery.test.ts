// node --test delivery.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName, combineOutcomes, repoDeliveryInstruction, deliveryChoices, freshPr, deliveryInstruction, deliveryMenuLabel, deliveryOutcome, isDelivery, planTitle, type DeliveryOptions } from "./delivery.ts";
import { finalize, planPhase, SHOW_PLAN } from "./prompts.ts";

const d = new Date(2026, 9, 14, 9, 5);
const base: DeliveryOptions = { mode: "commit", branch: "feat", base: "", split: true, mergeMethod: "merge", deleteBranch: true, deviations: "" };

test("choices put the default first", () => {
	assert.deepEqual(deliveryChoices("commit"), ["commit", "push", "pr", "merge", "off"]);
	assert.deepEqual(deliveryChoices("push"), ["push", "commit", "pr", "merge", "off"]);
});

test("isDelivery", () => {
	assert.equal(isDelivery("merge"), true);
	for (const v of ["squash", undefined, 1]) assert.equal(isDelivery(v), false);
});

test("menu label marks the default", () => {
	assert.equal(deliveryMenuLabel("commit", "commit"), "commit only (default)");
	assert.equal(deliveryMenuLabel("push", "commit"), "commit + push");
});

test("planTitle", () => {
	assert.equal(planTitle("## Plan: Per-flow delivery\n1. Goal"), "Per-flow delivery");
	assert.equal(planTitle(undefined), "");
	assert.equal(planTitle("no plan here"), "");
});

test("branchName slugs the title", () => {
	assert.equal(branchName("flow/", "Per-flow delivery (commit / push / PR / merge)", d), "flow/per-flow-delivery-commit-push-pr-merge");
	assert.equal(branchName("flow/", "A".repeat(60), d), `flow/${"a".repeat(40)}`);
	assert.equal(branchName("flow/", `${"a".repeat(39)} bc`, d), `flow/${"a".repeat(39)}`);
	assert.equal(branchName("flow/", "!!!", d), "flow/flow-20261014-0905");
	assert.equal(branchName("my prefix/", "x", d), "myprefix/x");
});

test("commit only, split by function", () => {
	const t = deliveryInstruction(base);
	assert.ok(t.includes("Split them into commits by function"));
	assert.ok(t.includes("Never force-push"));
	for (const no of ["git push", "gh pr", "git switch"]) assert.ok(!t.includes(no), no);
});

test("single commit when not splitting", () => {
	const t = deliveryInstruction({ ...base, split: false });
	assert.ok(t.includes("write a clear message"));
	assert.ok(!t.includes("by function"));
});

test("push", () => {
	const t = deliveryInstruction({ ...base, mode: "push" });
	assert.ok(t.includes("`git push -u origin feat` if it has no upstream"));
	assert.ok(!t.includes("gh pr create"));
});

test("pull request from a protected branch", () => {
	const t = deliveryInstruction({ ...base, mode: "pr", branch: "flow/x", from: "main", base: "main" });
	for (const yes of ["git switch -c flow/x", "git push -u origin flow/x", "gh pr view flow/x --json number,state,url", "gh pr create --head flow/x --base main"]) assert.ok(t.includes(yes), yes);
	assert.ok(!t.includes("gh pr merge <number>"));
});

test("merge deletes the branch by default", () => {
	const m = { ...base, mode: "merge" as const };
	const t = deliveryInstruction(m);
	assert.ok(t.includes("gh pr checks <number> --watch --fail-fast"));
	assert.ok(t.includes("gh pr merge <number> --merge --delete-branch"));
	const keep = deliveryInstruction({ ...m, deleteBranch: false });
	assert.ok(keep.includes("gh pr merge <number> --merge`"));
	assert.ok(!keep.includes("--delete-branch"));
	const bad = deliveryInstruction({ ...m, mergeMethod: "evil; rm" as never });
	assert.ok(bad.includes("--merge"));
	assert.ok(!bad.includes("evil"));
});

test("deviation block", () => {
	const dev = "Knowledge deviations:\n- r1";
	const split = deliveryInstruction({ ...base, deviations: dev });
	assert.ok(split.endsWith(dev));
	assert.ok(split.includes("the commit that holds the code"));
	assert.ok(deliveryInstruction({ ...base, split: false, deviations: dev }).includes("End the commit message body with this block"));
});

test("outcome", () => {
	assert.deepEqual(deliveryOutcome("commit", 2, false, null), { text: "committed (2 commits)", ok: true });
	assert.deepEqual(deliveryOutcome("push", 1, true, null), { text: "committed (1 commit), pushed", ok: true });
	assert.deepEqual(deliveryOutcome("push", 1, false, null), { text: "committed (1 commit), not pushed", ok: false });
	assert.deepEqual(deliveryOutcome("pr", 1, true, { number: 12, state: "OPEN" }), { text: "committed (1 commit), pushed, PR #12 open", ok: true });
	assert.deepEqual(deliveryOutcome("merge", 1, true, { number: 12, state: "OPEN" }), { text: "committed (1 commit), pushed, PR #12 open, not merged", ok: false });
	assert.deepEqual(deliveryOutcome("merge", undefined, true, { number: 12, state: "MERGED" }), { text: "committed, PR #12 merged", ok: true });
	assert.deepEqual(deliveryOutcome("pr", 1, true, { number: 3, state: "CLOSED" }), { text: "committed (1 commit), pushed, no open pull request", ok: false });
});

test("an old merged PR is not this flow's", () => {
	assert.equal(freshPr({ number: 7, state: "MERGED" }, 7), null);
	assert.deepEqual(freshPr({ number: 8, state: "MERGED" }, 7), { number: 8, state: "MERGED" });
	assert.deepEqual(freshPr({ number: 7, state: "OPEN" }, undefined), { number: 7, state: "OPEN" });
	assert.equal(freshPr(null, 7), null);
	assert.deepEqual(deliveryOutcome("merge", 0, false, freshPr({ number: 7, state: "MERGED" }, 7)), { text: "committed (0 commits), not pushed, no open pull request", ok: false });
});

test("final plan asks for commits only when splitting", () => {
	assert.ok(finalize(true).includes("9. Commits:"));
	assert.ok(!finalize(false).includes("9. Commits"));
	assert.ok(finalize(true, "commit + push").includes("### Stage 1:"));
	assert.ok(finalize(true, "commit + push").includes("commit + push"));
	for (const f of [finalize(true), finalize(false)]) {
		assert.ok(f.includes("8. Risks, rollback"));
		assert.ok(f.endsWith("How to write the code is the executor's job."));
		assert.ok(f.includes("Give direction, not implementation."));
		assert.ok(!f.includes("code for non-trivial logic"));
	}
});

test("final plan stages on its own unless onRequest", () => {
	const auto = finalize(true);
	assert.ok(auto.includes("builds on an earlier one"));
	assert.ok(auto.includes("### Stage 1:"));
	assert.ok(auto.includes("its own tests"));
	assert.ok(!auto.includes("in one go, group"));
	const manual = finalize(true, undefined, "onRequest");
	assert.ok(manual.includes("Only when the user asked for the work to be delivered in parts"));
	assert.ok(manual.includes("### Stage 1:"));
	assert.ok(!manual.includes("builds on an earlier one"));
	for (const f of [auto, manual]) assert.ok(f.endsWith("How to write the code is the executor's job."));
});

test("planner proposes stages unless onRequest", () => {
	const auto = planPhase(true);
	assert.ok(auto.includes("Staged delivery") && auto.includes("Propose stages yourself"));
	assert.ok(!auto.includes("### Stage 1:"));
	const manual = planPhase(true, "onRequest");
	assert.ok(manual.includes("Staged delivery") && !manual.includes("Propose stages yourself"));
	assert.ok(planPhase(false).includes("### Stage 1:"));
	assert.ok(planPhase(false, "onRequest").includes("### Stage 1:"));
});

test("planner repeats only plan changes unless always", () => {
	const d = planPhase(true);
	assert.ok(d.includes("don't repeat it") && d.includes("only the changes") && !d.includes("(the plan so far)"));
	const a = planPhase(true, "auto", "always");
	assert.ok(a.includes("(the plan so far)") && !a.includes("don't repeat it"));
	const n = planPhase(false);
	assert.ok(n.includes("(the plan so far)") && !n.includes("don't repeat it"));
});

test("show plan message", () => {
	assert.ok(SHOW_PLAN.includes("whole current plan") && SHOW_PLAN.includes("Plan:"));
});

test("repoDeliveryInstruction lists each repo", () => {
	const t = repoDeliveryInstruction([
		{ root: "D:/a", options: { ...base, mode: "push", branch: "feat" } },
		{ root: "D:/b", options: { ...base, mode: "push", branch: "feat-2" } },
	]);
	assert.ok(t.startsWith("The judge passed. The change spans 2 repositories"));
	const a = t.indexOf("### Repository `D:/a`");
	const b = t.indexOf("### Repository `D:/b`");
	assert.ok(a >= 0 && b > a);
	assert.ok(t.includes("git -C D:/b"));
	assert.ok(t.indexOf("feat-2") > b);
	assert.equal(t.split("The judge passed.").length - 1, 1);
});

test("combineOutcomes", () => {
	assert.deepEqual(combineOutcomes([{ name: "a", outcome: null }, { name: "b", outcome: null }]), { text: "commit step ended without a commit", ok: false });
	assert.deepEqual(combineOutcomes([{ name: "a", outcome: { text: "committed (1 commit)", ok: true } }, { name: "b", outcome: null }]), { text: "a: committed (1 commit); b: no commit", ok: false });
	assert.equal(combineOutcomes([{ name: "a", outcome: { text: "x", ok: true } }, { name: "b", outcome: { text: "y", ok: true } }]).ok, true);
});
