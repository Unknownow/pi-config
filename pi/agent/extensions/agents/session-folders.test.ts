// node --experimental-strip-types --test session-folders.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldersForCwd } from "./session-folders.ts";

const entry = (cwd: string, folders: string[]) => ({ type: "custom", customType: "session-folders", data: { v: 1, cwd, folders } });

test("folders of the entry for this working folder", () => {
	assert.deepEqual(foldersForCwd([entry("D:/a", ["D:/x"])], "D:\\a"), ["D:/x"]);
});

test("an entry for another working folder gives none", () => {
	assert.deepEqual(foldersForCwd([entry("D:/a", ["D:/x"])], "D:/b"), []);
});

test("no entry gives none", () => {
	assert.deepEqual(foldersForCwd([], "D:/a"), []);
});

test("the last entry wins", () => {
	assert.deepEqual(foldersForCwd([entry("D:/a", ["D:/x"]), entry("D:/a", ["D:/y"])], "D:/a"), ["D:/y"]);
});
