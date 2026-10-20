// node --experimental-strip-types --test folders.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldersFromEntries } from "./folders.ts";

const entry = (data: unknown) => ({ type: "custom", customType: "session-folders", data });

test("foldersFromEntries takes the newest session-folders entry", () => {
	const got = foldersFromEntries([entry({ v: 1, cwd: "D:/a", folders: ["D:/old"] }), { type: "message" }, entry({ v: 1, cwd: "D:/a", folders: ["D:/b/", "D:/c"] })]);
	assert.deepEqual(got, ["D:/b", "D:/c"]);
});

test("foldersFromEntries returns [] without a valid entry", () => {
	assert.deepEqual(foldersFromEntries([]), []);
	assert.deepEqual(foldersFromEntries([{ type: "custom", customType: "workflow-state", data: { folders: ["D:/x"] } }]), []);
	assert.deepEqual(foldersFromEntries([entry({ v: 2, folders: ["D:/x"] })]), []);
});
