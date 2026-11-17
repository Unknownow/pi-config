// node --experimental-strip-types --test identity.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { HeldQueue, resolveAllPending } from "./identity.ts";

test("held events are replayed as a sub: the handler claims, an unclaimed one resolves null", async () => {
	const q = new HeldQueue<{ n: number }>();
	const a = q.hold({ n: 1 });
	const b = q.hold({ n: 2 });
	assert.equal(q.size, 2);
	q.replay((d, claim) => {
		if (d.n === 1) claim(Promise.resolve({ approve: true }));
	});
	assert.deepEqual(await a, { approve: true });
	assert.equal(await b, null);
	assert.equal(q.size, 0);
});

test("held events resolve null as not-sub, on a run end or at shutdown; a throwing handler leaves null", async () => {
	const q = new HeldQueue<number>();
	const a = q.hold(1);
	const b = q.hold(2);
	q.release();
	assert.equal(await a, null);
	assert.equal(await b, null);
	const c = q.hold(3);
	q.replay(() => {
		throw new Error("boom");
	});
	assert.equal(await c, null);
	assert.equal(q.size, 0);
});

test("resolveAllPending answers every open question once", () => {
	const got: string[] = [];
	const pending = new Map<string, (m: { text: string }) => void>([["q1", (m) => got.push(`1:${m.text}`)], ["q2", (m) => got.push(`2:${m.text}`)]]);
	assert.equal(resolveAllPending(pending, "ended"), 2);
	assert.deepEqual(got, ["1:ended", "2:ended"]);
	assert.equal(pending.size, 0);
	assert.equal(resolveAllPending(pending, "again"), 0);
});
