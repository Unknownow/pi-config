import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { modelChoices, pathCompletions } from "./pickers.ts";

const tree: Record<string, string[]> = {
	[path.resolve("/w")]: ["src", "Docs", ".git", "spaced dir"],
	[path.resolve("/w/src")]: ["lib"],
	[path.resolve("/h")]: ["proj"],
};
const fake = (dir: string) => tree[dir] ?? null;
const run = (p: string) => pathCompletions(p, "/w", "/h", fake);

test("pathCompletions lists matching folders", () => {
	assert.deepEqual(run(""), ["Docs/", "spaced dir/", "src/"]);
	assert.deepEqual(run("s"), ["spaced dir/", "src/"]);
	assert.deepEqual(run("D"), ["Docs/"]);
	assert.deepEqual(run("d"), ["Docs/"]);
	assert.deepEqual(run(".g"), [".git/"]);
	assert.deepEqual(run("src/"), ["src/lib/"]);
	assert.deepEqual(run("src\\l"), ["src/lib/"]);
	assert.deepEqual(run("~/p"), ["~/proj/"]);
	assert.deepEqual(run('"spa'), ["spaced dir/"]);
	assert.deepEqual(run("nope/x"), []);
});

test("pathCompletions caps at 50", () => {
	const many = Array.from({ length: 60 }, (_, i) => `d${i}`);
	assert.equal(pathCompletions("", "/w", "/h", () => many).length, 50);
});

test("modelChoices sorts and labels", () => {
	const r = modelChoices([{ provider: "b", id: "m1", name: "m1" }, { provider: "a", id: "z", name: "Zed" }, { provider: "a", id: "c" }], "a/z");
	assert.deepEqual(r.map((c) => c.value), ["a/c", "a/z", "b/m1"]);
	assert.deepEqual(r.map((c) => c.label), ["a/c", "a/z — Zed (current)", "b/m1"]);
});
