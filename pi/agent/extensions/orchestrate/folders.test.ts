// node --experimental-strip-types --test folders.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldersFromEntries } from "./folders.ts";

const entry = (data: unknown) => ({ type: "custom", customType: "session-folders", data });

test("foldersFromEntries takes the newest entry and normalises slashes", () => {
	const bs = String.fromCharCode(92);
	assert.deepEqual(foldersFromEntries([entry({ v: 1, folders: ["D:/old"] }), { type: "message" }, entry({ v: 1, folders: [`D:${bs}b${bs}`, "D:/c"] })]), ["D:/b", "D:/c"]);
});

test("foldersFromEntries returns [] without a valid entry", () => {
	assert.deepEqual(foldersFromEntries([]), []);
	assert.deepEqual(foldersFromEntries([entry({ v: 2, folders: ["D:/x"] })]), []);
});
