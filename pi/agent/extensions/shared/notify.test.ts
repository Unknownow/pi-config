// node --experimental-strip-types --test notify.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { notifyCommand } from "./notify.ts";

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
