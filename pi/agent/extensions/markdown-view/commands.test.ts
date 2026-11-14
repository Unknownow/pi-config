// node --experimental-strip-types --test commands.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { VIEW_ARGS, viewCompletions, viewDescription } from "./commands.ts";
import { recentReplies } from "./view.ts";

const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });

test("the /view argument table and the description built from it", () => {
	assert.deepEqual(VIEW_ARGS.map((a) => a.value), ["N", "<path>"]);
	assert.ok(VIEW_ARGS.every((a) => a.description));
	assert.match(viewDescription(), /\/view \[N \| <path>\]$/);
});

test("recentReplies walks from the end and stops after max replies", () => {
	const entries: unknown[] = [msg("assistant", "old"), ...Array.from({ length: 12 }, (_, i) => msg("assistant", `r${i}`)), msg("user", "q"), { type: "custom" }, null];
	let reads = 0;
	const counted = new Proxy(entries, { get: (t, k) => (/^\d+$/.test(String(k)) ? (reads++, t[Number(k)]) : (t as any)[k]) });
	const r = recentReplies(counted, 10);
	assert.deepEqual(r, ["r11", "r10", "r9", "r8", "r7", "r6", "r5", "r4", "r3", "r2"]);
	assert.ok(reads <= 14, `read ${reads} entries`);
	assert.deepEqual(recentReplies([], 10), []);
	assert.deepEqual(recentReplies("nope" as any, 10), []);
});

test("viewCompletions lists reply numbers with their first line; null without a context or for a path", () => {
	const replies = () => ["\n  First line of newest\nmore", "second", "x".repeat(100)];
	const items = viewCompletions("", replies)!;
	assert.deepEqual(items.map((i) => [i.value, i.label, i.description]), [["1", "1", "First line of newest"], ["2", "2", "second"], ["3", "3", `${"x".repeat(79)}…`]]);
	assert.deepEqual(viewCompletions("2", replies)!.map((i) => i.value), ["2"]);
	assert.equal(viewCompletions("", () => null), null);
	assert.equal(viewCompletions("", () => []), null);
	assert.equal(viewCompletions("docs/a", replies), null);
	assert.equal(viewCompletions("", () => { throw new Error("x"); }), null);
});

test("index.ts captures the context at session_start and in the handler", () => {
	const src = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.ok(/pi\.on\("session_start", \(_e, ctx\) => \{\s*lastCtx = ctx;/.test(src));
	assert.ok(/handler: async \(args, ctx\) => \{\s*lastCtx = ctx;/.test(src));
	assert.ok(src.includes("viewCompletions(") && src.includes("viewDescription()"));
});
