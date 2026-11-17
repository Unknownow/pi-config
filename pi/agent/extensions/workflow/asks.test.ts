// node --experimental-strip-types --test asks.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_APPROVE, PLAN_ARBITER, PLAN_BACK, PLAN_FULL, askMenu, planMenuRequest, resumeContent } from "./asks.ts";

function harness(choice: string | undefined = "Local") {
	const h = { selects: [] as string[], notices: [] as string[] };
	const deps = {
		select: async (title: string) => {
			h.selects.push(title);
			return choice;
		},
		notify: (t: string) => void h.notices.push(t),
	};
	return { h, deps };
}

const req = { title: "Judge failed 5 rounds", options: ["Keep fixing", "Stop"] };

test("askMenu notifies, then shows the local menu and returns its choice", async () => {
	const { h, deps } = harness();
	assert.equal(await askMenu(deps, req), "Local");
	assert.deepEqual(h.notices, [req.title]);
	assert.deepEqual(h.selects, [req.title]);
});

test("localNotice runs before the menu; skipLocal shows no menu and no notification", async () => {
	const { h, deps } = harness();
	let shown = 0;
	await askMenu(deps, { ...req, localNotice: () => void shown++ });
	assert.equal(shown, 1);
	const skipped = harness();
	assert.equal(await askMenu(skipped.deps, { ...req, localNotice: () => void shown++, skipLocal: true }), undefined);
	assert.equal(shown, 2);
	assert.deepEqual(skipped.h.selects, []);
	assert.deepEqual(skipped.h.notices, []);
	assert.equal(h.selects.length, 1);
});

test("plan-menu request: options for blocked, unblocked, quick and planPrompt off", () => {
	const base = { blocked: false, quick: false, planFlawAsk: true, planPrompt: true };
	const open = planMenuRequest(base);
	assert.deepEqual(open.options, [PLAN_APPROVE, PLAN_ARBITER, PLAN_BACK, "Keep discussing"]);
	assert.equal(open.skipLocal, false);
	assert.deepEqual(planMenuRequest({ ...base, blocked: true }).options, [PLAN_BACK, "Keep discussing"]);
	assert.deepEqual(planMenuRequest({ ...base, quick: true }).options, [PLAN_APPROVE, PLAN_FULL, "Keep discussing"]);
	assert.equal(planMenuRequest({ ...base, planPrompt: false }).skipLocal, true);
});

test("resumeContent joins the prefix, the held text and the typed text", () => {
	assert.equal(resumeContent("done.", "held.", "go"), "done.\n\nheld.\n\ngo");
	assert.equal(resumeContent("done.", undefined, undefined), "done.\n\nContinue with the open steps of the plan.");
});
