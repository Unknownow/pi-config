import { test } from "node:test";
import assert from "node:assert/strict";
import { emitClaims, gatherClaims } from "./claims.ts";

type Claim = (p: unknown) => void;
const emitter = (...answers: unknown[]) => (d: unknown) => {
	for (const a of answers) (d as { claim: Claim }).claim(a);
};

test("no listener gives null", async () => {
	assert.equal(await gatherClaims(() => {}, {}, 100), null);
});

test("the first non-null answer wins over null", async () => {
	assert.deepEqual(await gatherClaims(emitter(Promise.resolve(null), Promise.resolve({ a: 1 }), Promise.resolve({ a: 2 })), {}, 100), { a: 1 });
	assert.equal(await gatherClaims(emitter(Promise.resolve(null)), {}, 100), null);
});

test("a rejection gives error", async () => {
	assert.deepEqual(await gatherClaims(emitter(Promise.reject(new Error("boom"))), {}, 100), { error: "boom" });
});

test("a timeout gives error", async () => {
	const r = (await gatherClaims(emitter(new Promise(() => {})), {}, 20)) as { error: string };
	assert.match(r.error, /no answer/);
});

test("timeoutMs 0 waits", async () => {
	const p = gatherClaims(emitter(new Promise((res) => setTimeout(() => res({ ok: true }), 60))), {}, 0);
	assert.deepEqual(await p, { ok: true });
});

test("a late claim is ignored", async () => {
	let late: Claim | undefined;
	const r = await gatherClaims((d) => { late = (d as { claim: Claim }).claim; }, {}, 50);
	late?.(Promise.resolve({ x: 1 }));
	assert.equal(r, null);
});

test("emitClaims reports claimed synchronously", () => {
	assert.equal(emitClaims(() => {}, {}, 10).claimed, false);
	const c = emitClaims(emitter(Promise.resolve(null)), {}, 10);
	assert.equal(c.claimed, true);
});

test("the payload reaches the listener with a claim", async () => {
	let got: any;
	await gatherClaims((d) => { got = d; }, { v: 1, name: "n" }, 10);
	assert.equal(got.v, 1);
	assert.equal(typeof got.claim, "function");
});
