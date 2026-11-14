// node --experimental-strip-types --test mailbox.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { append, findReply, readFrom, takeNew } from "./mailbox.ts";
import { cleanup, tmpDir } from "./test/helpers.ts";

test("takeNew returns only new messages and skips unreadable lines", () => {
	const d = tmpDir();
	const f = path.join(d, "out.jsonl");
	append(f, { type: "note", text: "1" });
	fs.appendFileSync(f, "{broken\n");
	append(f, { type: "note", text: "2" });
	const bad: string[] = [];
	assert.deepEqual(takeNew<{ text: string }>(f, (l) => bad.push(l)).map((m) => m.text), ["1", "2"]);
	assert.deepEqual(bad, ["{broken"]);
	assert.deepEqual(takeNew(f), []);
	append(f, { type: "note", text: "3" });
	assert.deepEqual(takeNew<{ text: string }>(f).map((m) => m.text), ["3"]);
	cleanup(d);
});

test("a half-written last line waits for its newline", () => {
	const d = tmpDir();
	const f = path.join(d, "o.jsonl");
	fs.writeFileSync(f, '{"a":1}\n{"a":');
	const r = readFrom(f, 0);
	assert.equal(r.msgs.length, 1);
	fs.appendFileSync(f, "2}\n");
	assert.equal(readFrom(f, r.offset).msgs.length, 1);
	cleanup(d);
});

test("findReply matches replyTo", () => {
	const d = tmpDir();
	const f = path.join(d, "in.jsonl");
	append(f, { type: "answer", replyTo: "a1", text: "yes" });
	append(f, { type: "approve", replyTo: "a2", reason: "ok" });
	assert.equal(findReply(f, "a2")?.type, "approve");
	assert.equal(findReply(f, "zz"), undefined);
	cleanup(d);
});
