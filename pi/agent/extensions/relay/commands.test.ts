// node --experimental-strip-types --test commands.test.ts
// /relay: the subcommand table, its completions, and the handler called with every entry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RELAY_ROLES, RELAY_SUBS, relayCompletions, relayDescription } from "./commands.ts";
import { fakeCtx, makeBus, relayOn } from "./test/fake-api.ts";
import { cleanup, makeRepo } from "./test/helpers.ts";

const st = (over: Partial<Parameters<typeof relayCompletions>[1]> = {}) => ({
	jobs: () => [{ id: "j1", state: "running" }, { id: "j2", state: "done" }],
	specOf: () => ({ model: "a/c" }),
	models: () => [{ provider: "a", id: "c" }],
	...over,
});

test("the table values are the documented subcommands, in order", () => {
	assert.deepEqual(RELAY_SUBS.map((s) => s.value), ["status", "on", "off", "go", "stop", "pause", "resume", "followup", "log", "model"]);
	assert.deepEqual([...RELAY_ROLES], ["critic", "judge", "escalate", "worker.small", "worker.normal", "worker.large"]);
	assert.ok(RELAY_SUBS.every((s) => s.description && !s.description.includes("\n")));
	assert.match(relayDescription(), /^relay: status \| on \| off \| go \| stop <job> \|/);
});

test("top-level completions come from the table; entries with an argument end in a space", () => {
	const items = relayCompletions("", st())!;
	assert.deepEqual(items.map((i) => i.label), RELAY_SUBS.map((s) => s.value));
	for (const [i, s] of RELAY_SUBS.entries()) {
		assert.equal(items[i].value.endsWith(" "), !!s.arg, s.value);
		assert.ok(items[i].description);
	}
	assert.deepEqual(relayCompletions("st", st())!.map((i) => i.value), ["status", "stop "]);
});

test("job subcommands list this session's jobs with their state; model walks roles, models, thinking", () => {
	assert.deepEqual(relayCompletions("stop ", st())!.map((i) => [i.value, i.description]), [["stop j1", "running"], ["stop j2", "done"]]);
	assert.deepEqual(relayCompletions("log j", st())!.map((i) => i.value), ["log j1 ", "log j2 "]);
	assert.equal(relayCompletions("stop x", st()), null);
	assert.equal(relayCompletions("stop ", st({ jobs: () => [] })), null);
	assert.equal(relayCompletions("on ", st()), null);
	assert.equal(relayCompletions("stop ", st({ jobs: () => { throw new Error("x"); } })), null);
	assert.deepEqual(relayCompletions("model w", st())!.map((i) => i.value), ["model worker.small ", "model worker.normal ", "model worker.large "]);
	assert.deepEqual(relayCompletions("model critic ", st())!.map((i) => i.value), ["model critic a/c"]);
	assert.equal(relayCompletions("model critic a/c:h", st())!.length, 1);
	assert.equal(relayCompletions("model critic ", st({ models: () => [] })), null);
});

test("the handler takes every table entry, and /relay completes this session's jobs", async () => {
	const { dir } = makeRepo();
	const r = relayOn(makeBus(), dir);
	const ctx = fakeCtx(dir);
	const cmd = r.commands.get("relay");
	assert.equal(cmd.description, relayDescription());
	assert.deepEqual(cmd.getArgumentCompletions("stop "), null); // no engine yet
	for (const s of RELAY_SUBS) {
		ctx.notes.length = 0;
		const before = r.userMessages.length;
		await cmd.handler(s.value, ctx);
		assert.ok(ctx.notes.length > 0 || r.userMessages.length > before, `/relay ${s.value} said nothing`);
	}
	await cmd.handler("nonsense", ctx);
	assert.match(ctx.notes.at(-1)!, /^relay: lead mode/); // unknown falls back to status
	const eng = await r.lead.engineFor(ctx);
	assert.ok(!("error" in eng));
	assert.deepEqual(eng.jobList(), []);
	eng.jobs.set("x1", { job: { id: "x1", state: "running" } } as any);
	assert.deepEqual(eng.jobList(), [{ id: "x1", state: "running" }]);
	assert.deepEqual(cmd.getArgumentCompletions("stop "), [{ value: "stop x1", label: "x1", description: "running" }]);
	cleanup(dir);
});
