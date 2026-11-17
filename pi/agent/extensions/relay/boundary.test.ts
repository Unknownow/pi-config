// node --experimental-strip-types --test boundary.test.ts
// relay imports from ../shared, and from agents only through its public api.ts; never from workflow or the other extensions.
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

/** Every import specifier of every relay source, with the file it is in. */
function imports(): { file: string; spec: string }[] {
	return sources(dir)
		.filter((f) => !f.endsWith("boundary.test.ts"))
		.flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => ({ file: path.relative(dir, f), spec: m[1] })));
}

test("relay imports agents only through agents/api.ts", () => {
	const bad = imports().filter((i) => /(^|\/)agents\//.test(i.spec) && !/(^|\/)\.\.\/agents\/api\.ts$/.test(i.spec));
	assert.deepEqual(bad, []);
	assert.ok(imports().some((i) => /\.\.\/agents\/api\.ts$/.test(i.spec)), "relay uses agents through api.ts");
});

test("relay imports nothing from workflow, worktree, sandbox, quiet-tools or markdown-view", () => {
	const bad = imports().filter((i) => /\.\.\/(workflow|worktree|sandbox|quiet-tools|markdown-view)(\/|$)/.test(i.spec));
	assert.deepEqual(bad, []);
});
