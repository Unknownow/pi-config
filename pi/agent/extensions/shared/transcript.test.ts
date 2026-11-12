// node --experimental-strip-types --test transcript.test.ts
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// transcript.ts imports the pi package, which is not installed next to the tests; only clipMiddle is exercised.
registerHooks({
	resolve(specifier, context, next) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: "data:text/javascript,export const convertToLlm = () => []; export const serializeConversation = () => ''", shortCircuit: true };
		return next(specifier, context);
	},
});
const { clipMiddle } = await import("./transcript.ts");

test("clipMiddle leaves short text alone", () => {
	assert.equal(clipMiddle("abc", 10), "abc");
});

test("clipMiddle keeps 30% head and the tail, and counts the omitted characters", () => {
	const text = "h".repeat(30) + "x".repeat(900) + "t".repeat(70);
	const out = clipMiddle(text, 100);
	assert.ok(out.startsWith("h".repeat(30) + "\n\n[... 900 characters of the middle omitted ...]\n\n"));
	assert.ok(out.endsWith("t".repeat(70)));
	assert.ok(!out.includes("x"));
});
