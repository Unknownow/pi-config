// node --experimental-strip-types --test k16.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { Activation, inJobSet, ownerOf, parseFlowActive } from "./events.ts";
import { fakeCtx, makeBus, relayOn, workflowSide } from "./test/fake-api.ts";
import { cleanup, tmpDir } from "./test/helpers.ts";

test("parseFlowActive and ownerOf: only owner counts; null, {error} and others are no claim", () => {
	const claim = () => {};
	assert.deepEqual(parseFlowActive({ v: 1, from: "relay", claim }), { from: "relay", claim });
	assert.ok("error" in parseFlowActive({ v: 2, from: "relay" }));
	assert.ok("error" in parseFlowActive({ v: 1, from: "x" }));
	assert.equal(ownerOf({ owner: "workflow" }), "workflow");
	assert.equal(ownerOf({ error: "no answer within 2 s" }), undefined);
	assert.equal(ownerOf(null), undefined);
});

for (const order of ["relay first", "workflow first"] as const) {
	test(`load order (${order}) with workflow startPhase "plan": relay on, workflow off`, async () => {
		const dir = tmpDir();
		const bus = makeBus();
		const phase = { value: "off" };
		let r: ReturnType<typeof relayOn>;
		let wf: ReturnType<typeof workflowSide>;
		if (order === "relay first") {
			r = relayOn(bus, dir);
			wf = workflowSide(bus, phase);
		} else {
			wf = workflowSide(bus, phase);
			r = relayOn(bus, dir);
		}
		// workflow's session_start tries its startPhase before relay has decided: relay's listener claims
		assert.equal(await wf.startPhase("plan"), false);
		assert.equal(phase.value, "off");
		// relay decides later (first input): workflow is off, so nobody claims
		assert.equal(await r.lead.leadOn(fakeCtx(dir)), true);
		assert.equal(r.lead.act.mode, "on");
		assert.equal(phase.value, "off");
		// once decided on, relay keeps claiming
		assert.equal(await wf.startPhase("plan"), false);
		cleanup(dir);
	});

	test(`a restored workflow flow (${order}) keeps relay off`, async () => {
		const dir = tmpDir();
		const bus = makeBus();
		const phase = { value: "execute" }; // restored from the session
		let r: ReturnType<typeof relayOn>;
		if (order === "relay first") {
			r = relayOn(bus, dir);
			workflowSide(bus, phase);
		} else {
			workflowSide(bus, phase);
			r = relayOn(bus, dir);
		}
		const ctx = fakeCtx(dir);
		assert.equal(await r.lead.leadOn(ctx), false);
		assert.equal(r.lead.act.mode, "off");
		assert.ok(ctx.notes.some((n) => /workflow owns this session/.test(n)));
		assert.equal(phase.value, "execute");
		// relay no longer claims
		assert.equal(r.lead.act.claim("workflow"), undefined);
		cleanup(dir);
	});
}

test("relay's own emit is not answered by its own listener: with no workflow listener lead mode turns on", async () => {
	const dir = tmpDir();
	const r = relayOn(makeBus(), dir);
	assert.equal(await r.lead.leadOn(fakeCtx(dir)), true);
	cleanup(dir);
});

test("a listener that never answers counts as no claim after 2 s; a rejected claim too", async (t) => {
	const dir = tmpDir();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const bus = makeBus();
	bus.on("flow:active", (d) => d.from === "relay" && d.claim(new Promise(() => {})));
	const r = relayOn(bus, dir);
	const p = r.lead.leadOn(fakeCtx(dir));
	t.mock.timers.tick(2000);
	assert.equal(await p, true);
	t.mock.timers.reset();

	const bus2 = makeBus();
	bus2.on("flow:active", (d) => d.from === "relay" && d.claim(Promise.reject(new Error("x"))));
	const r2 = relayOn(bus2, dir);
	assert.equal(await r2.lead.leadOn(fakeCtx(dir)), true);
	cleanup(dir);
});

test("/relay on is refused while workflow claims, and works once it does not", async () => {
	const dir = tmpDir();
	const bus = makeBus();
	const phase = { value: "execute" };
	workflowSide(bus, phase);
	const r = relayOn(bus, dir);
	const ctx = fakeCtx(dir);
	await r.commands.get("relay").handler("on", ctx);
	assert.match(ctx.notes.join("\n"), /not turned on: workflow owns this session/);
	assert.equal(r.lead.act.mode === "on", false);
	phase.value = "off";
	await r.commands.get("relay").handler("on", ctx);
	assert.equal(r.lead.act.mode, "on");
	cleanup(dir);
});

test("a session inside a job set (r1a2b3c, r1a2b3c-f1) makes no claim and keeps lead mode off with the notice", async () => {
	for (const name of ["r1a2b3c", "r1a2b3c-f1"]) {
		const root = tmpDir();
		const set = path.join(root, name);
		fs.mkdirSync(path.join(set, "repo", "src"), { recursive: true });
		fs.writeFileSync(path.join(set, ".pi-set.json"), "{}");
		const cwd = path.join(set, "repo", "src");
		assert.equal(inJobSet(cwd), true);
		const bus = makeBus();
		const r = relayOn(bus, cwd);
		// workflow emits: relay does not claim
		const wfAnswer = await (async () => {
			const { emitClaims } = await import("../shared/claims.ts");
			return emitClaims((d) => bus.emit("flow:active", d), { v: 1, from: "workflow" }, 2000);
		})();
		assert.equal(wfAnswer.claimed, false);
		const ctx = fakeCtx(cwd);
		assert.equal(await r.lead.leadOn(ctx), false);
		assert.ok(ctx.notes.some((n) => /this is a job's worktree; lead mode off/.test(n)));
		cleanup(root);
	}
	const plain = tmpDir();
	fs.writeFileSync(path.join(plain, ".pi-set.json"), "{}");
	assert.equal(inJobSet(plain), false, "a set not named like a job set is an ordinary session");
	cleanup(plain);
});

test("a worker process (RELAY_ROLE) never claims and never turns lead mode on; an inactive config claims nothing", async () => {
	const dir = tmpDir();
	const bus = makeBus();
	const act = new Activation({ active: () => true, cwd: dir, role: "worker", emit: (d) => bus.emit("flow:active", d) });
	assert.equal(act.claim("workflow"), undefined);
	assert.equal(await act.decide(), false);
	const off = new Activation({ active: () => false, cwd: dir, role: undefined, emit: () => {} });
	assert.equal(off.claim("workflow"), undefined);
	assert.equal(await off.decide(), false);
	cleanup(dir);
});
