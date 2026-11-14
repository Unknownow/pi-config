// node --experimental-strip-types --test pi-bin.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { piCommand, piInvocation } from "./pi-bin.ts";

test("an absolute .mjs path runs under the current runtime", () => {
	const c = piCommand(["--mode", "rpc"], { RELAY_PI_BIN: "/abs/fake-pi.mjs" });
	assert.deepEqual(c, { command: process.execPath, args: ["/abs/fake-pi.mjs", "--mode", "rpc"] });
	assert.deepEqual(piCommand(["x"], { RELAY_PI_BIN: "/abs/f.js" }).args, ["/abs/f.js", "x"]);
	assert.deepEqual(piCommand(["x"], { RELAY_PI_BIN: "/abs/f.ts" }).args, ["--experimental-strip-types", "/abs/f.ts", "x"]);
});

test("any other value is a command", () => {
	assert.deepEqual(piCommand(["-p"], { RELAY_PI_BIN: "my-pi" }), { command: "my-pi", args: ["-p"] });
});

test("unset falls back to piInvocation", () => {
	assert.deepEqual(piCommand(["a"], {}), piInvocation(["a"]));
});
