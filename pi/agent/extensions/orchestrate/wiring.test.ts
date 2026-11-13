// node --experimental-strip-types --test wiring.test.ts
// Source scan of index.ts: the flow-ended message comes only from the K14 handler.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test('post("flow-ended" appears once, inside the workflow:flow-end handler after the me/started guard', () => {
	const posts = [...source.matchAll(/post\("flow-ended"/g)];
	assert.equal(posts.length, 1);
	const handler = source.indexOf('pi.events.on("workflow:flow-end"');
	assert.ok(handler >= 0);
	const guard = source.indexOf("if (!me || !started) return;", handler);
	assert.ok(guard > handler);
	assert.ok(posts[0].index! > guard);
	assert.ok(posts[0].index! - handler < 800, "the post is inside the handler");
});

test("handlePlanReady writes the judge section and the judge line; status copies judging; table uses phaseLabel", () => {
	const a = source.indexOf("function handlePlanReady(");
	const body = source.slice(a, a + 1500);
	assert.ok(body.includes("judgeSection(") && body.includes("planReviewJudgeLine("));
	const w = source.indexOf("function writeMyStatus(");
	assert.ok(source.slice(w, w + 900).includes("judging:"));
	assert.ok(source.includes("phaseLabel(st?.phase"));
});

const slice = (header: string, len = 3500): string => {
	const a = source.indexOf(header);
	assert.ok(a >= 0, `${header} exists`);
	return source.slice(a, a + len);
};

test("setMode: roleSwitch, saves prevModel only with a current model, entry carries prevModel", () => {
	const b = slice("function setMode(", 2600);
	assert.ok(b.includes("roleSwitch(") && b.includes("appendEntry(MODE_ENTRY") && b.includes("prevModel"));
	assert.ok(b.includes("!ctx.model") && b.includes("action = \"none\""), "no current model: nothing is switched and nothing is saved");
});

test("session_start restores prevModel without switching the model", () => {
	const a = source.indexOf('pi.on("session_start"');
	const b = source.slice(a, a + 4000);
	assert.ok(b.includes("roleOnRestore("));
	assert.ok(!b.includes("setModel("));
});

test("the input hook takes ctx and passes it to setMode", () => {
	assert.ok(source.includes('pi.on("input", async (event, ctx) =>'));
	assert.ok(slice('pi.on("input"', 1800).includes("setMode(t.mode, true, ctx)"));
});

test("orch_review_plan builds the confirm title from the sub's judgeLine", () => {
	const b = slice('name: "orch_review_plan"', 4500);
	assert.ok(b.includes("confirmPlanTitle(") && b.includes("judgeLine"));
});
