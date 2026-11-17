// node --experimental-strip-types --test repos.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRepos, canonical, crossRunOverlaps, hasKeyPrefix, foldersFor, pickDiffBase, repoKey, split, subRepos, worktreesOf } from "./repos.ts";

const repos = [{ key: "api", top: "D:/w/api" }, { key: "web", top: "D:/w/web" }];

test("repoKey", () => {
	assert.equal(repoKey("D:/w/My Api"), "my-api");
	assert.equal(repoKey(["D:", "w", "Web/"].join(String.fromCharCode(92))), "web");
});

test("buildRepos puts the working repo first, drops duplicates and reports a key collision", () => {
	assert.deepEqual(buildRepos("D:/w/api", ["D:/w/web", "D:/w/api"]).repos, repos);
	const c = buildRepos("D:/a/x", ["D:/b/x"]);
	assert.match(c.error ?? "", /both get the key "x"/);
});

test("canonical", () => {
	assert.deepEqual(canonical("src/**", repos, "api"), { value: "api:src/**" });
	assert.deepEqual(canonical("web:src/**", repos, "api"), { value: "web:src/**" });
	assert.deepEqual(canonical("api:src/**", repos, "api"), { value: "api:src/**" });
	assert.ok("error" in canonical("zzz:x", repos, "api"));
	assert.deepEqual(canonical("src/**", [], ""), { value: "src/**" });
});

test("split", () => {
	assert.deepEqual(split("api:src/**"), { key: "api", path: "src/**" });
	assert.deepEqual(split("src/a.ts"), { key: "", path: "src/a.ts" });
});

test("subRepos unions working key, owns keys and extras", () => {
	assert.deepEqual(subRepos({ owns: ["web:src/**"], repos: ["docs"] }, "api").sort(), ["api", "docs", "web"]);
});

test("worktreesOf handles a legacy sub", () => {
	assert.deepEqual(worktreesOf({ cwd: "D:/s", base: "abc" }, {}), [{ key: "", cwd: "D:/s", base: "abc" }]);
	assert.deepEqual(worktreesOf({}, {}), []);
	const w = [{ key: "web", cwd: "D:/x" }];
	assert.equal(worktreesOf({ cwd: "D:/s", worktrees: w }, {}), w);
});

test("foldersFor keeps plain folders and needed repos", () => {
	const key = (f: string) => (f === "D:/w/web" ? "web" : f === "D:/w/docs" ? "docs" : null);
	assert.deepEqual(foldersFor({ repos: ["api", "web"] }, ["D:/w/web", "D:/w/docs", "D:/plain"], key), ["D:/w/web", "D:/plain"]);
});

test("hasKeyPrefix", () => {
	assert.equal(hasKeyPrefix("api:src/**"), true);
	assert.equal(hasKeyPrefix("src/**"), false);
	assert.equal(hasKeyPrefix("D:/x/**"), false);
});

test("crossRunOverlaps finds a run in web that owns paths in api, and a legacy run in web", () => {
	const mine = [{ key: "api", top: "D:/w/api" }, { key: "web", top: "D:/w/web" }];
	const pk = [{ id: "p", owns: ["api:src/a/**"] }];
	const r = { id: "R", repos: [{ key: "web", top: "D:/w/web" }, { key: "api", top: "D:/w/api" }], subs: [{ id: "s", state: "executing", owns: ["api:src/**"] }, { id: "done", state: "merged", owns: ["api:src/**"] }] };
	const got = crossRunOverlaps(mine, pk, "D:/w/web", r);
	assert.equal(got.length, 1);
	assert.match(got[0], /package s in the active run R/);
	assert.deepEqual(crossRunOverlaps(mine, pk, "D:/w/web", { id: "L", subs: [{ id: "s", state: "spawned", owns: ["src/**"] }] }), []);
	assert.equal(crossRunOverlaps(mine, [{ id: "q", owns: ["web:src/x.ts"] }], "D:/w/web", { id: "L", subs: [{ id: "s", state: "spawned", owns: ["src/**"] }] }).length, 1);
});

test("pickDiffBase prefers the target, then origin/HEAD, the default branch name, the spawn commit", () => {
	assert.equal(pickDiffBase({ viaTarget: "t", viaHead: "h", viaName: "n", spawn: "s" }), "t");
	assert.equal(pickDiffBase({ viaTarget: null, viaHead: "h", viaName: "n", spawn: "s" }), "h");
	assert.equal(pickDiffBase({ viaHead: "", viaName: "n", spawn: "s" }), "n");
	assert.equal(pickDiffBase({ spawn: "s" }), "s");
	assert.equal(pickDiffBase({}), undefined);
});
