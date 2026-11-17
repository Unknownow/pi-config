// node --experimental-strip-types --test paths.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { globsMayOverlap, globToRegExp, outsideOwned, parsePorcelainZ } from "./paths.ts";

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

test("parsePorcelainZ keeps the first letter of the first path and skips rename sources", () => {
	assert.deepEqual(parsePorcelainZ(" M unity/a.cs\0?? b.txt\0"), ["unity/a.cs", "b.txt"]);
	assert.deepEqual(parsePorcelainZ("R  new.cs\0old.cs\0 M x.cs\0"), ["new.cs", "x.cs"]);
	assert.deepEqual(parsePorcelainZ("?? my file.txt\0"), ["my file.txt"]);
	assert.deepEqual(parsePorcelainZ(""), []);
});

test("an owned dirty file is not drift", () => {
	const files = parsePorcelainZ(" M unity/Assets/_Project/Scripts/NewGameplay/Core/FailReason.cs\0");
	assert.deepEqual(files, ["unity/Assets/_Project/Scripts/NewGameplay/Core/FailReason.cs"]);
	assert.deepEqual(outsideOwned(files, ["unity/Assets/_Project/Scripts/NewGameplay/Core/**","unity/Assets/_Project/Scripts/NewGameplay/Compare/**","unity/Assets/_Project/Scripts/NewGameplay/Sandbox/**","unity/Assets/_Project/Resources/Content/newgameplay/settings.json","unity/Assets/_Project/Content/Levels/**","unity/Assets/_Project/Resources/Levels/**","tools/levelkit/**","unity/Assets/_Project/Scripts/Simulation/Tests/**","unity/Assets/_Project/Scripts/Gameplay/Tests/**","docs/design/gameplay/new-gameplay/mechanics.md","docs/design/gameplay/new-gameplay/README.md","docs/design/gameplay/new-gameplay/handoffs.md","docs/design/gameplay/new-gameplay/boosters.md","docs/design/gameplay/new-gameplay/rules/**","docs/decisions/**","docs/tasks.json","docs/progress.md"], ["unity/Assets/_Project/Scripts/NewGameplay/View/**","unity/Assets/_Project/Scripts/NewGameplay/Session/**","unity/Assets/_Project/Resources/Board/**","unity/Packages/**"]), []);
});
