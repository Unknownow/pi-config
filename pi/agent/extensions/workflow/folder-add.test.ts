// node --experimental-strip-types --test folder-add.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { askFolderAdd, type FolderAddAnswer } from "./folder-add.ts";

type Claim = (p: Promise<FolderAddAnswer>) => void;
const ask = (listeners: ((claim: Claim) => void)[], timeoutMs?: number) =>
	askFolderAdd((d) => listeners.forEach((l) => l((d as { claim: Claim }).claim)), "D:/w", "D:/orig", timeoutMs);

test("no listener keeps the folder", async () => {
	assert.deepEqual(await ask([]), { folder: "D:/orig" });
});
test("null answers keep the folder", async () => {
	assert.deepEqual(await ask([(c) => c(Promise.resolve(null))]), { folder: "D:/orig" });
});
test("a replacement is used", async () => {
	assert.deepEqual(await ask([(c) => c(Promise.resolve({ folder: "D:/wt/w1/x" }))]), { folder: "D:/wt/w1/x" });
});
test("the first replacement wins", async () => {
	assert.deepEqual(await ask([(c) => c(Promise.resolve({ folder: "A" })), (c) => c(Promise.resolve({ folder: "B" }))]), { folder: "A" });
});
test("an error wins over a replacement", async () => {
	assert.deepEqual(await ask([(c) => c(Promise.resolve({ folder: "A" })), (c) => c(Promise.resolve({ error: "boom" }))]), { error: "boom" });
});
test("a rejected claim is an error", async () => {
	assert.deepEqual(await ask([(c) => c(Promise.reject(new Error("bad")))]), { error: "bad" });
});
test("a claim that never settles times out", async () => {
	const r = await ask([(c) => c(new Promise(() => {}))], 20);
	assert.ok("error" in r && r.error.includes("within"));
});
test("late claims are ignored", async () => {
	let saved: Claim | undefined;
	const r = await ask([(c) => { saved = c; }]);
	saved?.(Promise.resolve({ error: "late" }));
	saved?.(Promise.reject(new Error("late")));
	assert.deepEqual(r, { folder: "D:/orig" });
});
test("invalid answers count as null", async () => {
	assert.deepEqual(await ask([(c) => c(Promise.resolve({ folder: "" })), (c) => c(Promise.resolve(42 as never))]), { folder: "D:/orig" });
});
test("a plain object rejection uses its message", async () => {
	assert.deepEqual(await ask([(c) => c(Promise.reject({ message: "x" }))]), { error: "x" });
});
