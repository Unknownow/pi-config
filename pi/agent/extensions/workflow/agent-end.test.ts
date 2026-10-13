// node --test agent-end.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlanReady, shouldResume, skipJudge } from "./agent-end.ts";

const empty = { role: "assistant", content: [] };

test("resume only after an overflow retry with an empty reply, at most twice", () => {
	assert.equal(shouldResume(true, empty, 0), true);
	assert.equal(shouldResume(true, empty, 1), true);
	assert.equal(shouldResume(true, empty, 2), false);
	assert.equal(shouldResume(false, empty, 0), false);
	assert.equal(shouldResume(true, { role: "assistant", content: [{ type: "text" }] }, 0), false);
	assert.equal(shouldResume(true, undefined, 0), false);
});

test("plan is ready with a Plan heading and no trailing question", () => {
	assert.equal(isPlanReady("Plan:\n1. do it", true), true);
	assert.equal(isPlanReady("## Plan (revised)\n1. do it", true), true);
	assert.equal(isPlanReady("**Plan:** 1. do it", true), true);
	assert.equal(isPlanReady("Plan:\n1. do it\n\nOpen question: which db?", true), false);
	assert.equal(isPlanReady("Plan:\n1. x\n\n**Which db?**", true), false);
	assert.equal(isPlanReady("Here is an explanation of the planning", true), false);
	assert.equal(isPlanReady("Plan mode is on, so I can only read files.", true), false);
	assert.equal(isPlanReady("plan: none yet, reading X first.\n1. x", true), false);
	assert.equal(isPlanReady("PLAN: x\n1. x", true), true);
	assert.equal(isPlanReady("## plan\n1. x", true), true);
	assert.equal(isPlanReady("**plan**\n1. x", true), true);
	assert.equal(isPlanReady("## Plan\r\n1. x\r\n", true), true);
	assert.equal(isPlanReady("Intro\r\n**Plan:**\r\n1. x", true), true);
	assert.equal(isPlanReady("Plan:\r\n1. x\r\nWhich db?\r\n", true), false);
	assert.equal(isPlanReady("**Plan** mode is on, so I can only read files.", true), false);
	assert.equal(isPlanReady("## Plan mode\nreading first", true), false);
	assert.equal(isPlanReady("## Plan for the cache fix\n1. x", true), true);
	assert.equal(isPlanReady("## Plan \u2014 add retries\n1. x", true), true);
	assert.equal(isPlanReady("**Plan for X**\n1. x", true), true);
	assert.equal(isPlanReady("**Plan Mode** is active", true), false);
	assert.equal(isPlanReady("## PLAN MODE\nreading", true), false);
	assert.equal(isPlanReady("**Plan-mode** on", true), false);
	assert.equal(isPlanReady("## Plan\n- Mode toggle\n1. x", true), true);
	assert.equal(isPlanReady("**Plan**\n\nMode: strict", true), true);
	assert.equal(isPlanReady("**Plan** \u2014 mode is on", true), false);
	assert.equal(isPlanReady("**Plan**: mode is on", true), false);
	assert.equal(isPlanReady("## Planning notes\nreading first", true), false);
	assert.equal(isPlanReady("Plan:\n1. x", false), false);
});

test("judge is skipped only on an errored reply", () => {
	assert.equal(skipJudge({ role: "assistant", stopReason: "error" }), true);
	assert.equal(skipJudge({ role: "assistant", stopReason: "stop" }), false);
	assert.equal(skipJudge(undefined), false);
});
