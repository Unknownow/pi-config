// node --experimental-strip-types --test boundary.test.ts
// The agents extension works without the workflow: it imports only its own files and ../shared.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

test("agents imports nothing of another extension but ../shared", () => {
	const dir = new URL(".", import.meta.url);
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
	assert.ok(files.length > 3);
	for (const f of files) {
		const text = fs.readFileSync(new URL(f, dir), "utf8");
		const imports = [...text.matchAll(/from\s+["'](\.\.\/[^"']*)["']/g)].map((m) => m[1]).filter((i) => !i.startsWith("../shared/"));
		assert.deepEqual(imports, [], `${f} imports from ${imports.join(", ")}`);
	}
});
