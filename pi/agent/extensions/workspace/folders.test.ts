// node --experimental-strip-types --test folders.test.ts
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { addDirFolders, keepFolders, legacyFolders } from "./folders.ts";

test("keepFolders keeps all without `only`, filters by slash-insensitive match and ignores unknown entries", () => {
	const added = ["D:/b", "D:/c"];
	assert.deepEqual(keepFolders(added, undefined), added);
	assert.deepEqual(keepFolders(added, ["D:/c/", "D:/zzz"]), ["D:/c"]);
	assert.deepEqual(keepFolders(added, []), []);
	if (process.platform === "win32") assert.deepEqual(keepFolders(added, ["d:/B"]), ["D:/b"]);
});

test("legacyFolders: the folders of the newest workflow-state entry, read-only migration", () => {
	const state = (folders: unknown) => ({ type: "custom", customType: "workflow-state", data: { phase: "off", folders } });
	assert.deepEqual(legacyFolders([state(["D:/old"]), { type: "message" }, state(["D:/a", 3, ""])]), ["D:/a"]);
	assert.deepEqual(legacyFolders([state(["D:/a"]), state(undefined)]), [], "only the newest state counts");
	assert.deepEqual(legacyFolders([{ type: "custom", customType: "session-folders", data: { v: 1, cwd: "D:/w", folders: ["D:/x"] } }]), []);
	assert.deepEqual(legacyFolders([]), []);
});

test("addDirFolders: existing folders only, no repeats, never the working folder", () => {
	const cwd = path.resolve("/w");
	const slash = (p: string) => path.resolve(p).replace(/\\/g, "/");
	const isDir = (p: string) => !p.endsWith("missing");
	const r = addDirFolders([slash("/a")], ["/a", "/b", "missing", ".", "/b"], cwd, isDir);
	assert.deepEqual(r.folders, [slash("/a"), slash("/b")]);
	assert.equal(r.notes.length, 2);
	assert.match(r.notes[0], /--add-dir missing: not a folder/);
	assert.match(r.notes[1], /--add-dir \.: that is the working folder/);
});
