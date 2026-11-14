// node --experimental-strip-types --test brief.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendAmendment, briefTitle, checkBrief, parseBrief, validateBrief } from "./brief.ts";

export const GOOD = `# Fix the thing

## Goal
Make x faster.

## Done when
- x runs in 10 ms
- tests pass

## Non-goals
- no UI

## Constraints
- keep the API

## Decisions (locked)
- use a map

## Design
Change x.ts.

## Scale
1000 items.

## Verify
npm test

## Targets
- D:/repo/app: main

## Authority
- merge: no
- publish: no
- comments: n/a
- delete: no
- formats: no
- deps: no
`;

test("a valid brief passes", () => {
	const r = checkBrief(GOOD);
	assert.ok("brief" in r, JSON.stringify(r));
	if (!("brief" in r)) return;
	assert.deepEqual(r.brief.targets, [{ repo: "D:/repo/app", branch: "main" }]);
	assert.equal(r.brief.authority.merge?.value, "no");
	assert.equal(r.brief.version, 1);
	assert.equal(briefTitle(GOOD), "Make x faster.");
});

test("a missing Authority key, merge yes without specifics, an empty Done when give errors", () => {
	const noKey = GOOD.replace("- deps: no\n", "");
	let r = checkBrief(noKey);
	assert.ok("errors" in r && r.errors.some((e) => e.includes('"deps" is missing')));
	r = checkBrief(GOOD.replace("- merge: no", "- merge: yes"));
	assert.ok("errors" in r && r.errors.some((e) => e.includes("merge: yes")));
	assert.ok(checkBrief(GOOD.replace("- merge: no", "- merge: yes (ff to main)")).hasOwnProperty("brief"));
	r = checkBrief(GOOD.replace("- x runs in 10 ms\n- tests pass\n", "nothing"));
	assert.ok("errors" in r && r.errors.some((e) => e.includes("Done when")));
	r = checkBrief(GOOD.replace("## Targets\n- D:/repo/app: main\n", ""));
	assert.ok("errors" in r && r.errors.some((e) => e.includes("Targets")));
});

test("deps yes needs no specifics; a bad Authority line is a format error", () => {
	assert.ok("brief" in checkBrief(GOOD.replace("- deps: no", "- deps: yes")));
	const p = parseBrief(GOOD.replace("- deps: no", "- deps: maybe"));
	assert.ok("errors" in p);
});

test("optional sections: Budget, Files, Depends on, Publish", () => {
	const text = `${GOOD.replace("- publish: no", "- publish: yes (npm publish)")}
## Budget
wall: 2h; tokens: 500k; size: large

## Files
- src/**
- docs/x.md

## Depends on
r1a2b3c

## Publish
- \`npm publish\`
`;
	const r = checkBrief(text);
	assert.ok("brief" in r, JSON.stringify(r));
	if (!("brief" in r)) return;
	assert.deepEqual(r.brief.budget, { wallMin: 120, tokens: 500_000, size: "large" });
	assert.deepEqual(r.brief.files, ["src/**", "docs/x.md"]);
	assert.equal(r.brief.dependsOn, "r1a2b3c");
	assert.deepEqual(r.brief.publish, ["npm publish"]);
	assert.ok("errors" in checkBrief(`${GOOD}\n## Publish\n- npm publish\n`), "Publish without publish: yes");
});

test("an amendment raises the version; the amendments are read back", () => {
	const a1 = appendAmendment(GOOD, "user", "also handle empty input");
	const a2 = appendAmendment(a1, "approval", "deps: package.json approved");
	const p = parseBrief(a2);
	assert.ok("version" in p);
	if (!("version" in p)) return;
	assert.equal(p.version, 3);
	assert.deepEqual(p.amendments.map((a) => [a.n, a.by]), [[1, "user"], [2, "approval"]]);
	assert.match(p.amendments[0].text, /empty input/);
	assert.equal(validateBrief(p).length, 0);
});
