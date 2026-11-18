// node --experimental-strip-types --test session-folders.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { foldersEntry, foldersForCwd, newestFolders, sameFolders } from "./session-folders.ts";

const entry = (cwd: string, folders: string[]) => ({ type: "custom", customType: "session-folders", data: { v: 1, cwd, folders } });

test("foldersForCwd: folders of the entry for this working folder", () => {
	assert.deepEqual(foldersForCwd([entry("D:/a", ["D:/x"])], "D:\\a"), ["D:/x"]);
});

test("foldersForCwd: an entry for another working folder gives none", () => {
	assert.deepEqual(foldersForCwd([entry("D:/a", ["D:/x"])], "D:/b"), []);
	assert.deepEqual(foldersForCwd([entry("D:/a", ["D:/x"]), entry("D:/b", ["D:/y"])], "D:/a"), [], "only the newest entry counts");
});

test("foldersForCwd: no entry gives none; the last entry wins", () => {
	assert.deepEqual(foldersForCwd([], "D:/a"), []);
	assert.deepEqual(foldersForCwd([entry("D:/a", ["D:/x"]), entry("D:/a", ["D:/y"])], "D:/a"), ["D:/y"]);
});

test("newestFolders: the newest entry for any cwd, normalised", () => {
	assert.deepEqual(newestFolders([entry("D:/a", ["D:/old"]), { type: "message" }, entry("D:/z", ["D:\\b\\", "D:/c", ""])]), ["D:/b", "D:/c"]);
});

test("newestFolders: [] without a valid entry", () => {
	assert.deepEqual(newestFolders([]), []);
	assert.deepEqual(newestFolders([{ type: "custom", customType: "workflow-state", data: { folders: ["D:/x"] } }]), []);
	assert.deepEqual(newestFolders([{ type: "custom", customType: "session-folders", data: { v: 2, folders: ["D:/x"] } }]), []);
});

test("foldersEntry: v 1, forward slashes, folders without a trailing slash", () => {
	assert.deepEqual(foldersEntry("D:\\a", ["D:\\x\\", "D:/y", "D:/"]), { v: 1, cwd: "D:/a", folders: ["D:/x", "D:/y", "D:/"] });
	assert.deepEqual(foldersForCwd([{ type: "custom", customType: "session-folders", data: foldersEntry("D:\\a", ["D:\\x"]) }], "D:\\a"), ["D:/x"], "readers find what the builder wrote");
});

test("sameFolders: order matters, slashes do not; case only on Windows", () => {
	assert.ok(sameFolders(["D:/x", "D:/y"], ["D:\\x\\", "D:/y"]));
	assert.ok(!sameFolders(["D:/x", "D:/y"], ["D:/y", "D:/x"]));
	assert.ok(!sameFolders(["D:/x"], ["D:/x", "D:/y"]));
	assert.ok(sameFolders([], []));
	assert.ok(sameFolders(["D:/X"], ["d:/x"], "win32"));
	assert.ok(!sameFolders(["/X"], ["/x"], "linux"));
});
