// node --experimental-strip-types --test notify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { idleReason, notifyCommand, notifyDue } from "./notify.ts";

test("notifyCommand per platform", () => {
	const w = notifyCommand("win32", "pi", "game: plan ready");
	assert.equal(w?.command, "powershell.exe");
	assert.ok(w?.args.includes("-NoProfile"));
	const script = w?.args[w.args.length - 1] ?? "";
	assert.ok(script.includes("ToastNotificationManager") && script.includes("game: plan ready"));
	const esc = notifyCommand("win32", "it's", "a<b");
	const s2 = esc?.args[esc.args.length - 1] ?? "";
	assert.ok(s2.includes("it&apos;s"));
	const q = notifyCommand("win32", "t", "a’; x; ’b");
	const s3 = q?.args[q.args.length - 1] ?? "";
	assert.ok(!/[‘’‚‛]/.test(s3));
	assert.ok(s2.includes("a&lt;b") && !s2.includes("a<b"));
	const m = notifyCommand("darwin", 'a"b', "x");
	assert.equal(m?.command, "osascript");
	assert.ok(m?.args[1].includes("display notification") && m.args[1].includes('a\\"b'));
	assert.deepEqual(notifyCommand("linux", "t", "b"), { command: "notify-send", args: ["t", "b"] });
	assert.equal(notifyCommand("aix", "t", "b"), null);
});

test("idleReason", () => {
	assert.equal(idleReason({ phase: "execute", waiting: "publish core" }), "waiting for you: publish core");
	assert.equal(idleReason({ phase: "plan" }), "plan reply ready");
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
