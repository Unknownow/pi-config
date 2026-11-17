// node --experimental-strip-types --test k11-sites.test.ts
// Source scan of index.ts: every K11 question names its site, every endFlow call names how the flow ended.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("acceptanceProblem is called from the three known sites", () => {
	const calls = [...source.matchAll(/acceptanceProblem\(([^,)]+),/g)].map((m) => m[1].trim());
	const callSites = calls.filter((c) => c !== "site: K11Site");
	assert.deepEqual(callSites, ['"publish"', '"git-task"', "kind"]);
});

test("every endFlow call says finished or stopped", () => {
	const calls = [...source.matchAll(/await endFlow\(([^)]*)\)/g)].map((m) => m[1]);
	assert.ok(calls.length >= 8);
	for (const c of calls) assert.match(c, /^ctx, "(finished|stopped)"$/);
});
