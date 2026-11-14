// node --experimental-strip-types --test critic.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "./config.ts";
import { draftRounds, runCritic } from "./steps/critic.ts";
import { brief } from "./test/env.ts";
import { cleanup, tmpDir } from "./test/helpers.ts";

const reply = (text: string) => async () => ({ ok: true, text, turns: 1, usage: {} as any, toolCalls: [] });
const FINDINGS = "- major - [locked] `brief` the locked cache decision is wrong fix: user\n  Why: x\n  Fix: y\n- minor - [authority] `brief` implies a delete fix: auto\n  Why: x\n  Fix: y\nVERDICT: FAIL";

test("a first call returns a new draft id; three calls run; the 4th says cap reached without running, even with a new title", async () => {
	const root = tmpDir();
	let runs = 0;
	const deps = { cfg: DEFAULTS, root, cwd: root, review: async (...a: unknown[]) => (runs++, reply(FINDINGS)()) };
	const first = await runCritic(deps, brief({ repo: "R" }));
	assert.ok(!("error" in first) && first.ran && first.round === 1 && /^d[0-9a-z]{6}$/.test(first.draft));
	if ("error" in first || !first.counts) return;
	assert.deepEqual(first.counts, { blocker: 0, major: 1, minor: 1, locked: 1, authority: 1 });
	const d = first.draft;
	assert.equal(draftRounds(root, d), 1);
	for (const n of [2, 3]) {
		const r = await runCritic(deps, brief({ repo: "R" }), d);
		assert.ok(!("error" in r) && r.ran && r.round === n);
	}
	const retitled = brief({ repo: "R" }).replace("Add a greeting file.", "A completely different title");
	const capped = await runCritic(deps, retitled, d);
	assert.ok(!("error" in capped) && !capped.ran && /cap reached/.test(capped.text));
	assert.equal(runs, 3);
	assert.equal(fs.readdirSync(path.join(root, "drafts", d, "critic")).length, 3);
	// a call without a draft starts a new count
	const again = await runCritic(deps, retitled);
	assert.ok(!("error" in again) && again.ran && again.round === 1 && again.draft !== d);
	// an unknown draft id is an error, not a new draft
	assert.ok("error" in (await runCritic(deps, retitled, "nonsense")));
	cleanup(root);
});

test("a critic error is retried once, then reported; an incomplete brief is flagged in the task", async () => {
	const root = tmpDir();
	let calls = 0;
	const err = await runCritic({ cfg: DEFAULTS, root, cwd: root, review: async () => (calls++, { ok: false, text: "", error: "boom", turns: 0, usage: {} as any, toolCalls: [] }) }, brief({ repo: "R" }));
	assert.ok("error" in err && /failed twice/.test(err.error));
	assert.equal(calls, 2);
	let task = "";
	await runCritic({ cfg: DEFAULTS, root, cwd: root, review: async (t: string) => ((task = t), reply("VERDICT: PASS")()) }, "## Goal\nonly a goal\n");
	assert.match(task, /The brief is incomplete/);
	cleanup(root);
});
