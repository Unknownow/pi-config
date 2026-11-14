// node --experimental-strip-types --test authority.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowed, classifyCommand, pathCategory, unauthorized } from "./authority.ts";
import { DEFAULT_SENSITIVE_PATHS } from "./config.ts";

const ctx = { branch: "relay/r1", protectedBranches: ["main"], setRoot: "/sets/r1" };
const cats = (c: string, x = ctx) => classifyCommand(c, x).map((o) => o.category);

test("commands map to the six categories", () => {
	assert.deepEqual(cats("git push origin HEAD:main"), ["merge"]);
	assert.deepEqual(cats("git push origin HEAD:relay/r1"), []);
	assert.deepEqual(cats("gh pr merge 5 --squash"), ["merge"]);
	assert.deepEqual(cats("npm publish"), ["publish"]);
	assert.deepEqual(cats("gh release create v1"), ["publish"]);
	assert.deepEqual(cats("gh pr comment 5 -b hi"), ["comments"]);
	assert.deepEqual(cats("gh issue close 3"), ["comments"]);
	assert.deepEqual(cats("gh api -X POST repos/a/b/issues/3/comments -f body=x"), ["comments"]);
	assert.deepEqual(cats("git branch -D old"), ["delete"]);
	assert.deepEqual(cats("git push origin --delete old"), ["delete"]);
	assert.deepEqual(cats("rm -rf /elsewhere/x"), ["delete"]);
	assert.deepEqual(cats("rm -rf build"), []);
	assert.deepEqual(cats("rm -rf /sets/r1/build"), []);
	assert.deepEqual(cats("npm install left-pad"), ["deps"]);
	assert.deepEqual(cats("npm install"), []);
	assert.deepEqual(cats("pnpm add x"), ["deps"]);
	assert.deepEqual(cats("dotnet add MyApp package Foo"), ["deps"]);
	assert.deepEqual(cats("git status && npm test"), []);
	assert.deepEqual(cats('bash -c "git branch -D old"'), ["delete"]);
	assert.deepEqual(cats("sh -c 'npm install x'"), ["deps"]);
});

test("paths: manifests are deps, other sensitive paths formats", () => {
	const g = DEFAULT_SENSITIVE_PATHS;
	assert.equal(pathCategory("package.json", g), "deps");
	assert.equal(pathCategory("sub/dir/package-lock.json", g), "deps");
	assert.equal(pathCategory("Packages/manifest.json", g), "deps");
	assert.equal(pathCategory("src/App.csproj", g), "deps");
	assert.equal(pathCategory(".github/workflows/ci.yml", g), "formats");
	assert.equal(pathCategory("cfg/.env.local", g), "formats");
	assert.equal(pathCategory("src/index.ts", g), undefined);
});

test("actions are refused until approved, then allowed", () => {
	const a = { authority: { merge: { value: "no" as const }, deps: { value: "no" as const } }, approvals: [] as any[] };
	assert.equal(allowed("deps", "package.json", a), false);
	assert.ok(unauthorized("npm install x", ctx, a));
	a.approvals.push({ at: "t", item: "package.json", category: "deps", by: "lead", reason: "ok" });
	assert.equal(allowed("deps", "package.json", a), true);
	assert.equal(allowed("deps", "other.json", a), false);
	assert.equal(allowed("merge", "x", { authority: { merge: { value: "yes", specifics: "ff" } }, approvals: [] }), true);
	assert.equal(allowed("deps", "anything", { authority: {}, approvals: [{ at: "", item: "*", category: "deps", by: "lead", reason: "" }] }), true);
});
