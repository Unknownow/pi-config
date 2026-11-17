// node --experimental-strip-types --test ui-guard.test.ts
// Every menu that waits for a person goes through askUser (it notifies first).
// The only direct UI prompts left are the ones a typed command or a typed message opens.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

/** Names of the blocks that may open a prompt themselves. */
const ALLOWED = new Set(["askUser", "resumeFlow", 'pi.on("input"', 'case "board"', 'case "model"']);

const UI_CALL = /\bui\.(select|confirm|input|custom)\s*[(<]/;
const BLOCK = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:fl\.)?(pi\.on\("\w+")|^\s*(?:fl\.)?(pi\.register\w+\("\w+")|^\s*(case\s+"\w+")\s*:/;

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

/** The workflow's source files (index.ts, the other modules and flow/*.ts), relative to this folder. */
function sourceFiles(): string[] {
	const dir = new URL(".", import.meta.url);
	const own = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
	const flow = fs.readdirSync(new URL("flow/", dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
	return [...own, ...flow.map((f) => `flow/${f}`)];
}

test("workflow opens UI prompts only in the allowed blocks", () => {
	const dir = new URL(".", import.meta.url);
	const files = sourceFiles();
	assert.ok(files.includes("index.ts") && files.includes("flow/context.ts"));
	for (const f of files) {
		const bad = promptsOutsideAllowlist(fs.readFileSync(new URL(f, dir), "utf8"));
		assert.deepEqual(bad, [], `${f}: a UI prompt outside askUser skips the notification`);
	}
});

test("the allowed blocks are really used (the scan is not vacuous)", () => {
	const found = new Set<string>();
	for (const f of sourceFiles()) {
		const lines = fs.readFileSync(new URL(f, import.meta.url), "utf8").split("\n");
		let block = "";
		for (const line of lines) {
			const m = BLOCK.exec(line);
			if (m) block = (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\s+/g, " ");
			if (UI_CALL.test(line)) found.add(block);
		}
	}
	for (const b of found) assert.ok(ALLOWED.has(b), b);
	assert.ok(found.has("askUser") && found.has('pi.on("input"'));
});

test("a direct ctx.ui.select outside the allowlist fails the scan", () => {
	const fixture = ["\tfunction other(ctx) {", "\t\treturn ctx.ui.select(\"t\", [\"a\"]);", "\t}"].join("\n");
	assert.equal(promptsOutsideAllowlist(fixture).length, 1);
	const moved = ["export async function other(fl, ctx) {", "\treturn ctx.ui.select(\"t\", [\"a\"]);", "}"].join("\n");
	assert.equal(promptsOutsideAllowlist(moved).length, 1);
	const ok = ["\tfunction askUser(ctx) {", "\t\treturn ctx.ui.select(\"t\", [\"a\"]);", "\t}"].join("\n");
	assert.deepEqual(promptsOutsideAllowlist(ok), []);
});
