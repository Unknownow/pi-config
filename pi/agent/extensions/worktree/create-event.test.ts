// node --experimental-strip-types --test create-event.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCreate } from "./create-event.ts";

test("parseCreate accepts a good name", () => {
	assert.deepEqual(parseCreate({ v: 1, name: "o111-a" }), { name: "o111-a" });
});

test("parseCreate rejects a bad name with the checkName message, a wrong v and a non-string name", () => {
	assert.match((parseCreate({ v: 1, name: "Bad Name" }) as { error: string }).error, /bad name/);
	assert.match((parseCreate({ v: 1, name: "" }) as { error: string }).error, /give a name/);
	assert.ok("error" in parseCreate({ v: 2, name: "a" }));
	assert.ok("error" in parseCreate({ v: 1, name: 3 }));
	assert.ok("error" in parseCreate(null));
});
