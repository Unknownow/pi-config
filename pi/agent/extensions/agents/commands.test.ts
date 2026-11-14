// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { AGENTS_SUBS, agentsCompletions, agentsDescription, agentsUnknown } from "./commands.ts";

const st = (over = {}) => ({ roles: ["explore", "advisor", "test_run"], specOf: () => ({ model: "a/c" }), models: () => [{ provider: "a", id: "c" }], ...over });

test("the table values equal the /agents subcommands", () => {
	assert.deepEqual(AGENTS_SUBS.map((s) => s.value), ["status", "model"]);
	assert.ok(AGENTS_SUBS.every((s) => s.description && !s.description.includes("\n")));
	assert.equal(agentsUnknown("x"), "agents: unknown x. Try: status, model");
	assert.match(agentsDescription(), /: status, model \[role\] \[provider\/id\[:thinking\]\]$/);
});

test("completions are built from the table; model ends in a space so the chain continues", () => {
	const items = agentsCompletions("", st())!;
	assert.deepEqual(items.map((i) => [i.value, i.label]), [["status", "status"], ["model ", "model"]]);
	assert.ok(items.every((i) => i.description));
	assert.deepEqual(agentsCompletions("mo", st())!.map((i) => i.value), ["model "]);
});

test("model walks roles, models, thinking levels", () => {
	assert.deepEqual(agentsCompletions("model e", st())!.map((i) => [i.value, i.description]), [["model explore ", "a/c"]]);
	assert.deepEqual(agentsCompletions("model explore ", st())!.map((i) => i.value), ["model explore a/c"]);
	assert.equal(agentsCompletions("model explore a/c:", st())!.length, 7);
	assert.equal(agentsCompletions("status ", st()), null);
	assert.equal(agentsCompletions("model explore ", st({ models: () => [] })), null);
	assert.equal(agentsCompletions("model ", st({ specOf: () => { throw new Error("bad config"); } })), null);
});

test("index.ts builds its description and unknown-subcommand text from the table", () => {
	const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.ok(src.includes("agentsDescription()") && src.includes("agentsUnknown(sub)") && src.includes("agentsCompletions("));
	for (const s of AGENTS_SUBS) assert.ok(src.includes(`sub === "${s.value}"`) || src.includes(`sub !== "${s.value}"`), s.value);
});
