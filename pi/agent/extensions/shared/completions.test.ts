// node --experimental-strip-types --test completions.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isKnown, safe, subcommandCompletions, usageLine, valueList, words, type Sub } from "./completions.ts";

const table: Sub[] = [
	{ value: "status", description: "show" },
	{ value: "merge", description: "merge one", arg: "<id>" },
	{ value: "go", description: "run", next: true },
];

test("subcommandCompletions filters by prefix, adds a space when something follows, and has descriptions", () => {
	assert.deepEqual(subcommandCompletions(table, ""), [
		{ value: "status", label: "status", description: "show" },
		{ value: "merge ", label: "merge", description: "<id> merge one" },
		{ value: "go ", label: "go", description: "run" },
	]);
	assert.deepEqual(subcommandCompletions(table, "ME", "x ")!.map((i) => i.value), ["x merge "]);
	assert.equal(subcommandCompletions(table, "zzz"), null);
});

test("isKnown, safe, usage helpers", () => {
	assert.ok(isKnown(table, "go"));
	assert.ok(!isKnown(table, "gone"));
	assert.equal(safe(() => { throw new Error("x"); }), null);
	assert.equal(safe(() => 3), 3);
	assert.equal(valueList(table), "status, merge, go");
	assert.equal(usageLine(table), "status | merge <id> | go");
	assert.deepEqual(words(" model  a "), ["model", "a", ""]);
	assert.deepEqual(words("model "), ["model", ""]);
});
