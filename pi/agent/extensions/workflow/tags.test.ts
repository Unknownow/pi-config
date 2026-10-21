import assert from "node:assert/strict";
import test from "node:test";
import { pushArgs, tagDecision } from "./tags.ts";

const base = { name: "a/v1", planned: true, move: false, target: "T", onDefault: true };

test("tagDecision", () => {
	assert.equal(tagDecision({ ...base, onDefault: false }).action, "wait");
	assert.equal(tagDecision({ ...base, planned: false, move: true, remoteSha: "O" }).action, "refuse");
	assert.deepEqual(tagDecision(base), { action: "create" });
	assert.equal(tagDecision({ ...base, remoteSha: "O" }).action, "wait");
	const un = tagDecision({ ...base, planned: false, remoteSha: "O" });
	assert.ok(un.action === "refuse" && un.text.includes("pick the next free name"));
	const same = tagDecision({ ...base, remoteSha: "T" });
	assert.ok(same.action === "refuse" && same.ok && same.text.includes("nothing to do"));
	assert.equal(tagDecision({ ...base, move: true, remoteSha: "O", oldIsAncestor: false }).action, "wait");
	assert.deepEqual(tagDecision({ ...base, move: true, remoteSha: "O", oldIsAncestor: true }), { action: "move", lease: "O" });
	assert.deepEqual(tagDecision({ ...base, move: true }), { action: "create" });
	const same2 = tagDecision({ ...base, move: true, remoteSha: "T" });
	assert.ok(same2.action === "refuse" && same2.ok);
});

test("pushArgs", () => {
	assert.deepEqual(pushArgs("origin", "a/v1", "T"), ["push", "origin", "T:refs/tags/a/v1"]);
	const l = pushArgs("origin", "a/v1", "T", "O");
	assert.deepEqual(l, ["push", "--force-with-lease=refs/tags/a/v1:O", "origin", "T:refs/tags/a/v1"]);
	for (const a of [...l, ...pushArgs("origin", "a/v1", "T")]) assert.ok(a !== "--no-verify" && a !== "--force");
});
