// node --experimental-strip-types --test boundary.test.ts
// relay imports from ../shared only: never from the extensions it works next to.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const dir = path.dirname(fileURLToPath(import.meta.url));

function sources(d: string): string[] {
	return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(d, e.name);
		if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
		return /\.(ts|mjs)$/.test(e.name) ? [p] : [];
	});
}

test("relay imports nothing from workflow, orchestrate, worktree, agents or sandbox", () => {
	const bad: string[] = [];
	for (const f of sources(dir)) {
		if (f.endsWith("boundary.test.ts")) continue;
		const text = fs.readFileSync(f, "utf8");
		for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
			if (/\.\.\/(workflow|orchestrate|worktree|agents|sandbox|quiet-tools|markdown-view)(\/|$)/.test(m[1])) bad.push(`${path.basename(f)}: ${m[1]}`);
		}
	}
	assert.deepEqual(bad, []);
});
