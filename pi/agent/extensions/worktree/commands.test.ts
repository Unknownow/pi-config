// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { WT_SUBS, isKnownWt, wtCompletions, wtDescription, wtUsage } from "./commands.ts";

test("the table values are the /wt subcommands", () => {
	assert.deepEqual(WT_SUBS.map((s) => s.value), ["new", "open", "use", "list", "update", "remove", "rename", "clean", "done", "unlink"]);
	assert.ok(WT_SUBS.every((s) => s.description && !s.description.includes("\n")));
	assert.ok(isKnownWt("rename") && !isKnownWt("rem"));
	assert.equal(wtUsage(), "Usage: /wt new [NAME] | open NAME | use [NAME] | list | update [NAME] | remove NAME | rename [OLD] [NEW] | clean | done | unlink PATH");
	assert.match(wtDescription(), /new \[NAME\], open NAME/);
});

test("subcommand completions come from the table; an entry with an argument ends in a space", () => {
	const items = wtCompletions("", () => [])!;
	assert.deepEqual(items.map((i) => i.label), WT_SUBS.map((s) => s.value));
	for (const [i, s] of WT_SUBS.entries()) {
		assert.equal(items[i].value, `${s.value}${s.arg ? " " : ""}`);
		assert.ok(items[i].description);
	}
	assert.deepEqual(wtCompletions("re", () => [])!.map((i) => i.value), ["remove ", "rename "]);
});

test("set names complete after open, use, update, remove and rename; never throw", () => {
	const sets = () => ["alpha", "beta"];
	assert.deepEqual(wtCompletions("open a", sets)!.map((i) => [i.value, i.label]), [["open alpha", "alpha"]]);
	assert.deepEqual(wtCompletions("remove ", sets)!.map((i) => i.value), ["remove alpha", "remove beta"]);
	assert.ok(wtCompletions("USE b", sets));
	assert.equal(wtCompletions("open z", sets), null);
	assert.equal(wtCompletions("new ", sets), null);
	assert.equal(wtCompletions("open alpha x", sets), null);
	assert.equal(wtCompletions("open ", () => { throw new Error("no dir"); }), null);
});

test("index.ts handles every table entry and builds usage and description from the table", () => {
	const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	for (const s of WT_SUBS) assert.ok(src.includes(`sub === "${s.value}"`), `no handler branch for ${s.value}`);
	assert.ok(src.includes("wtUsage()") && src.includes("wtDescription()") && src.includes("wtCompletions("));
});
