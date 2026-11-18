// node --experimental-strip-types --test create-event.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAddRepo, parseCreate, parseRemove } from "./create-event.ts";

test("parseCreate accepts a good name", () => {
	assert.deepEqual(parseCreate({ v: 1, name: "o111-a" }), { name: "o111-a" });
});

test("parseCreate rejects a bad name with the checkName message, a wrong v and a non-string name", () => {
	assert.match((parseCreate({ v: 1, name: "Bad Name" }) as { error: string }).error, /bad name/);
	assert.match((parseCreate({ v: 1, name: "" }) as { error: string }).error, /give a name/);
	assert.ok("error" in parseCreate({ v: 2, name: "a" }));
	assert.ok("error" in parseCreate({ v: 1, name: 3 }));
	assert.ok("error" in parseCreate(null));
});

test("parseCreate accepts folders, rejects a non-array, and omits the field when absent", () => {
	assert.deepEqual(parseCreate({ v: 1, name: "a", folders: ["D:/x"] }), { name: "a", folders: ["D:/x"] });
	assert.ok("error" in parseCreate({ v: 1, name: "a", folders: "D:/x" }));
	assert.ok("error" in parseCreate({ v: 1, name: "a", folders: [1] }));
	assert.equal("folders" in (parseCreate({ v: 1, name: "a" }) as object), false);
});

test("parseCreate accepts launch none, rejects other values and omits it when absent", () => {
	assert.deepEqual(parseCreate({ v: 1, name: "a", launch: "none" }), { name: "a", launch: "none" });
	assert.deepEqual(parseCreate({ v: 1, name: "a", folders: ["D:/x"], launch: "none" }), { name: "a", folders: ["D:/x"], launch: "none" });
	assert.ok("error" in parseCreate({ v: 1, name: "a", launch: "window" }));
	assert.equal("launch" in (parseCreate({ v: 1, name: "a" }) as object), false);
});

test("parseRemove checks version, name and force", () => {
	assert.deepEqual(parseRemove({ v: 1, name: "a" }), { name: "a", force: false });
	assert.deepEqual(parseRemove({ v: 1, name: "a", force: true }), { name: "a", force: true });
	assert.ok("error" in parseRemove({ v: 2, name: "a" }));
	assert.ok("error" in parseRemove({ v: 1, name: "Bad Name" }));
	assert.ok("error" in parseRemove({ v: 1, name: "a", force: "yes" }));
	assert.ok("error" in parseRemove(null));
});

test("parseAddRepo checks version, name, folder and base", () => {
	assert.deepEqual(parseAddRepo({ v: 1, name: "a", folder: "D:/x" }), { name: "a", folder: "D:/x" });
	assert.deepEqual(parseAddRepo({ v: 1, name: "a", folder: "D:/x", base: " origin/dev " }), { name: "a", folder: "D:/x", base: "origin/dev" });
	assert.ok("error" in parseAddRepo({ v: 2, name: "a", folder: "D:/x" }));
	assert.ok("error" in parseAddRepo({ v: 1, name: "a" }));
	assert.ok("error" in parseAddRepo({ v: 1, name: "a", folder: "D:/x", base: "" }));
});
