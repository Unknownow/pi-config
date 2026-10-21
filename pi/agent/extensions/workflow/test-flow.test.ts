// node --experimental-strip-types --test test-flow.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChecklist, planSections } from "./plan-doc.ts";
import { amendmentTail, answerItem, askOptions, newTestFlow, nextAction, openBugs, pendingFromFlaws, recordReport, skipItem, testOutcome, testPlan, type TestFlow } from "./test-flow.ts";

const item = (id: string, tag: string, title = `title ${id}`, body = "") => ({ id, tag: tag as never, title, fields: {}, body });
const rep = (...items: ReturnType<typeof item>[]) => ({ items, ran: ["unity run-tests"] });
const flow = (over: Partial<TestFlow> = {}): TestFlow => ({ ...newTestFlow("check the login", 3), ...over });
const bug = (title = "t") => ({ tag: "bug" as const, title, body: "", round: 1 });

test("nextAction", () => {
	assert.equal(nextAction(flow({ items: { S1: bug() }, fixBudget: 1 }), { maxRounds: 3 }), "fix");
	assert.equal(nextAction(flow({ items: { S1: bug() }, fixBudget: 0 }), { maxRounds: 3 }), "limit");
	assert.equal(nextAction(flow({ items: { S1: bug() }, fixBudget: 0 }), { maxRounds: 0 }), "fix");
	assert.equal(nextAction(flow({ pending: [{ kind: "ask", id: "S2", text: "q" }] }), { maxRounds: 3 }), "ask");
	assert.equal(nextAction(flow(), { maxRounds: 3 }), "done");
});

test("recordReport: fixed, refail, escalate, pending refail", () => {
	let f = recordReport(flow({ items: { S1: bug() }, lastFixIds: ["S1"] }), rep(item("S1", "fixed")), 2);
	assert.deepEqual(f.fixed, ["S1"]);
	assert.deepEqual(openBugs(f), []);

	f = recordReport(flow({ items: { S1: bug() }, lastFixIds: ["S1"] }), rep(item("S1", "bug")), 2);
	assert.equal(f.refails?.S1, 1);
	assert.equal(f.escalateNext, true);
	assert.deepEqual(openBugs(f), ["S1"]);
	assert.deepEqual(f.lastFixIds, []);

	f = recordReport({ ...f, lastFixIds: ["S1"] }, rep(item("S1", "bug")), 2);
	assert.equal(f.refails?.S1, 2);
	assert.deepEqual(f.pending?.map((p) => p.kind), ["refail"]);
	assert.deepEqual(openBugs(f), []);
	assert.equal(nextAction(f, { maxRounds: 3 }), "ask");
});

test("recordReport: questions for new ask/blocked/manual, not for answered or skipped ones", () => {
	let f = recordReport(flow(), rep(item("S1", "ask"), item("S2", "manual"), item("S3", "blocked"), item("S4", "bug")), 2);
	assert.deepEqual(f.pending?.map((p) => `${p.id}:${p.kind}`), ["S1:ask", "S2:manual", "S3:blocked"]);
	assert.equal(f.nextId, 5);
	f = answerItem({ ...f, pending: [] }, "S1", "option a");
	assert.deepEqual(f.answers, ["D2. S1: option a"]);
	f = skipItem(f, "S2");
	f = recordReport(f, rep(item("S1", "ask"), item("S2", "manual")), 2);
	assert.deepEqual(f.pending, []);
});

test("a fixed item that fails again becomes a bug again", () => {
	const f = recordReport(flow({ items: { S1: { ...bug(), tag: "fixed" } }, fixed: ["S1"] }), rep(item("S1", "bug")), 2);
	assert.deepEqual(f.fixed, []);
	assert.deepEqual(openBugs(f), ["S1"]);
});

test("testPlan", () => {
	const f = recordReport(flow(), rep(item("S2", "bug", "Login fails", "  Repro: run it\n  Expected: ok"), item("S1", "bug", "Crash"), item("S3", "ask")), 2);
	const withAnswer = answerItem(f, "S3", "yes");
	const tail = "## Amendment 1 (arbiter)\nS2 expects X.";
	const plan = testPlan(withAnswer, tail);
	const sec = planSections(plan);
	assert.ok(sec.goal && sec.decisions && sec.doneWhen && sec.commits);
	assert.deepEqual(parseChecklist(plan).map((c) => c.id), ["S1", "S2"]);
	assert.ok(plan.includes("D2. S3: yes"));
	assert.ok(plan.endsWith(tail));
	assert.equal(amendmentTail(plan), tail);
	assert.equal(amendmentTail("## Plan: x\nno tail"), "");
});

test("testOutcome", () => {
	const f = flow({
		items: { S1: { ...bug(), tag: "fixed" }, S2: { ...bug(), tag: "fixed" }, S3: { ...bug(), tag: "manual" }, S4: bug() },
		fixed: ["S1", "S2"],
		skipped: ["S4"],
		fixRounds: 2,
	});
	assert.deepEqual(testOutcome(f), { text: "test: 2 fixed in 2 fix rounds; open: S3 manual; skipped: S4", ok: false });
	assert.equal(testOutcome(flow({ items: { S1: { ...bug(), tag: "fixed" } }, fixed: ["S1"], fixRounds: 1 })).ok, true);
});

test("testOutcome leaves out answered questions", () => {
	const f = answerItem(flow({ items: { S1: { ...bug(), tag: "ask" }, S2: { ...bug(), tag: "manual" } }, fixRounds: 1 }), "S1", "a");
	assert.equal(testOutcome(f).text, "test: 0 fixed in 1 fix round; open: S2 manual");
});

test("pendingFromFlaws", () => {
	const p = pendingFromFlaws(["- S2 - major - [plan-flaw] x", "- plan.md - major - [plan-flaw] y"]);
	assert.deepEqual(p.map((x) => [x.kind, x.id]), [["dispute", "S2"], ["dispute", "plan"]]);
});

test("askOptions", () => {
	assert.deepEqual(askOptions("  Question: q\n  Options: a) keep it b) drop it"), ["a) keep it", "b) drop it"]);
	assert.deepEqual(askOptions("  Question: q"), []);
});
