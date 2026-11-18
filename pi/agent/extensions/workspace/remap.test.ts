// node --experimental-strip-types --test remap.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { repoKey } from "../shared/repos.ts";
import { remapFolders, type FolderRepo } from "./remap.ts";

const repos: Record<string, FolderRepo> = {
	"D:/p/knowledge": { top: "D:/p/knowledge", main: "D:/p/knowledge" },
	"D:/p/knowledge/docs": { top: "D:/p/knowledge", main: "D:/p/knowledge" },
	"D:/p/wt/w1/knowledge": { top: "D:/p/wt/w1/knowledge", main: "D:/p/knowledge" },
	"D:/p/wt/w1/knowledge/docs": { top: "D:/p/wt/w1/knowledge", main: "D:/p/knowledge" },
	"D:/p/tools": { top: "D:/p/tools", main: "D:/p/tools" },
};
const repoOf = (f: string) => repos[f] ?? null;
const all = () => true;

test("/wt use: a repo of the set moves to its worktree (subfolder kept); other repos and plain folders stay", () => {
	const set = new Map([[repoKey("D:/p/knowledge"), "D:/p/wt/w1/knowledge"]]);
	assert.deepEqual(remapFolders(["D:/p/knowledge/docs", "D:/p/tools", "D:/notes"], repoOf, set, "D:/p/wt/w1/game", all), ["D:/p/wt/w1/knowledge/docs", "D:/p/tools", "D:/notes"]);
	assert.deepEqual(remapFolders(["D:/p/knowledge"], repoOf, set, "D:/p/wt/w1/game", all), ["D:/p/wt/w1/knowledge"]);
});

test("/wt done: worktrees go back to the main checkouts", () => {
	const home = new Map([[repoKey("D:/p/knowledge"), "D:/p/knowledge"]]);
	assert.deepEqual(remapFolders(["D:/p/wt/w1/knowledge/docs", "D:/notes"], repoOf, home, "D:/p/game", all), ["D:/p/knowledge/docs", "D:/notes"]);
});

test("a missing target keeps the folder; the new working folder and repeats are dropped", () => {
	const set = new Map([[repoKey("D:/p/knowledge"), "D:/p/wt/w1/knowledge"]]);
	assert.deepEqual(remapFolders(["D:/p/knowledge/docs"], repoOf, set, "D:/x", (p) => p !== "D:/p/wt/w1/knowledge/docs"), ["D:/p/knowledge/docs"]);
	assert.deepEqual(remapFolders(["D:/p/knowledge", "D:/p/wt/w1/knowledge"], repoOf, set, "D:/x", all), ["D:/p/wt/w1/knowledge"]);
	assert.deepEqual(remapFolders(["D:/p/knowledge"], repoOf, set, "D:/p/wt/w1/knowledge", all), []);
});
