// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { FLOW_SUBS, FLOW_UNKNOWN, FOLDERS_SUBS, flowCompletions, foldersCompletions, foldersDescription, foldersUsage, isKnownFlow } from "./commands.ts";

const flowSt = (over = {}) => ({ roles: ["planner", "judge"], specOf: () => ({ model: "a/c" }), models: () => [{ provider: "a", id: "c" }], ...over });
const foldersSt = (over = {}) => ({ cwd: "/w", home: "/h", readDirs: () => ["src", "docs"], folders: ["/x/one", "/y/two"], ...over });

test("the /flow table values equal the expected list (fable and opusplan included, plan force is second level)", () => {
	assert.deepEqual(FLOW_SUBS.map((s) => s.value), ["status", "board", "discuss", "plan", "quick", "approve", "execute", "off", "escalate", "fable", "back", "opusplan", "judge", "tokens", "model", "autopilot", "reload", "resume"]);
	assert.ok(FLOW_SUBS.every((s) => s.description && !s.description.includes("\n")));
	assert.ok(isKnownFlow("Fable") && !isKnownFlow("plan force"));
	assert.equal(FLOW_UNKNOWN("zz"), `Unknown: zz. Try: ${FLOW_SUBS.map((s) => s.value).join(", ")}`);
});

test("/flow top-level completions are built from the table; entries with a next level or argument end in a space", () => {
	const items = flowCompletions("", flowSt())!;
	assert.deepEqual(items.map((i) => i.label), FLOW_SUBS.map((s) => s.value));
	for (const [i, s] of FLOW_SUBS.entries()) {
		assert.equal(items[i].value, `${s.value}${s.arg || s.next ? " " : ""}`);
		assert.ok(items[i].description);
	}
	assert.deepEqual(flowCompletions("fa", flowSt())!.map((i) => i.value), ["fable"]);
	assert.deepEqual(flowCompletions("p", flowSt())!.map((i) => i.value), ["plan "]);
});

test("/flow second level is exactly plan force, autopilot on|off, judge cancel, model ...; resume has none", () => {
	assert.deepEqual(flowCompletions("plan ", flowSt())!.map((i) => i.value), ["plan force"]);
	assert.deepEqual(flowCompletions("autopilot ", flowSt())!.map((i) => i.value), ["autopilot on", "autopilot off"]);
	assert.deepEqual(flowCompletions("judge ", flowSt())!.map((i) => i.value), ["judge cancel"]);
	assert.deepEqual(flowCompletions("model ", flowSt())!.map((i) => i.value), ["model planner ", "model judge "]);
	assert.deepEqual(flowCompletions("model judge ", flowSt())!.map((i) => i.value), ["model judge a/c"]);
	assert.equal(flowCompletions("model judge ", flowSt({ models: () => [] })), null);
	for (const sub of ["resume", "status", "quick", "off"]) assert.equal(flowCompletions(`${sub} `, flowSt()), null, sub);
	assert.equal(flowCompletions("model judge ", flowSt({ specOf: () => { throw new Error("x"); } })), null);
});

test("/folders table, usage and completions", () => {
	assert.deepEqual(FOLDERS_SUBS.map((s) => s.value), ["add", "remove", "list"]);
	assert.equal(foldersUsage(), "Usage: /folders add PATH | remove PATH or N | list");
	assert.match(foldersDescription(), /add PATH, remove PATH or N, list$/);
	const items = foldersCompletions("", foldersSt())!;
	assert.deepEqual(items.map((i) => i.value), ["add ", "remove ", "list"]);
	assert.ok(items.every((i) => i.description));
	assert.deepEqual(foldersCompletions("remove ", foldersSt())!.map((i) => [i.value, i.label, i.description]), [["remove 1", "1", "/x/one"], ["remove 2", "2", "/y/two"]]);
	assert.deepEqual(foldersCompletions("remove /y", foldersSt())!.map((i) => i.value), ["remove 2"]);
	const add = foldersCompletions("add ", foldersSt())!;
	assert.ok(add.length > 0 && add.every((i) => i.value.startsWith("add ") && i.description));
	assert.equal(foldersCompletions("list ", foldersSt()), null);
	assert.equal(foldersCompletions("add ", foldersSt({ readDirs: () => { throw new Error("x"); } })), null);
});

test("index.ts handles every table entry and builds usage from the tables", () => {
	const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	for (const s of FLOW_SUBS) assert.ok(src.includes(`case "${s.value}"`), `no case for /flow ${s.value}`);
	assert.ok(src.includes("FLOW_UNKNOWN(sub)") && src.includes("foldersUsage()") && src.includes("foldersDescription()"));
	assert.ok(!src.includes("const SUBCOMMANDS"));
});
