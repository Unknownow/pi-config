// node --experimental-strip-types --test index.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

test("index.ts parses (the extension entry point is not imported by the other tests)", () => {
	assert.doesNotThrow(() => stripTypeScriptTypes(fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8")));
});
