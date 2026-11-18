// node --experimental-strip-types --test boundary.test.ts
// Agents is a library other extensions use: it imports only its own files and ../shared, never workflow,
// relay or workspace.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

const dir = new URL(".", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
const importsOf = (f: string) => [...fs.readFileSync(new URL(f, dir), "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.\.\/[^"']*)["']/g)].map((m) => m[1]);

test("agents imports nothing of another extension but ../shared", () => {
	assert.ok(files.length > 3);
	for (const f of files) {
		const imports = importsOf(f).filter((i) => !i.startsWith("../shared/"));
		assert.deepEqual(imports, [], `${f} imports from ${imports.join(", ")}`);
	}
});

test("agents imports nothing from workflow, relay or workspace", () => {
	for (const f of files) {
		const bad = importsOf(f).filter((i) => /^\.\.\/(workflow|relay|workspace)\//.test(i));
		assert.deepEqual(bad, [], `${f} imports from ${bad.join(", ")}`);
	}
});

test("api.ts only re-exports", () => {
	const text = fs.readFileSync(new URL("api.ts", dir), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
	const statements = text.split(";").map((s) => s.trim()).filter(Boolean);
	for (const s of statements) assert.match(s, /^export (type )?\{[\s\S]*\} from "\.{1,2}\/[^"]+"$/, s);
});
