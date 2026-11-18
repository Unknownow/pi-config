// node --experimental-strip-types --test meta.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { readMeta, writeMeta } from "./meta.ts";

test("meta round trip and tolerance", () => {
	const set = fs.mkdtempSync(path.join(os.tmpdir(), "meta-"));
	assert.equal(readMeta(set), null);
	const m = { v: 1 as const, created: "2026-10-21T10:00:00Z", branch: "wt/w1", repos: [{ main: "D:/p/game", dir: "game" }] };
	writeMeta(set, m);
	assert.deepEqual(readMeta(set), m);
	fs.writeFileSync(path.join(set, ".pi-set.json"), "garbage");
	assert.equal(readMeta(set), null);
	fs.writeFileSync(path.join(set, ".pi-set.json"), JSON.stringify({ v: 2 }));
	assert.equal(readMeta(set), null);
});
