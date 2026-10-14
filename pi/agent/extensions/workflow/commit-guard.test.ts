// node --test commit-guard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGuardSpec } from "./commit-guard.ts";

test("a valid spec round-trips", () => {
	const spec = { protectedBranches: ["main"], mode: "pr", repos: [{ root: "/a", mode: "push" }] };
	assert.deepEqual(parseGuardSpec(JSON.stringify(spec)), spec);
});

test("missing repos default to none", () => {
	assert.deepEqual(parseGuardSpec('{"protectedBranches":["main"],"mode":"push"}'), { protectedBranches: ["main"], mode: "push", repos: [] });
});

for (const raw of [undefined, "{", "[]", '{"protectedBranches":"main"}', '{"protectedBranches":[],"repos":[{"root":1}]}']) {
	test(`malformed gives null: ${raw}`, () => assert.equal(parseGuardSpec(raw), null));
}
