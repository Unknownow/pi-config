// node --experimental-strip-types --import ../agents/test-hooks.ts --test events.test.ts
// Lead mode is off inside any worktree set (a job set or a user set), and /relay on refuses there.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Activation, SET_REASON } from "./events.ts";
import { cleanup, tmpDir } from "./test/helpers.ts";

for (const name of ["myset", "r1a2b3c"]) {
	test(`inside a ${name === "myset" ? "non-job" : "job"} set: not eligible, decide is off, /relay on refuses`, async () => {
		const root = tmpDir();
		const sub = path.join(root, name, "repo", "src");
		fs.mkdirSync(sub, { recursive: true });
		fs.writeFileSync(path.join(root, name, ".pi-set.json"), "{}");
		const act = new Activation({ active: () => true, cwd: sub, role: undefined });
		assert.equal(act.eligible(), false);
		assert.equal(await act.decide(), false);
		assert.equal(act.reason, SET_REASON);
		assert.match(act.reason, /inside a worktree set; lead mode off \(run the lead from the main checkouts\)/);
		const r = await act.turnOn();
		assert.deepEqual(r, { ok: false, why: SET_REASON });
		cleanup(root);
	});
}

test("outside a set: eligible and on", async () => {
	const root = tmpDir();
	const act = new Activation({ active: () => true, cwd: root, role: undefined });
	assert.equal(act.eligible(), true);
	assert.equal(await act.decide(), true);
	cleanup(root);
});
