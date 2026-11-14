// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { QUIET_SUBS, quietCompletions, quietDescription, quietUsage } from "./commands.ts";

test("the table values are on and off; usage and description come from it", () => {
	assert.deepEqual(QUIET_SUBS.map((s) => s.value), ["on", "off"]);
	assert.equal(quietUsage(), "quiet: usage /quiet [on|off]");
	assert.equal(quietDescription(), "Hide or show finished tool rows (/quiet toggles, /quiet on, /quiet off)");
});

test("completions are built from the table; nothing follows on or off", () => {
	assert.deepEqual(quietCompletions("")!.map((i) => [i.value, i.label, !!i.description]), [["on", "on", true], ["off", "off", true]]);
	assert.deepEqual(quietCompletions("of")!.map((i) => i.value), ["off"]);
	assert.equal(quietCompletions("on "), null);
	assert.equal(quietCompletions("x"), null);
});

test("index.ts builds its fallback from the table", () => {
	const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.ok(src.includes("isKnown(QUIET_SUBS, a)") && src.includes("quietUsage()") && src.includes("quietDescription()") && src.includes("quietCompletions("));
});
