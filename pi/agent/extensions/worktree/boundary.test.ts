// node --experimental-strip-types --test boundary.test.ts
// The worktree extension may use only the workflow's public contract (see workflow/README.md), never its code or state.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

test("worktree uses only the public contract of the workflow extension", () => {
	const dir = new URL(".", import.meta.url);
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
	assert.ok(files.length > 5);
	for (const f of files) {
		const text = fs.readFileSync(new URL(f, dir), "utf8");
		// Code shared with the workflow (the shell parser) comes from ../shared, never from ../workflow.
		const imports = [...text.matchAll(/from\s+["']([^"']*\.\.\/workflow[^"']*)["']/g)].map((m) => m[1]);
		assert.deepEqual(imports, [], `${f} imports from ../workflow`);
		assert.ok(!text.includes("workflow-state"), `${f} mentions workflow-state`);
	}
});
