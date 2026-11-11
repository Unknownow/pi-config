// node --experimental-strip-types --test paths.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { globsMayOverlap, globToRegExp, outsideOwned } from "./paths.ts";

test("globs", () => {
	assert.ok(globToRegExp("src/**").test("src/a/b.ts"));
	assert.ok(globToRegExp("src/**").test("src/a.ts"));
	assert.ok(globToRegExp("**/*.cs").test("a/b/c.cs"));
	assert.ok(globToRegExp("**/*.cs").test("c.cs"));
	assert.ok(globToRegExp("*.md").test("README.md"));
	assert.ok(!globToRegExp("*.md").test("docs/x.md"));
	assert.ok(globToRegExp("a?.txt").test("ab.txt"));
	assert.ok(!globToRegExp("a?.txt").test("a/.txt"));
	assert.ok(!globToRegExp("a.txt").test("axtxt"));
});

test("matching is case-insensitive and takes backslashes", () => {
	assert.ok(globToRegExp("Src/**").test("src/A.TS"));
	assert.deepEqual(outsideOwned(["src\\a.ts"], ["SRC/**"], []), []);
});

test("forbids win over owns", () => {
	assert.deepEqual(outsideOwned(["src/a.ts", "src/secret/k.ts", "docs/x.md"], ["src/**"], ["src/secret/**"]), ["src/secret/k.ts", "docs/x.md"]);
});

test("a folder path without wildcards matches everything below it", () => {
	assert.ok(globToRegExp("src/a").test("src/a/x.ts"));
	assert.ok(globToRegExp("src/a/").test("src/a/x.ts"));
	assert.ok(globToRegExp("src/a").test("src/a"));
	assert.ok(!globToRegExp("src/a").test("src/ab.ts"));
});

test("globsMayOverlap", () => {
	assert.equal(globsMayOverlap("api:src/**", "api:src/a/*.ts"), true);
	assert.equal(globsMayOverlap("api:src/**", "api:docs/**"), false);
	assert.equal(globsMayOverlap("api:src/**", "web:src/**"), false);
	assert.equal(globsMayOverlap("api:**", "api:anything/x.ts"), true);
	assert.equal(globsMayOverlap("api:src", "api:srcx/**"), false);
	assert.equal(globsMayOverlap("src/a*.ts", "src/ab/**"), true);
});
