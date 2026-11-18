// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { FOLDERS_SUBS, WT_SUBS, foldersCompletions, foldersDescription, foldersUsage, isKnownFolders, isKnownWt, wtCompletions, wtDescription, wtUsage } from "./commands.ts";

const noSets = { sets: () => [] };
const twoSets = { sets: () => ["alpha", "beta"], linked: () => ["node_modules", ".pi/git"] };

test("the table values are the /wt subcommands", () => {
	assert.deepEqual(WT_SUBS.map((s) => s.value), ["new", "open", "use", "list", "update", "remove", "rename", "clean", "done", "unlink"]);
	assert.ok(WT_SUBS.every((s) => s.description && !s.description.includes("\n")));
	assert.ok(isKnownWt("rename") && !isKnownWt("rem"));
	assert.equal(wtUsage(), "Usage: /wt new [NAME] | open NAME | use [NAME] | list | update [NAME] | remove NAME | rename [OLD] [NEW] | clean | done | unlink PATH");
	assert.match(wtDescription(), /new \[NAME\], open NAME/);
});

test("subcommand completions come from the table; an entry with an argument ends in a space", () => {
	const items = wtCompletions("", noSets)!;
	assert.deepEqual(items.map((i) => i.label), WT_SUBS.map((s) => s.value));
	for (const [i, s] of WT_SUBS.entries()) {
		assert.equal(items[i].value, `${s.value}${s.arg ? " " : ""}`);
		assert.ok(items[i].description);
	}
	assert.deepEqual(wtCompletions("re", noSets)!.map((i) => i.value), ["remove ", "rename "]);
	assert.deepEqual(wtCompletions("d", noSets)!.map((i) => i.value), ["done"]);
});

test("set names complete after open, use, update, remove and rename; never throw", () => {
	assert.deepEqual(wtCompletions("open a", twoSets)!.map((i) => [i.value, i.label]), [["open alpha", "alpha"]]);
	assert.deepEqual(wtCompletions("remove ", twoSets)!.map((i) => i.value), ["remove alpha", "remove beta"]);
	assert.deepEqual(wtCompletions("update b", twoSets)!.map((i) => i.value), ["update beta"]);
	assert.ok(wtCompletions("USE b", twoSets));
	assert.equal(wtCompletions("open z", twoSets), null);
	assert.equal(wtCompletions("open alpha x", twoSets), null);
	assert.equal(wtCompletions("open ", { sets: () => { throw new Error("no dir"); } }), null);
});

test("use also offers original; rename's set name is followed by a space for the new name", () => {
	assert.deepEqual(wtCompletions("use ", twoSets)!.map((i) => i.value), ["use alpha", "use beta", "use original"]);
	assert.deepEqual(wtCompletions("use o", twoSets)!.map((i) => i.value), ["use original"]);
	assert.deepEqual(wtCompletions("rename al", twoSets)!.map((i) => i.value), ["rename alpha "]);
	assert.equal(wtCompletions("rename alpha ", twoSets), null, "the new name is free text");
});

test("unlink completes the set's linked paths; subcommands without arguments complete nothing more", () => {
	assert.deepEqual(wtCompletions("unlink ", twoSets)!.map((i) => i.value), ["unlink node_modules", "unlink .pi/git"]);
	assert.deepEqual(wtCompletions("unlink n", twoSets)!.map((i) => i.value), ["unlink node_modules"]);
	assert.equal(wtCompletions("unlink ", noSets), null, "outside a set nothing is linked");
	for (const sub of ["new", "list", "clean", "done"]) assert.equal(wtCompletions(`${sub} `, twoSets), null, sub);
});

test("index.ts handles every table entry and builds usage and description from the table", () => {
	const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	for (const s of WT_SUBS) assert.ok(src.includes(`sub === "${s.value}"`), `no handler branch for ${s.value}`);
	assert.ok(src.includes("wtUsage()") && src.includes("wtDescription()") && src.includes("wtCompletions("));
});

const foldersSt = (over = {}) => ({ cwd: "/w", home: "/h", readDirs: () => ["src", "docs"], folders: ["/x/one", "/y/two"], ...over });

test("/folders table, usage and subcommand completions", () => {
	assert.deepEqual(FOLDERS_SUBS.map((s) => s.value), ["add", "remove", "list"]);
	assert.ok(isKnownFolders("add") && !isKnownFolders("ad"));
	assert.equal(foldersUsage(), "Usage: /folders add PATH | remove PATH or N | list");
	assert.match(foldersDescription(), /add PATH, remove PATH or N, list$/);
	const items = foldersCompletions("", foldersSt())!;
	assert.deepEqual(items.map((i) => i.value), ["add ", "remove ", "list"]);
	assert.ok(items.every((i) => i.description));
	assert.deepEqual(foldersCompletions("r", foldersSt())!.map((i) => i.value), ["remove "]);
	assert.equal(foldersCompletions("list ", foldersSt()), null);
});

test("/folders add completes folder paths, subfolders as you type", () => {
	const tree: Record<string, string[]> = { "": ["src", "docs", "my dir"], src: ["lib", "app"] };
	const readDirs = (dir: string) => tree[dir.replace(/\\/g, "/").replace(/^([A-Za-z]:)?\/w\/?/, "")] ?? null;
	const add = foldersCompletions("add ", foldersSt({ readDirs }))!;
	assert.deepEqual(add.map((i) => i.value), ["add docs/", 'add "my dir/"', "add src/"]);
	assert.ok(add.every((i) => i.description));
	assert.deepEqual(foldersCompletions("add src/", foldersSt({ readDirs }))!.map((i) => i.value), ["add src/app/", "add src/lib/"]);
	assert.deepEqual(foldersCompletions("add src/l", foldersSt({ readDirs }))!.map((i) => i.value), ["add src/lib/"]);
	assert.equal(foldersCompletions("add ", foldersSt({ readDirs: () => { throw new Error("x"); } })), null);
});

test("/folders remove completes the added folders and their numbers", () => {
	assert.deepEqual(foldersCompletions("remove ", foldersSt())!.map((i) => [i.value, i.label, i.description]), [["remove 1", "1", "/x/one"], ["remove 2", "2", "/y/two"]]);
	assert.deepEqual(foldersCompletions("remove 2", foldersSt())!.map((i) => i.value), ["remove 2"]);
	assert.deepEqual(foldersCompletions("remove /y", foldersSt())!.map((i) => i.value), ["remove 2"]);
	assert.equal(foldersCompletions("remove ", foldersSt({ folders: [] })), null);
});
