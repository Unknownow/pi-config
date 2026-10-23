import assert from "node:assert/strict";
import { test } from "node:test";
import { lockWaitCheck, blockedWaitCheck, classifyPublish, shouldRecordMerged, waitSince, lockDecision, mirrorArgs, parseMirrorStep, parsePublishStep, publishArgs } from "./registry-publish.ts";
import { registryPublishProblem } from "./push-guard.ts";

test("parsePublishStep reads packages and rejects versions", () => {
	assert.deepEqual(parsePublishStep("- [ ] **S9.** Publish: com.iecgames.core, com.iecgames.ads.applovin", "S9"), { packages: ["com.iecgames.core", "com.iecgames.ads.applovin"] });
	assert.equal(parsePublishStep("**S9.** Publish: com.iecgames.core@0.25.0", "S9"), null);
	assert.deepEqual(parsePublishStep("**S9.** Publish : com.iecgames.core", "S9"), { packages: ["com.iecgames.core"] });
	assert.equal(parsePublishStep("**S9.** Publish: core", "S9"), null);
	assert.equal(parsePublishStep("**S9.** Deliver: merge", "S9"), null);
});

test("parseMirrorStep reads a folder or all, with extras", () => {
	assert.deepEqual(parseMirrorStep("**S3.** Mirror: com.iecgames.thirdparty.hyprmx", "S3"), { target: "com.iecgames.thirdparty.hyprmx", extras: [] });
	assert.deepEqual(parseMirrorStep("**S3.** Mirror: all; extras a@1,b@2", "S3"), { target: "all", extras: ["a@1", "b@2"] });
	assert.equal(parseMirrorStep("**S3.** Mirror: all; extras a", "S3"), null);
	assert.equal(parseMirrorStep("**S3.** Publish: x", "S3"), null);
});

test("blockedWaitCheck quotes and the guard allows it", () => {
	const c = blockedWaitCheck(["D:", "p", "unity packages"].join(String.fromCharCode(92)), [{ name: "a", version: "1.0.0" }, { name: "b", version: "2.0.0" }]);
	assert.equal(c, "node 'D:/p/unity packages/scripts/update-packages.mjs' publish --only 'a@1.0.0,b@2.0.0' --dry-run --unblocked");
	assert.equal(registryPublishProblem(c), null);
});

test("lockDecision", () => {
	const now = Date.parse("2026-10-23T12:00:00Z");
	assert.equal(lockDecision(null, now, () => false), "free");
	assert.equal(lockDecision({ pid: 1, startedAt: "2026-10-23T11:50:00Z" }, now, () => false), "held");
	assert.equal(lockDecision({ pid: 1, startedAt: "2026-10-23T10:00:00Z" }, now, () => true), "held");
	assert.equal(lockDecision({ pid: 1, startedAt: "2026-10-23T10:00:00Z" }, now, () => false), "stale");
});

test("publishArgs and mirrorArgs", () => {
	const items = [{ name: "a", version: "1.0.0" }];
	assert.deepEqual(publishArgs(items, true), ["publish", "--only", "a@1.0.0", "--dry-run", "--json"]);
	assert.deepEqual(publishArgs(items, false), ["publish", "--only", "a@1.0.0", "--confirm", "publish"]);
	assert.deepEqual(mirrorArgs({ target: "all", extras: ["x@1"] }), ["mirror", "--all", "--extras", "x@1", "--confirm", "mirror"]);
	assert.deepEqual(mirrorArgs({ target: "f", extras: [] }, true), ["mirror", "--package", "f"]);
});

test("registryPublishProblem refuses direct publishing", () => {
	for (const c of ["npm publish", "npm.cmd publish --registry x", "npm --registry x publish", "bash -c \"npm publish\"", "\"npm\" publish", "cd x && npm publish", "updates.bat publish", "node scripts/update-packages.mjs publish --only a@1 --confirm publish", "node scripts/update-packages.mjs publish", "node scripts/maintenance.mjs mirror --all --confirm mirror", "node scripts/publish-package.mjs com.iecgames.core"]) {
		assert.match(registryPublishProblem(c) ?? "", /publish_packages/, c);
	}
	for (const c of ["node scripts/update-packages.mjs publish --only a@1 --dry-run --json", "node scripts/maintenance.mjs mirror --all", "git commit -m 'fix npm publish docs'", "grep -n publish-package.mjs README.md", "npm test", "ls"]) {
		assert.equal(registryPublishProblem(c), null, c);
	}
});

test("lockDecision: a lock with no valid pid is stale once old", () => {
	const now = Date.parse("2026-10-23T12:00:00Z");
	assert.equal(lockDecision({ pid: 0, startedAt: "2026-10-23T11:20:00Z" }, now, () => true), "stale");
});

test("waitSince keeps the first value", () => {
	assert.equal(waitSince(undefined, "b"), "b");
	assert.equal(waitSince("a", "b"), "a");
});

test("shouldRecordMerged needs a merge delivery that succeeded", () => {
	assert.equal(shouldRecordMerged("merge", true), true);
	assert.equal(shouldRecordMerged("merge", false), false);
	assert.equal(shouldRecordMerged("push", true), false);
});

test("classifyPublish splits by the dry run and the tags", () => {
	const a = { name: "a", version: "1.0.0" };
	const b = { name: "b", version: "1.0.0" };
	const c = { name: "c", version: "1.0.0" };
	const r = classifyPublish([a, b, c], { items: [a], notCandidates: ["b@1.0.0", "c@1.0.0"] }, new Set(["a/v1.0.0", "b/v1.0.0"]));
	assert.deepEqual(r, { publish: [a], alreadyPublished: [b], notPublishable: ["c@1.0.0"] });
});

test("lockWaitCheck passes without a lock and the guard allows it", async () => {
	const { execFileSync } = await import("node:child_process");
	const c = lockWaitCheck("/nonexistent/iec-publish.lock");
	assert.equal(registryPublishProblem(c), null);
	execFileSync("bash", ["-c", c]);
});
