// node --experimental-strip-types --import ../agents/test-hooks.ts --test critic.test.ts
// relay_critic's rounds: the draft count, the cap, the retry, the agents runCritic request and the saved round cost.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "./config.ts";
import { BRIEF_CRITERIA, CRITIC_ABOUT } from "./reviews.ts";
import { criticRound, draftRounds } from "./steps/critic.ts";
import type { CriticCall } from "./types.ts";
import { draftCriticCost } from "./usage.ts";
import { brief, reviewOf } from "./test/env.ts";
import { cleanup, tmpDir } from "./test/helpers.ts";

const FINDINGS = "- major - [scope][locked] `brief` - the locked cache decision is wrong fix: user\n  Why: x\n  Fix: y\n- minor - [scope][authority] `brief` - implies a delete fix: auto\n  Why: x\n  Fix: y\nVERDICT: FAIL";

test("a first call returns a new draft id; three calls run; the 4th says cap reached without running, even with a new title", async () => {
	const root = tmpDir();
	let runs = 0;
	const deps = { cfg: DEFAULTS, root, cwd: root, critic: async () => (runs++, reviewOf(FINDINGS)) };
	const first = await criticRound(deps, brief({ repo: "R" }));
	assert.ok(!("error" in first) && first.ran && first.round === 1 && /^d[0-9a-z]{6}$/.test(first.draft));
	if ("error" in first || !first.counts) return;
	assert.deepEqual(first.counts, { blocker: 0, major: 1, minor: 1, locked: 1, authority: 1 });
	const d = first.draft;
	assert.equal(draftRounds(root, d), 1);
	for (const n of [2, 3]) {
		const r = await criticRound(deps, brief({ repo: "R" }), d);
		assert.ok(!("error" in r) && r.ran && r.round === n);
	}
	const retitled = brief({ repo: "R" }).replace("Add a greeting file.", "A completely different title");
	const capped = await criticRound(deps, retitled, d);
	assert.ok(!("error" in capped) && !capped.ran && /cap reached/.test(capped.text));
	assert.equal(runs, 3);
	assert.deepEqual(fs.readdirSync(path.join(root, "drafts", d, "critic")).sort(), ["round-1.json", "round-1.md", "round-2.json", "round-2.md", "round-3.json", "round-3.md"]);
	// a call without a draft starts a new count
	const again = await criticRound(deps, retitled);
	assert.ok(!("error" in again) && again.ran && again.round === 1 && again.draft !== d);
	// an unknown draft id is an error, not a new draft
	assert.ok("error" in (await criticRound(deps, retitled, "nonsense")));
	cleanup(root);
});

test("the critic gets the brief as the document, about 'relay brief', relay's brief rules; each round's weightedCost is saved, failed tries included", async () => {
	const root = tmpDir();
	const calls: CriticCall[] = [];
	let n = 0;
	const deps = { cfg: DEFAULTS, root, cwd: root, critic: async (req: CriticCall) => (calls.push(req), n++ === 0 ? reviewOf("", 40, false) : reviewOf("VERDICT: PASS", 250)) };
	const r = await criticRound(deps, brief({ repo: "R" }));
	assert.ok(!("error" in r));
	if ("error" in r) return;
	assert.equal(calls.length, 2, "a failed run is retried once");
	assert.equal(calls[0].document, brief({ repo: "R" }));
	assert.ok(calls[0].criteria.startsWith(BRIEF_CRITERIA));
	assert.match(calls[0].criteria, /\[locked\]/);
	assert.match(calls[0].criteria, /\[authority\]/);
	assert.match(calls[0].criteria, new RegExp(`draft ${r.draft}, round 1 of 3`));
	assert.equal(CRITIC_ABOUT, "relay brief");
	const dir = path.join(root, "drafts", r.draft, "critic");
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "round-1.json"), "utf8")).weightedCost, 290);
	assert.equal(draftCriticCost(dir), 290);
	cleanup(root);
});

test("a critic error is retried once, then reported (its cost still saved); an incomplete brief is flagged in the criteria", async () => {
	const root = tmpDir();
	let calls = 0;
	const err = await criticRound({ cfg: DEFAULTS, root, cwd: root, critic: async () => (calls++, reviewOf("", 30, false)) }, brief({ repo: "R" }));
	assert.ok("error" in err && /failed twice/.test(err.error));
	assert.equal(calls, 2);
	const draft = /draft (d[0-9a-z]{6})/.exec("error" in err ? err.error : "")?.[1];
	assert.ok(draft);
	assert.equal(draftCriticCost(path.join(root, "drafts", draft!, "critic")), 60);
	assert.equal(draftRounds(root, draft!), 0, "a failed round is not a round");
	let criteria = "";
	await criticRound({ cfg: DEFAULTS, root, cwd: root, critic: async (req) => ((criteria = req.criteria), reviewOf("VERDICT: PASS")) }, "## Goal\nonly a goal\n");
	assert.match(criteria, /The brief is incomplete/);
	cleanup(root);
});
