// node --experimental-strip-types --test ui-guard.test.ts
// An orchestrated session must never ask a person at the keyboard: every menu goes through askUser (K12).
// The only direct UI prompts left are the ones a typed command or a typed message opens.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

/** Names of the blocks that may open a prompt themselves. */
const ALLOWED = new Set(["askUser", "resumeFlow", 'pi.on("input"', 'case "board"', 'case "model"']);

const UI_CALL = /\bui\.(select|confirm|input|custom)\s*[(<]/;
const BLOCK = /^\s*(?:async\s+)?function\s+(\w+)|^\s*(pi\.on\("\w+")|^\s*(pi\.register\w+\("\w+")|^\s*(case\s+"\w+")\s*:/;

/** The UI prompts in `source` that sit outside the allowed blocks, as `line: enclosing block`. */
export function promptsOutsideAllowlist(source: string): string[] {
	const lines = source.split("\n");
	const bad: string[] = [];
	let block = "";
	for (let i = 0; i < lines.length; i++) {
		const m = BLOCK.exec(lines[i]);
		if (m) block = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\s+/g, " ");
		if (UI_CALL.test(lines[i]) && !/^\s*(\/\/|\*)/.test(lines[i]) && !ALLOWED.has(block)) bad.push(`${i + 1}: ${block || "(top level)"}`);
	}
	return bad;
}

test("workflow opens UI prompts only in the allowed blocks", () => {
	const dir = new URL(".", import.meta.url);
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
	assert.ok(files.includes("index.ts"));
	for (const f of files) {
		const bad = promptsOutsideAllowlist(fs.readFileSync(new URL(f, dir), "utf8"));
		assert.deepEqual(bad, [], `${f}: a UI prompt outside askUser would block an orchestrated session`);
	}
});

test("the allowed blocks are really used (the scan is not vacuous)", () => {
	const src = fs.readFileSync(new URL("index.ts", import.meta.url), "utf8");
	const found = new Set<string>();
	const lines = src.split("\n");
	let block = "";
	for (const line of lines) {
		const m = BLOCK.exec(line);
		if (m) block = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\s+/g, " ");
		if (UI_CALL.test(line)) found.add(block);
	}
	for (const b of found) assert.ok(ALLOWED.has(b), b);
	assert.ok(found.has("askUser") && found.has('pi.on("input"'));
});

test("a direct ctx.ui.select outside the allowlist fails the scan", () => {
	const fixture = ["\tfunction other(ctx) {", "\t\treturn ctx.ui.select(\"t\", [\"a\"]);", "\t}"].join("\n");
	assert.equal(promptsOutsideAllowlist(fixture).length, 1);
	const ok = ["\tfunction askUser(ctx) {", "\t\treturn ctx.ui.select(\"t\", [\"a\"]);", "\t}"].join("\n");
	assert.deepEqual(promptsOutsideAllowlist(ok), []);
});
