// node --experimental-strip-types --test exec.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { execRunner } from "./exec.ts";

test("execRunner returns output, exit codes and failures without throwing", async () => {
	const node = execRunner(process.execPath, 10000);
	const ok = await node(process.cwd(), ["-e", "process.stdout.write('hi')"]);
	assert.deepEqual([ok.code, ok.stdout], [0, "hi"]);
	const bad = await node(process.cwd(), ["-e", "process.stderr.write('no'); process.exit(3)"]);
	assert.equal(bad.code, 3);
	assert.match(bad.stderr, /no/);
	const missing = await execRunner("definitely-not-a-program-xyz", 5000)(process.cwd(), []);
	assert.notEqual(missing.code, 0);
	const slow = await execRunner(process.execPath, 200)(process.cwd(), ["-e", "setTimeout(()=>{}, 5000)"]);
	assert.notEqual(slow.code, 0);
});
