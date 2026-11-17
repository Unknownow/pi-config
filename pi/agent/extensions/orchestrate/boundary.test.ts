// node --experimental-strip-types --test boundary.test.ts
// orchestrate depends on the public contracts of workflow, worktree and relay (their READMEs), never on their code.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

test("orchestrate never imports from the workflow, worktree or relay extensions", () => {
	const dir = new URL(".", import.meta.url);
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
	assert.ok(files.length >= 5);
	for (const f of files) {
		const text = fs.readFileSync(new URL(f, dir), "utf8");
		assert.ok(!/(from\s+|import\s*\(?\s*|require\s*\(\s*)["'][^"']*\.\.\/(workflow|worktree|relay)\//.test(text), `${f} imports from workflow, worktree or relay`);
	}
});
