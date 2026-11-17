// node --experimental-strip-types --test judge-claim.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { emitClaims } from "../shared/claims.ts";
import { claimJudgeCall, type JudgeParams } from "./judge-claim.ts";

// The config files read the agent folder from the pi package, which is not installed next to the tests.
await import("./test-hooks.ts");
const { AGENT_ROLES } = await import("../agents/api.ts");
const { ROLES } = await import("./config.ts");

function payload() {
	const claims: Promise<unknown>[] = [];
	return { claims, p: { v: 1, params: { focus: "f", full: true }, ctx: { cwd: "x" }, signal: undefined, onUpdate: () => {}, claim: (a: Promise<unknown>) => claims.push(a) } };
}

test("claims in execute, plan and discuss with the run's result", async () => {
	for (const phase of ["execute", "plan", "discuss"]) {
		const { claims, p } = payload();
		const seen: unknown[] = [];
		const run = async (params: JudgeParams, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => {
			seen.push(params, signal, onUpdate, ctx);
			return { content: [{ type: "text", text: "No changes to review." }], details: undefined };
		};
		assert.equal(claimJudgeCall(phase, p, run), true, phase);
		assert.deepEqual(await claims[0], { content: [{ type: "text", text: "No changes to review." }], details: undefined });
		assert.deepEqual(seen, [p.params, undefined, p.onUpdate, p.ctx]);
	}
});

test("does not claim when no flow is on, or for an unknown payload", () => {
	const run = async () => ({ content: [] });
	const { claims, p } = payload();
	assert.equal(claimJudgeCall("off", p, run), false);
	assert.equal(claims.length, 0);
	assert.equal(claimJudgeCall("execute", { ...p, v: 2 }, run), false);
	assert.equal(claimJudgeCall("execute", { v: 1 }, run), false);
	assert.equal(claimJudgeCall("execute", null, run), false);
});

test("an error of the run rejects the claim: agents sees { error }", async () => {
	const c = emitClaims((d) => claimJudgeCall("execute", d, async () => { throw new Error("no git work tree in this flow"); }), { v: 1, params: {} }, 0);
	assert.equal(c.claimed, true);
	assert.deepEqual(await c.answer, { error: "no git work tree in this flow" });
});

test("workflow roles are exactly discuss, plan, execute, commit, arbiter, escalate; none is an agents role", () => {
	assert.deepEqual([...ROLES], ["discuss", "plan", "execute", "commit", "arbiter", "escalate"]);
	for (const r of ROLES) assert.ok(!(AGENT_ROLES as readonly string[]).includes(r), r);
	for (const r of ["judge", "critic"]) assert.ok((AGENT_ROLES as readonly string[]).includes(r), r);
});
