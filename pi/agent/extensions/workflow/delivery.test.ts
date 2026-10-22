// node --test delivery.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName, combineOutcomes, repoDeliveryInstruction, deliveryChoices, freshPr, deliveryInstruction, deliveryMenuLabel, fixedDeliveryLabel, deliveryOutcome, isDelivery, landedBranch, outcomeRef, planTitle, pushSkipReason, type DeliveryOptions } from "./delivery.ts";
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

test("fixed label explains the single option", () => {
	assert.equal(fixedDeliveryLabel("commit", "autopilot"), "commit only (autopilot · /flow delivery to change)");
	assert.equal(fixedDeliveryLabel("commit", "ask-off"), "commit only (delivery.ask off · /flow delivery to change)");
	assert.equal(fixedDeliveryLabel("merge", "flow"), "commit + push + pull request + merge (set for this flow · /flow delivery to change)");
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
	for (const no of ["git push -u", "Then push", "gh pr", "git switch"]) assert.ok(!t.includes(no), no);
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
	assert.ok(t.includes("gh pr checks <number> --watch --fail-fast --interval 5"));
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

test("instruction asks to chain steps", () => {
	const c = deliveryInstruction(base);
	assert.ok(c.includes("Use as few tool calls as you can"));
	assert.ok(!c.includes("Run the push and any pull request commands"));
	for (const mode of ["push", "pr", "merge"] as const) {
		const t = deliveryInstruction({ ...base, mode });
		assert.ok(t.includes("Use as few tool calls as you can"), mode);
		assert.ok(t.includes("Run the push and any pull request commands"), mode);
	}
});

test("deliveryOutcome says the PR state is unknown when gh can't run", () => {
	assert.deepEqual(deliveryOutcome("merge", undefined, true, null, true), { text: "committed, pushed, pull request state unknown (gh not found)", ok: false });
	assert.deepEqual(deliveryOutcome("merge", 1, true, { number: 5, state: "MERGED" }, true), { text: "committed (1 commit), PR #5 merged", ok: true });
	assert.deepEqual(deliveryOutcome("pr", 1, true, null), { text: "committed (1 commit), pushed, no open pull request", ok: false });
});

test("committed delivery pushes without committing again", () => {
	const t = deliveryInstruction({ ...base, mode: "pr", committed: true, deviations: "x" });
	assert.match(t, /already committed on/);
	assert.match(t, /don't commit again/);
	assert.match(t, /gh pr create/);
	assert.match(t, /Never force-push/);
	assert.doesNotMatch(t, /Commit exactly the reviewed changes/);
	assert.doesNotMatch(t, /git add <paths> && git commit/);
	assert.doesNotMatch(t, /End the commit message body/);
	assert.doesNotMatch(deliveryInstruction({ ...base, mode: "commit", committed: true }), /Then push/);
	assert.match(repoDeliveryInstruction([{ root: "r", options: { ...base, mode: "push", committed: true } }]), /already committed/);
});

test("pushSkipReason", () => {
	assert.equal(pushSkipReason(""), "HEAD is detached");
	assert.equal(pushSkipReason("HEAD"), "HEAD is detached");
	assert.equal(pushSkipReason("master"), "master is protected");
});

test("commit mode names a skipped push", () => {
	const t = deliveryInstruction({ ...base, pushSkipped: "master is protected" });
	assert.ok(t.includes("Don't push: master is protected, so this flow only commits. Say so in your report."));
	assert.ok(!t.includes("git push -u") && !t.includes("Then push"));
	assert.ok(!deliveryInstruction(base).includes("Don't push"));
});

test("outcome names a skipped push", () => {
	assert.deepEqual(deliveryOutcome("commit", 1, false, null, false, "master is protected"), { text: "committed (1 commit), push skipped: master is protected", ok: true });
	assert.deepEqual(deliveryOutcome("push", 1, true, null, false, "x"), { text: "committed (1 commit), pushed", ok: true });
});

test("outcomeRef uses the branch the commits landed on", () => {
	assert.equal(outcomeRef({ recorded: "master", recordedMoved: false, current: "feat/x", currentAhead: true }), "feat/x");
});

test("outcomeRef keeps the recorded branch", () => {
	assert.equal(outcomeRef({ recorded: "master", recordedMoved: true, current: "feat/x", currentAhead: true }), undefined);
	assert.equal(outcomeRef({ recorded: "master", recordedMoved: false, current: "master", currentAhead: true }), undefined);
	assert.equal(outcomeRef({ recorded: "master", recordedMoved: false, current: "feat/x", currentAhead: false }), undefined);
	assert.equal(outcomeRef({ recorded: "master", recordedMoved: false, current: "HEAD", currentAhead: true }), undefined);
});

test("commit-only instruction forbids a chained push", () => {
	assert.ok(deliveryInstruction({ ...base, mode: "commit" }).includes("Don't run `git push` in any command"));
	assert.ok(!deliveryInstruction({ ...base, mode: "push" }).includes("Don't run `git push` in any command"));
});

test("a merge in progress is concluded with one commit", () => {
	const text = deliveryInstruction({ ...base, mergeInProgress: true });
	assert.ok(text.includes("git commit --no-edit"));
	assert.ok(!text.includes("Split them into commits"));
});

test("a merge on a protected branch is concluded before the switch", () => {
	const text = deliveryInstruction({ ...base, mode: "pr", from: "master", mergeInProgress: true });
	assert.ok(text.indexOf("git checkout -b") >= 0 && text.indexOf("git checkout -b") < text.indexOf("--no-edit"));
	assert.ok(!text.includes("git switch -c"));
});

function fakeGit(facts: { recorded: string; recordedSha: string; current: string; currentSha: string; ancestor: boolean }) {
	return async (...a: string[]) => {
		if (a[0] === "merge-base") return { code: facts.ancestor ? 0 : 1, stdout: "" };
		const ref = a[a.length - 1];
		if (ref === "--abbrev-ref" || a.includes("--abbrev-ref")) return { code: 0, stdout: facts.current };
		if (ref === "HEAD") return { code: 0, stdout: facts.currentSha };
		if (ref === facts.recorded) return { code: 0, stdout: facts.recordedSha };
		return { code: 128, stdout: "" };
	};
}

test("landedBranch finds the new branch the commits went on (D14)", async () => {
	assert.equal(await landedBranch(fakeGit({ recorded: "master", recordedSha: "a", current: "feat/x", currentSha: "b", ancestor: true }), "master", "a"), "feat/x");
});

test("landedBranch keeps the recorded branch when it moved", async () => {
	assert.equal(await landedBranch(fakeGit({ recorded: "b1", recordedSha: "c", current: "b1", currentSha: "c", ancestor: true }), "b1", "a"), undefined);
});

test("landedBranch keeps the recorded branch when it was deleted after a merge", async () => {
	assert.equal(await landedBranch(fakeGit({ recorded: "b1", recordedSha: "", current: "master", currentSha: "m", ancestor: true }), "b1", "a"), undefined);
});

test("repoDeliveryInstruction runs repos in parallel then merges in order", () => {
	const m = { ...base, mode: "merge" as const };
	const t = repoDeliveryInstruction([
		{ root: "D:/a", options: m },
		{ root: "D:/b", options: m },
	]);
	for (const part of ["in the same reply", "--interval 5", "in the order listed", "stop at the first repository whose checks failed", "Report each repository's result"]) assert.ok(t.includes(part), part);
	assert.ok(!t.includes("one after the other"));
});
