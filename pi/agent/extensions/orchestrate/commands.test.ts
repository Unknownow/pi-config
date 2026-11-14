// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { ORCH_SUBS, isKnownOrch, orchCompletions, orchDescription, orchUsage } from "./commands.ts";

const pkgs = [{ id: "p1", state: "executing", goal: "Do the thing\nmore" }, { id: "p2", state: "merged" }];
const st = (packages: (() => typeof pkgs | null) = () => pkgs) => ({ packages });

test("the table values are the /orch subcommands", () => {
	assert.deepEqual(ORCH_SUBS.map((s) => s.value), ["start", "mode", "off", "go", "judge", "status", "board", "watch", "merge", "end"]);
	assert.ok(ORCH_SUBS.every((s) => s.description && !s.description.includes("\n")));
	assert.ok(isKnownOrch("merge") && !isKnownOrch("merged"));
	assert.equal(orchUsage(), "usage: /orch start [title] | mode | off | go [force] | judge [cancel] | status | board | watch | merge <id> [--force] | end");
	assert.match(orchDescription(), /^Orchestrator mode and run: start \[title\]/);
});

test("top-level completions are built from the table; an entry with an argument ends in a space", () => {
	const items = orchCompletions("", st())!;
	assert.deepEqual(items.map((i) => i.label), ORCH_SUBS.map((s) => s.value));
	for (const [i, s] of ORCH_SUBS.entries()) {
		assert.equal(items[i].value, `${s.value}${s.arg || s.next ? " " : ""}`);
		assert.ok(items[i].description);
	}
	assert.equal(items.find((i) => i.label === "merge")!.value, "merge ");
	assert.deepEqual(orchCompletions("s", st())!.map((i) => i.value), ["start ", "status"]);
});

test("go and judge have one second-level value; merge lists the run's packages, then --force", () => {
	assert.deepEqual(orchCompletions("go ", st())!.map((i) => i.value), ["go force"]);
	assert.deepEqual(orchCompletions("judge c", st())!.map((i) => i.value), ["judge cancel"]);
	assert.equal(orchCompletions("go x", st()), null);
	assert.deepEqual(orchCompletions("merge ", st())!.map((i) => [i.value, i.description]), [["merge p1 ", "executing: Do the thing"], ["merge p2 ", "merged"]]);
	assert.deepEqual(orchCompletions("merge p1 ", st())!.map((i) => i.value), ["merge p1 --force"]);
	assert.equal(orchCompletions("merge p1 --force ", st()), null);
	assert.equal(orchCompletions("merge ", st(() => null)), null); // no owned run, or a relay run
	assert.equal(orchCompletions("merge ", st(() => { throw new Error("x"); })), null);
	assert.equal(orchCompletions("status ", st()), null);
});

test("index.ts handles every table entry and builds its usage from the table", () => {
	const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	for (const s of ORCH_SUBS) assert.ok(src.includes(`sub === "${s.value}"`), `no handler branch for ${s.value}`);
	assert.ok(src.includes("orchUsage()") && src.includes("orchDescription()") && src.includes("isKnownOrch(sub)"));
	assert.ok(!src.includes("usage: /orch start [title] |"));
});
