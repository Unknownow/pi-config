// node --experimental-strip-types --test boundary.test.ts
// Shared code belongs to no extension, so it imports none of them: a `../` import must stay inside shared/.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function tsFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) return e.name === "node_modules" ? [] : tsFiles(p);
		return e.name.endsWith(".ts") ? [p] : [];
	});
}

/** The relative imports of `file` that resolve outside shared/. */
export function importsOutside(file: string, text: string, sharedRoot: string): string[] {
	return [...text.matchAll(/from\s+["'](\.\.?\/[^"']*)["']/g)]
		.map((m) => m[1])
		.filter((i) => {
			const rel = path.relative(sharedRoot, path.resolve(path.dirname(file), i));
			return rel.startsWith("..") || path.isAbsolute(rel);
		});
}

test("shared imports nothing outside shared, subfolders included", () => {
	const files = tsFiles(root).filter((f) => f !== fileURLToPath(import.meta.url)); // its own test strings are not imports
	assert.ok(files.length > 3);
	assert.ok(files.some((f) => path.dirname(f) !== root), "subfolders are scanned");
	for (const f of files) {
		const bad = importsOutside(f, fs.readFileSync(f, "utf8"), root);
		assert.deepEqual(bad, [], `${path.relative(root, f)} imports from ${bad.join(", ")}`);
	}
});

test("a ../ import is allowed only when it resolves inside shared/", () => {
	const inGit = path.join(root, "git", "x.ts");
	assert.deepEqual(importsOutside(inGit, `import { a } from "../repos.ts";`, root), []);
	assert.deepEqual(importsOutside(inGit, `import { a } from "../../agents/api.ts";`, root), ["../../agents/api.ts"]);
	assert.deepEqual(importsOutside(path.join(root, "x.ts"), `import { a } from "../workflow/x.ts";`, root), ["../workflow/x.ts"]);
});
