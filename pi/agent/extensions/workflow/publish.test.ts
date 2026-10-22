// node --test publish.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { repoDeliveryInstruction } from "./delivery.ts";
import { mergePublish, movedText, publishDecision, refuseText, type PublishFacts } from "./publish.ts";

const base: PublishFacts = { repo: "r", branch: "feat", head: "h2", judged: { base: "b0", head: "h2", branch: "feat" }, foreign: [], descends: true, judgedOnRemote: false, judgedBranchExists: true, hasUpstream: true, ahead: 0, pr: null, protectedBranch: false };
const f = (o: Partial<PublishFacts>): PublishFacts => ({ ...base, ...o });

test("not judged", () => assert.deepEqual(publishDecision(f({ judged: undefined }), "push"), { kind: "not-judged" }));
test("foreign commits are refused", () => {
	const d = publishDecision(f({ foreign: ["abc1234 x"] }), "push");
	assert.deepEqual(d, { kind: "refuse", judgedHead: "h2", commits: ["abc1234 x"] });
});
test("protected branch", () => assert.deepEqual(publishDecision(f({ branch: "main", judged: { base: "b0", head: "h2", branch: "main" }, protectedBranch: true }), "push"), { kind: "nothing", reason: "main is protected" }));
test("detached", () => assert.deepEqual(publishDecision(f({ branch: "HEAD", judged: { base: "b0", head: "h2", branch: "HEAD" } }), "push"), { kind: "nothing", reason: "HEAD is detached" }));
test("no upstream publishes from the judged base", () => assert.deepEqual(publishDecision(f({ hasUpstream: false }), "push"), { kind: "publish", base: "b0", branch: "feat" }));
test("ahead publishes", () => assert.equal(publishDecision(f({ ahead: 2 }), "push").kind, "publish"));
test("pushed, PR open, mode pr: nothing", () => assert.deepEqual(publishDecision(f({ pr: { state: "OPEN" } }), "pr"), { kind: "nothing", reason: "already published" }));
test("pushed, PR open, mode merge: publish", () => assert.equal(publishDecision(f({ pr: { state: "OPEN" } }), "merge").kind, "publish"));
test("pushed, no PR, mode pr: publish", () => assert.equal(publishDecision(f({}), "pr").kind, "publish"));
test("pushed, mode push: nothing", () => assert.equal(publishDecision(f({}), "push").kind, "nothing"));
test("PR closed, mode pr: publish", () => assert.equal(publishDecision(f({ pr: { state: "CLOSED" } }), "pr").kind, "publish"));
test("PR merged, mode merge: nothing", () => assert.deepEqual(publishDecision(f({ pr: { state: "MERGED" } }), "merge"), { kind: "nothing", reason: "pull request already merged" }));

test("refuseText names repo, commits and the reset", () => {
	const t = refuseText("D:/w/shiny-loop", { judgedHead: "deadbeef", commits: ["abc1234 one", "def5678 two"] });
	for (const s of ["shiny-loop", "abc1234 one", "def5678 two", "git -C D:/w/shiny-loop reset --soft deadbeef"]) assert.ok(t.includes(s), s);
});

test("HEAD not descending from the judged head is moved", () => assert.equal(publishDecision(f({ descends: false }), "merge").kind, "moved"));
test("another branch is moved", () => assert.deepEqual(publishDecision(f({ branch: "feature-x" }), "pr"), { kind: "moved", judgedBranch: "feat", judgedHead: "h2" }));
test("movedText names repo, branch and switch", () => {
	const t = movedText("D:/w/shiny-loop", { judgedBranch: "feat", judgedHead: "deadbeefcafe" });
	for (const s of ["shiny-loop", "feat", "git -C D:/w/shiny-loop switch feat"]) assert.ok(t.includes(s), s);
});

test("mergePublish adds the judged repos after the changed ones", () => {
	const opt = (committed: boolean) => ({ mode: "push" as const, branch: "feat", base: "", split: false, mergeMethod: "merge" as const, deleteBranch: false, deviations: "", committed });
	const m = mergePublish([{ root: "/a", options: opt(false) }], [{ root: "/a", mode: "push", head: "h1", branch: "feat" }], [{ root: "/b", mode: "push", head: "b0", branch: "feat", options: opt(true) }]);
	assert.deepEqual(m.repos.map((r) => r.root), ["/a", "/b"]);
	assert.equal(m.repos[1].head, "b0");
	assert.match(repoDeliveryInstruction(m.parts), /already committed/);
});

test("judged work on a remote with the branch gone is already published", () => assert.deepEqual(publishDecision(f({ branch: "main", judgedOnRemote: true, judgedBranchExists: false }), "merge"), { kind: "nothing", reason: "already published" }));

test("judged work on a remote but the judged branch still there is moved", () => assert.equal(publishDecision(f({ branch: "main", judgedOnRemote: true, judgedBranchExists: true }), "pr").kind, "moved"));
