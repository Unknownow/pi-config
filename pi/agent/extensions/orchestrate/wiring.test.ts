// node --experimental-strip-types --test wiring.test.ts
// Source scan of index.ts: the flow-ended message comes only from the K14 handler.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test('post("flow-ended" appears once, inside the workflow:flow-end handler after the me/started guard', () => {
	const posts = [...source.matchAll(/post\("flow-ended"/g)];
	assert.equal(posts.length, 1);
	const handler = source.indexOf('pi.events.on("workflow:flow-end"');
	assert.ok(handler >= 0);
	const guard = source.indexOf("if (!me || !started) return;", handler);
	assert.ok(guard > handler);
	assert.ok(posts[0].index! > guard);
	assert.ok(posts[0].index! - handler < 800, "the post is inside the handler");
});
