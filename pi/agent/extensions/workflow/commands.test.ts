// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { FLOW_SUBS, FLOW_UNKNOWN, flowCompletions, isKnownFlow } from "./commands.ts";

const flowSt = (over = {}) => ({ roles: ["plan", "arbiter"], specOf: () => ({ model: "a/c" }), models: () => [{ provider: "a", id: "c" }], ...over });

test("the /flow table values equal the expected list (fable and opusplan included, plan force is second level)", () => {
	assert.deepEqual(FLOW_SUBS.map((s) => s.value), ["status", "board", "discuss", "plan", "approve", "execute", "off", "escalate", "fable", "back", "opusplan", "critic", "tokens", "model", "autopilot", "reload", "resume"]);
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

test("/flow second level is exactly plan force, autopilot on|off, critic cancel, model ...; resume has none", () => {
	assert.deepEqual(flowCompletions("plan ", flowSt())!.map((i) => i.value), ["plan force"]);
	assert.deepEqual(flowCompletions("autopilot ", flowSt())!.map((i) => i.value), ["autopilot on", "autopilot off"]);
	assert.deepEqual(flowCompletions("critic ", flowSt())!.map((i) => i.value), ["critic cancel"]);
	assert.deepEqual(flowCompletions("model ", flowSt())!.map((i) => i.value), ["model plan ", "model arbiter "]);
	assert.deepEqual(flowCompletions("model arbiter ", flowSt())!.map((i) => i.value), ["model arbiter a/c"]);
	assert.equal(flowCompletions("model arbiter ", flowSt({ models: () => [] })), null);
	for (const sub of ["resume", "status", "off"]) assert.equal(flowCompletions(`${sub} `, flowSt()), null, sub);
	assert.equal(flowCompletions("model arbiter ", flowSt({ specOf: () => { throw new Error("x"); } })), null);
});

test("the file with /flow handles every table entry and builds usage from the tables", () => {
	const flowDir = new URL("./flow/", import.meta.url);
	const candidates = [new URL("./index.ts", import.meta.url), ...fs.readdirSync(flowDir).filter((f) => f.endsWith(".ts")).map((f) => new URL(f, flowDir))];
	const holders = candidates.map((u) => fs.readFileSync(u, "utf8")).filter((t) => /registerCommand\("flow"/.test(t));
	assert.equal(holders.length, 1, "one file registers /flow");
	const src = holders[0];
	for (const s of FLOW_SUBS) assert.ok(src.includes(`case "${s.value}"`), `no case for /flow ${s.value}`);
	assert.ok(src.includes("FLOW_UNKNOWN(sub)"));
	assert.ok(!src.includes('registerCommand("folders"'), "/folders belongs to the workspace extension");
	assert.ok(!src.includes("const SUBCOMMANDS"));
});
