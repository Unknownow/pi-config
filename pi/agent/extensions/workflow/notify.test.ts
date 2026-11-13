// node --experimental-strip-types --test notify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { idleReason, notifyDue } from "./notify.ts";

test("idleReason", () => {
	assert.equal(idleReason({ phase: "execute", waiting: "publish core" }), "waiting for you: publish core");
	assert.equal(idleReason({ phase: "plan" }), "plan reply ready");
	assert.equal(idleReason({ phase: "discuss" }), "discuss reply ready");
	assert.equal(idleReason({ phase: "execute" }), "turn finished");
	assert.equal(idleReason({ phase: "off" }), "turn finished");
});

test("notifyDue", () => {
	const o = { enabled: true, hasUI: true, now: 100_000 };
	assert.equal(notifyDue({ ...o, enabled: false }), false);
	assert.equal(notifyDue({ ...o, hasUI: false }), false);
	assert.equal(notifyDue(o), true);
	assert.equal(notifyDue({ ...o, last: o.now - 14_999 }), false);
	assert.equal(notifyDue({ ...o, last: o.now - 15_000 }), true);
});
