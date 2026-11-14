// node --experimental-strip-types --test delivery.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyOutbox, combineRepos, deliveryMerged, endDecision, lastDelivery, listingAction, mergeGateDecision, needsBiggerPage, parseMergedArgs, parseRemoteUrl, pickBase, pickGhRepo, prTreeIndex, shouldPoll, stateAfterVerdict, verdictPayload,
	type MergeRecord,
} from "./delivery.ts";

const T1 = "a".repeat(40);
const T2 = "b".repeat(40);
const base = { tree: T1, treeGiven: true, key: "", accepted: false, verdictOk: false, requested: false, runEnded: false };

test("mergeGateDecision: a pre check is refused with the git_task text and sends no request", () => {
	const d = mergeGateDecision({ ...base, ask: "pre", kind: "merge" });
	assert.equal(d.pass, false);
	assert.equal(d.request, undefined);
	assert.match(d.refusal ?? "", /can't ask for acceptance/);
});

test("mergeGateDecision: a payload without ask acts as pre", () => {
	const d = mergeGateDecision({ ...base, kind: "merge" });
	assert.equal(d.request, undefined);
	assert.match(d.refusal ?? "", /git_task/);
});

test("mergeGateDecision: a publish gate sends a request with kind and ask", () => {
	const d = mergeGateDecision({ ...base, ask: "gate", kind: "publish" });
	assert.deepEqual(d.request, { tree: T1, repo: "", kind: "publish", ask: "gate" });
	assert.match(d.refusal ?? "", /end your turn/);
});

test("mergeGateDecision: no second request for the same tree", () => {
	const d = mergeGateDecision({ ...base, ask: "gate", kind: "merge", requested: true });
	assert.equal(d.request, undefined);
	assert.equal(d.pass, false);
});

test("mergeGateDecision: an accepted gate merge with a tree gives a merge-pass", () => {
	const d = mergeGateDecision({ ...base, ask: "gate", kind: "merge", accepted: true, verdictOk: true, key: "core" });
	assert.equal(d.pass, true);
	assert.deepEqual(d.mergePass, { tree: T1, repo: "core", kind: "merge" });
});

test("mergeGateDecision: a publish pass or a tree not given records nothing", () => {
	assert.equal(mergeGateDecision({ ...base, ask: "gate", kind: "publish", accepted: true, verdictOk: true }).mergePass, undefined);
	assert.equal(mergeGateDecision({ ...base, ask: "gate", kind: "merge", accepted: true, verdictOk: true, treeGiven: false }).mergePass, undefined);
	assert.equal(mergeGateDecision({ ...base, ask: "pre", kind: "merge", accepted: true, verdictOk: true }).mergePass, undefined);
});

test("mergeGateDecision: an ended run passes and posts nothing", () => {
	const d = mergeGateDecision({ ...base, ask: "gate", kind: "merge", runEnded: true });
	assert.deepEqual(d, { pass: true });
});

test("applyOutbox: merge-pass and flow-ended in one read", () => {
	const r = applyOutbox([
		{ type: "merge-pass", ts: "t1", data: { tree: T1, repo: "core", kind: "merge" } },
		{ type: "question", ts: "t2" },
		{ type: "flow-ended", ts: "t3", data: { how: "finished" } },
	]);
	assert.deepEqual(r.merges, [{ key: "core", tree: T1, kind: "merge", at: "t1" }]);
	assert.deepEqual(r.end, { at: "t3", how: "finished" });
	assert.deepEqual(r.rest.map((m) => m.type), ["question"]);
});

test("applyOutbox: the last of three flow-ended wins", () => {
	const r = applyOutbox([
		{ type: "flow-ended", ts: "1", data: { how: "stopped" } },
		{ type: "flow-ended", ts: "2", data: { how: "abandoned" } },
		{ type: "flow-ended", ts: "3", data: { how: "finished" } },
	]);
	assert.deepEqual(r.end, { at: "3", how: "finished" });
	assert.equal(r.rest.length, 0);
});

test("applyOutbox: an old flow-ended without how is unknown", () => {
	assert.equal(applyOutbox([{ type: "flow-ended", ts: "1", data: { flowId: "x" } }]).end?.how, "unknown");
	assert.equal(applyOutbox([{ type: "flow-ended", ts: "1", data: { how: "weird" } }]).end?.how, "unknown");
});

const rec = (tree: string, at: string, kind: "merge" | "protected-push" = "merge", key = ""): MergeRecord => ({ key, tree, kind, at });
const ld = (o: Partial<Parameters<typeof lastDelivery>[0]>) => lastDelivery({ merges: [], verdicts: [], accepted: [], key: "", workingKey: "", ...o });

test("lastDelivery: the newest of verdict and merge-pass wins, both ways", () => {
	assert.equal(ld({ merges: [rec(T1, "2")], verdicts: [{ accept: true, tree: T2, ts: "1" }] })?.tree, T1);
	assert.equal(ld({ merges: [rec(T1, "1")], verdicts: [{ accept: true, tree: T2, ts: "2" }] })?.tree, T2);
});

test("lastDelivery: publish and pre verdicts do not count, an old verdict without ask does", () => {
	assert.equal(ld({ verdicts: [{ accept: true, tree: T1, ask: "gate", kind: "publish", ts: "1" }] }), null);
	assert.equal(ld({ verdicts: [{ accept: true, tree: T1, ask: "pre", kind: "merge", ts: "1" }] }), null);
	assert.equal(ld({ verdicts: [{ accept: false, tree: T1, ts: "1" }] }), null);
	assert.deepEqual(ld({ verdicts: [{ accept: true, tree: T1, ts: "1" }] }), { tree: T1, kind: "merge", at: "1" });
});

test("lastDelivery: the accepted.json fallback, single and keyed", () => {
	assert.deepEqual(ld({ accepted: [T1, T2] }), { tree: T2, kind: "merge" });
	assert.deepEqual(ld({ accepted: [`core:${T1}`, `view:${T2}`, `core:${T2}`], key: "core", workingKey: "core" }), { tree: T2, kind: "merge" });
	assert.equal(ld({ accepted: [`view:${T2}`], key: "core", workingKey: "core" }), null);
});

test("lastDelivery: a revert to an earlier tree and a retried merge", () => {
	assert.equal(ld({ merges: [rec(T1, "1"), rec(T2, "2"), rec(T1, "3")] })?.tree, T1);
	assert.equal(ld({ merges: [rec(T1, "1"), rec(T1, "2")] })?.at, "2");
});

test("lastDelivery: protected-push and the key of a merge record", () => {
	assert.deepEqual(ld({ merges: [rec(T1, "1", "protected-push")] }), { tree: T1, kind: "protected-push", at: "1" });
	assert.equal(ld({ merges: [rec(T1, "1", "merge", "view")], key: "core", workingKey: "core" }), null);
	assert.equal(ld({ verdicts: [{ accept: true, tree: T1, ts: "1" }], key: "core", workingKey: "core" })?.tree, T1); // a missing repo is the working repo
});

const dm = (o: Partial<Parameters<typeof deliveryMerged>[0]> = {}) =>
	deliveryMerged({ key: "", delivery: { tree: T1, kind: "merge" }, prTrees: new Map([[T1, 5]]), prUnknown: false, targetTrees: new Set(), commitsSinceBase: 3, dirtyFiles: 0, headTree: T1, base: "origin/dev", ...o });

test("deliveryMerged: merged by PR head tree", () => {
	assert.deepEqual(dm(), { changed: true, ok: true, missing: [], notes: [] });
});

test("deliveryMerged: the last delivery is not merged", () => {
	const r = dm({ prTrees: new Map([[T2, 4]]) });
	assert.equal(r.ok, false);
	assert.match(r.missing[0], /aaaaaaaaaaaa/);
	assert.match(r.missing[0], /no merged pull request/);
	assert.doesNotMatch(r.missing.join(), /without a merged pull request/);
});

test("deliveryMerged: unknown listing gives null", () => {
	assert.equal(dm({ prTrees: new Map(), prUnknown: true }).ok, null);
});

test("deliveryMerged: protected-push checks the target", () => {
	const d = { tree: T1, kind: "protected-push" as const };
	assert.equal(dm({ delivery: d, targetTrees: new Set([T1]), prTrees: new Map() }).ok, true);
	assert.equal(dm({ delivery: d, targetTrees: new Set(), prTrees: new Map() }).ok, false);
	assert.equal(dm({ delivery: d, targetTrees: new Set(), targetUnknown: true }).ok, null);
});

test("deliveryMerged: dirty files and a different head only add notes", () => {
	const r = dm({ dirtyFiles: 2, headTree: T2, key: "core" });
	assert.equal(r.ok, true);
	assert.equal(r.notes.length, 2);
	assert.match(r.notes[0], /uncommitted files left in core \(2 files\)/);
	assert.match(r.notes[1], /differs from its last delivered tree/);
});

test("deliveryMerged: a delivery with 0 commits counts as changed; dirty only is not changed", () => {
	assert.equal(dm({ commitsSinceBase: 0 }).changed, true);
	const r = dm({ delivery: null, commitsSinceBase: 0, dirtyFiles: 1 });
	assert.equal(r.changed, false);
	assert.equal(r.notes.length, 1);
	assert.equal(dm({ delivery: null, commitsSinceBase: null, branchMerged: true }).ok, true);
});

test("deliveryMerged: no delivery falls back to the branch", () => {
	const none = { delivery: null, commitsSinceBase: 2, headTree: T1 };
	assert.equal(dm({ ...none, branchMerged: true }).ok, true);
	const f = dm({ ...none, branchMerged: false });
	assert.equal(f.ok, false);
	assert.match(f.missing[0], /no accepted tree in the repo/);
	assert.equal(dm({ ...none }).ok, false); // no branch
	assert.equal(dm({ ...none, branchMerged: null }).ok, null);
});

test("combineRepos: one repo missing, unknown, none changed", () => {
	const ok = { changed: true, ok: true as boolean | null, missing: [], notes: [] as string[] };
	assert.equal(combineRepos([ok, { ...ok, ok: false, missing: ["x"] }]).ok, false);
	assert.equal(combineRepos([ok, { ...ok, ok: null }]).ok, null);
	assert.equal(combineRepos([ok, { ...ok, ok: false }, { ...ok, ok: null }]).ok, false);
	assert.equal(combineRepos([ok, ok]).ok, true);
	const none = combineRepos([{ changed: false, ok: true, missing: [], notes: ["n"] }]);
	assert.equal(none.ok, false);
	assert.deepEqual(none.missing, ["no repo has changes"]);
	assert.deepEqual(none.notes, ["n"]);
});

test("endDecision", () => {
	const e = (o: Partial<Parameters<typeof endDecision>[0]>) => endDecision({ endHow: "finished", ok: true, manual: false, force: false, checks: 0, ...o });
	assert.equal(e({}), "merge");
	assert.equal(e({ ok: false }), "wait");
	assert.equal(e({ ok: false, checks: 1 }), "report");
	assert.equal(e({ ok: null }), "report");
	assert.equal(e({ endHow: "stopped" }), "report");
	assert.equal(e({ endHow: "unknown" }), "report");
	assert.equal(e({ endHow: "stopped", manual: true }), "merge");
	assert.equal(e({ endHow: "stopped", manual: true, ok: false }), "report");
	assert.equal(e({ endHow: "stopped", manual: true, ok: null, force: true }), "merge");
});

test("shouldPoll", () => {
	assert.equal(shouldPoll({ state: "executing" }), false);
	assert.equal(shouldPoll({ state: "executing", endedAt: "t", endHow: "finished", endChecks: 2 }), true);
	assert.equal(shouldPoll({ state: "merged", endedAt: "t", endHow: "finished" }), false);
	assert.equal(shouldPoll({ state: "executing", endedAt: "t", endHow: "stopped", endChecks: 0 }), true);
	assert.equal(shouldPoll({ state: "executing", endedAt: "t", endHow: "stopped", endChecks: 1 }), false);
});

test("parseMergedArgs", () => {
	assert.deepEqual(parseMergedArgs("core"), { id: "core", force: false });
	assert.deepEqual(parseMergedArgs("--force core"), { id: "core", force: true });
	assert.deepEqual(parseMergedArgs("core --force"), { id: "core", force: true });
	assert.ok("error" in parseMergedArgs(""));
	assert.ok("error" in parseMergedArgs("a b"));
});

test("verdictPayload and stateAfterVerdict", () => {
	assert.deepEqual(verdictPayload({ tree: T1, repo: "core", kind: "merge", ask: "gate" }, true), { accept: true, tree: T1, repo: "core", kind: "merge", ask: "gate" });
	assert.deepEqual(verdictPayload({ tree: T1, repo: "" }, false), { accept: false, tree: T1, repo: "" });
	assert.equal(stateAfterVerdict("awaiting-acceptance"), "executing");
	assert.equal(stateAfterVerdict("merged"), "merged");
});

test("parseRemoteUrl", () => {
	assert.equal(parseRemoteUrl("https://github.com/Annamites/city-bus-flow.git"), "Annamites/city-bus-flow");
	assert.equal(parseRemoteUrl("https://github.com/o/r"), "o/r");
	assert.equal(parseRemoteUrl("git@github.com:o/r.git"), "o/r");
	assert.equal(parseRemoteUrl("ssh://git@github.com/o/r.git"), "o/r");
	assert.equal(parseRemoteUrl("https://example.com/o/r"), null);
});

test("pickGhRepo", () => {
	const remotes = [
		{ name: "origin", url: "https://github.com/Annamites/city-bus-flow.git" },
		{ name: "upstream", url: "https://github.com/Annamites/game-template.git" },
	];
	assert.deepEqual(pickGhRepo(remotes, "origin/feat/x"), { remote: "origin", slug: "Annamites/city-bus-flow" });
	assert.deepEqual(pickGhRepo(remotes, "upstream/main"), { remote: "upstream", slug: "Annamites/game-template" });
	assert.equal(pickGhRepo(remotes, null)?.slug, "Annamites/city-bus-flow");
	assert.equal(pickGhRepo([], "origin/x"), null);
});

test("pickBase and needsBiggerPage", () => {
	assert.equal(pickBase("origin/feat/new-gameplay", "origin"), "feat/new-gameplay");
	assert.equal(pickBase(null, "origin"), null);
	assert.equal(needsBiggerPage(200, 200), true);
	assert.equal(needsBiggerPage(199, 200), false);
});

test("listingAction: only the same round is reused", () => {
	assert.equal(listingAction({ round: 3 }, 3), "use");
	assert.equal(listingAction({ round: 3 }, 4), "refresh");
	assert.equal(listingAction(undefined, 1), "refresh");
});

test("prTreeIndex: mergedAt filter, unknown trees, shared use", () => {
	const prs = [
		{ number: 1, headRefOid: "s1", mergedAt: "2026-11-12T00:00:00Z" },
		{ number: 2, headRefOid: "s2", mergedAt: "2026-11-14T00:00:00Z" },
		{ number: 3, headRefOid: "s3", mergedAt: "2026-11-15T00:00:00Z" },
		{ number: 4, headRefOid: "s4", mergedAt: null },
	];
	const idx = prTreeIndex(prs, "2026-11-13T00:00:00Z", (sha) => (sha === "s2" ? T1 : null));
	assert.deepEqual([...idx.trees], [[T1, 2]]);
	assert.equal(idx.unknown, 1);
	// one listing serves both subs' lookups
	assert.equal(idx.trees.has(T1), true);
});
