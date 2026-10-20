// node --experimental-strip-types --test boundary.test.ts
// The workflow extension never refers to other extensions; they depend on its public contract (README.md), not the other way round.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

test("workflow never refers to the worktree extension", () => {
	const dir = new URL(".", import.meta.url);
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
	assert.ok(files.length > 10);
	const banned = [".pi-set.json", "agent/live", "wt-backup", "worktree.json", '"wt/'];
	for (const f of files) {
		const text = fs.readFileSync(new URL(f, dir), "utf8");
		assert.ok(!/from\s+["'][^"']*\.\.\/worktree/.test(text), `${f} imports from ../worktree`);
		for (const b of banned) assert.ok(!text.includes(b), `${f} mentions ${b}`);
	}
});
