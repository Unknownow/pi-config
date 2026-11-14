// node --experimental-strip-types --test contracts.test.ts
// The relay:* bus contracts (dispatch, control, job-query, job-progress, hosted), the tag and the merge default.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { emitClaims } from "../shared/claims.ts";
import { KICKOFF } from "./lead.ts";
import { readJob } from "./job.ts";
import { fakeCtx, makeBus, relayOn, workflowSide } from "./test/fake-api.ts";
import { brief, FAKE_PI, makeWt, waitFor, world } from "./test/env.ts";
import { cleanup, makeRepo, tmpDir } from "./test/helpers.ts";

const PASS = "- minor - [style] `greeting.txt:1` trailing space fix: auto\n  Why: x\n  Fix: y\n\nVERDICT: PASS";
const ask = (bus: ReturnType<typeof makeBus>, name: string, payload: object): Promise<any> => emitClaims((d) => bus.emit(name, d), { v: 1, ...payload }, 20_000).answer;
const NAMES = ["relay:job-start", "relay:job-progress", "relay:job-end", "relay:approval"];
const work = { write: [{ file: "greeting.txt", content: "hello\n" }], done: "done" };

function setup(script: object) {
	const { dir, bare } = makeRepo({ "a.txt": "a\n" }, true);
	const base = tmpDir("relay-c-");
	fs.writeFileSync(path.join(base, "script.json"), JSON.stringify(script));
	process.env.RELAY_PI_BIN = FAKE_PI;
	process.env.FAKE_PI_SCRIPT = path.join(base, "script.json");
	const bus = makeBus();
	const calls = { create: [] as any[], remove: [] as any[] };
	const ext = makeWt(path.join(base, "sets"), dir, calls);
	bus.on("worktree:create", (d) => d.claim(ext.create({ name: d.name, bases: d.bases, folders: d.folders })));
	bus.on("worktree:remove", (d) => d.claim(ext.remove({ name: d.name })));
	const events: { name: string; payload: any }[] = [];
	for (const n of NAMES) bus.on(n, (p) => events.push({ name: n, payload: p }));
	const r = relayOn(bus, dir);
	const ctx = fakeCtx(dir);
	const root = path.join(dir, ".git", "pi", "relay");
	// the first lead action starts an adoption scan; let it finish so it cannot race the first dispatch
	const start = async (c: any = ctx, lead = r) => {
		await lead.hooks.get("session_start")!({}, c);
		await lead.lead.leadOn(c);
		await lead.lead.engineFor(c);
		await waitFor(() => lead.lead.scans() >= 1, 10_000, "the adoption scan");
		await new Promise((res) => setTimeout(res, 300));
	};
	return { dir, bare, base, bus, r, ctx, events, root, start, done: () => cleanup(dir, bare, base) };
}

test("relay:dispatch dispatches with a tag; events carry it, in order, with used and repos; wakes are prefixed", async () => {
	const s = setup({ worker: [work], judge: [PASS] });
	try {
		await s.start();
		const tag = { run: "run1", package: "pkg-a" };
		const a = await ask(s.bus, "relay:dispatch", { brief: brief({ repo: s.dir, authority: { merge: "yes (ff to main)" } }), tag });
		assert.match(a.id, /^r[0-9a-z]{6}$/);
		assert.equal(a.queued, false);
		await waitFor(() => s.events.some((e) => e.name === "relay:job-end"), 60_000, "job-end");
		assert.deepEqual(readJob(path.join(s.root, a.id))!.tag, tag);
		const names = s.events.map((e) => e.name);
		const start = names.indexOf("relay:job-start");
		const end = names.indexOf("relay:job-end");
		assert.ok(start >= 0 && end > start, `${names.join(",")} ${JSON.stringify(readJob(path.join(s.root, a.id)))}`);
		names.forEach((n, i) => {
			if (n === "relay:job-progress") assert.ok(i > start && i < end, `progress at ${i} outside ${start}..${end}`);
		});
		assert.ok(names.includes("relay:job-progress"));
		for (const e of s.events) assert.deepEqual(e.payload.tag, tag, e.name);
		const states = s.events.filter((e) => e.name === "relay:job-progress").map((e) => `${e.payload.state}:${e.payload.round}`);
		assert.equal(new Set(states).size, states.length, "one progress per distinct (state, round)");
		const last = s.events.find((e) => e.name === "relay:job-end")!.payload;
		assert.equal(last.how, "delivered");
		assert.ok(last.used.tokens > 0 && last.used.wallMs >= 0);
		assert.deepEqual(last.repos.map((x: any) => ({ ...x, key: x.key.split("\\").join("/") })), [{ key: s.dir.split("\\").join("/"), merged: true }]);
		assert.ok(s.events.find((e) => e.name === "relay:job-progress")!.payload.used);
		// every wake of the tagged job starts with the prefix
		const wakes = s.r.sent.filter((m) => m.message.customType === "relay").map((m) => m.message.content as string);
		assert.ok(wakes.length >= 2);
		for (const t of wakes) assert.ok(t.startsWith("[pkg-a] relay job"), t);
	} finally {
		await s.r.hooks.get("session_shutdown")!({}, s.ctx);
		s.done();
	}
});

test("relay:dispatch refuses: no ctx, bad payload, not a git repo", async () => {
	const s = setup({ worker: [{ hang: true }] });
	try {
		const b = brief({ repo: s.dir });
		assert.match((await ask(s.bus, "relay:dispatch", { brief: b })).error, /no session context/);
		await s.r.hooks.get("session_start")!({}, s.ctx);
		assert.match((await ask(s.bus, "relay:dispatch", { brief: b, tag: { run: "x" } })).error, /tag/);
		assert.match((await ask(s.bus, "relay:dispatch", { brief: b, size: "huge" })).error, /size/);
		assert.match((await ask(s.bus, "relay:dispatch", {})).error, /brief/);
		const plain = tmpDir();
		const bus2 = makeBus();
		const p = relayOn(bus2, plain);
		await p.hooks.get("session_start")!({}, fakeCtx(plain));
		assert.match((await ask(bus2, "relay:dispatch", { brief: b })).error, /git repo/);
		assert.match((await ask(bus2, "relay:job-query", { ids: ["r000000"] })).error, /git repo/);
		cleanup(plain);
	} finally {
		await s.r.hooks.get("session_shutdown")!({}, s.ctx);
		s.done();
	}
});

test("relay:dispatch in a job-set session answers {error}", async () => {
	const base = tmpDir("relay-js-");
	const set = path.join(base, "r1a2b3c");
	fs.mkdirSync(set, { recursive: true });
	fs.writeFileSync(path.join(set, ".pi-set.json"), "{}");
	const bus = makeBus();
	const r = relayOn(bus, set);
	await r.hooks.get("session_start")!({}, fakeCtx(set));
	const a = await ask(bus, "relay:dispatch", { brief: brief({ repo: set }) });
	assert.ok(typeof a.error === "string" && a.error.length > 0, JSON.stringify(a));
	assert.equal(a.id, undefined);
	cleanup(base);
});

test("relay:control stops a job and follows one up; relay:job-query reads memory, disk and unknown ids", async () => {
	const s = setup({ worker: [{ hang: true }, { hang: true }], judge: [PASS] });
	let other: ReturnType<typeof relayOn> | undefined;
	try {
		await s.start();
		const tag = { run: "r", package: "p" };
		const a = await ask(s.bus, "relay:dispatch", { brief: brief({ repo: s.dir }), tag });
		assert.ok(a.id, JSON.stringify(a));
		await waitFor(() => s.events.some((e) => e.name === "relay:job-start"), 30_000, "job-start");
		// query: in memory, and an unknown id
		let q = await ask(s.bus, "relay:job-query", { ids: [a.id, "r999999"] });
		assert.equal(q.jobs[0].id, a.id);
		assert.equal(q.jobs[0].state, "working");
		assert.deepEqual(q.jobs[0].tag, tag);
		assert.deepEqual(Object.keys(q.jobs[0].used).sort(), ["tokens", "wallMs"]);
		assert.equal(q.jobs[0].report, undefined);
		assert.equal(q.jobs[1].state, "unknown");
		// control errors
		assert.match((await ask(s.bus, "relay:control", { job: a.id, action: "followup" })).error, /text/);
		assert.match((await ask(s.bus, "relay:control", { job: a.id, action: "dance" })).error, /action/);
		// stop
		assert.deepEqual(await ask(s.bus, "relay:control", { job: a.id, action: "stop" }), { ok: true, job: a.id });
		await waitFor(() => s.events.some((e) => e.name === "relay:job-end"), 30_000, "job-end");
		const endP = s.events.find((e) => e.name === "relay:job-end")!.payload;
		assert.equal(endP.how, "stopped");
		assert.ok(typeof endP.reason === "string" && endP.reason.length > 0, JSON.stringify(endP));
		q = await ask(s.bus, "relay:job-query", { ids: [a.id] });
		assert.equal(q.jobs[0].state, "stopped");
		assert.equal(q.jobs[0].reason, endP.reason);
		assert.equal(q.jobs[0].report, s.events.find((e) => e.name === "relay:job-end")!.payload.report);
		// a second lead on the same repo finds the job on disk only
		const bus2 = makeBus();
		other = relayOn(bus2, s.dir);
		await other.hooks.get("session_start")!({}, s.ctx);
		const q2 = await ask(bus2, "relay:job-query", { ids: [a.id] });
		assert.equal(q2.jobs[0].state, "stopped");
		assert.deepEqual(q2.jobs[0].tag, tag);
		assert.ok(q2.jobs[0].report);
		// follow-up: same job id
		const f = await ask(s.bus, "relay:control", { job: a.id, action: "followup", text: "also add a second file" });
		assert.equal(f.ok, true, JSON.stringify(f));
		assert.equal(f.job, a.id);
		assert.equal(f.n, 1);
		assert.equal(typeof f.queued, "boolean");
		await ask(s.bus, "relay:control", { job: a.id, action: "stop" });
	} finally {
		await other?.hooks.get("session_shutdown")!({}, s.ctx);
		await s.r.hooks.get("session_shutdown")!({}, s.ctx);
		s.done();
	}
});

test("relay:hosted: lead mode at once, 'go' passes through, no prompt section; off restores both", async () => {
	const { dir } = makeRepo();
	const bus = makeBus();
	const r = relayOn(bus, dir);
	const ctx = fakeCtx(dir);
	const go = () => r.hooks.get("input")!({ text: "go", source: "interactive" }, ctx);
	const sections = async () => {
		const sec: Record<string, string> = {};
		await r.hooks.get("before_agent_start")!({ systemPromptOptions: { sections: sec } }, ctx);
		return sec;
	};
	// before any ctx: the flag is set, mode off with a reason, decided at session_start
	assert.deepEqual(await ask(bus, "relay:hosted", { on: true }), { on: true, mode: "off", reason: "no session context" });
	assert.equal(r.lead.act.mode, "undecided");
	await r.hooks.get("session_start")!({}, ctx);
	assert.equal(r.lead.act.mode, "on");
	assert.equal((await go()).action, "continue");
	assert.equal((await sections()).relay, undefined);
	assert.deepEqual(await ask(bus, "relay:hosted", { on: true }), { on: true, mode: "on" });
	// tools still work in hosted mode
	assert.match((await r.tools.get("relay_status").execute("id", {}, undefined, undefined, ctx)).content[0].text, /no jobs/);
	// off restores
	assert.deepEqual(await ask(bus, "relay:hosted", { on: false }), { on: false, mode: "on" });
	const t = await go();
	assert.equal(t.action, "transform");
	assert.ok(t.text.endsWith(KICKOFF));
	assert.ok((await sections()).relay);
	cleanup(dir);
});

test("relay:hosted answers when workflow owns the session", async () => {
	const { dir } = makeRepo();
	const bus = makeBus();
	workflowSide(bus, { value: "execute" });
	const r = relayOn(bus, dir);
	await r.hooks.get("session_start")!({}, fakeCtx(dir));
	const a = await ask(bus, "relay:hosted", { on: true });
	assert.equal(a.on, true);
	assert.equal(a.mode, "off");
	assert.match(a.reason, /workflow/);
	cleanup(dir);
});

test("after session_shutdown no relay:* contract is claimed; a new session_start does not double the listeners", async () => {
	const { dir } = makeRepo();
	const bus = makeBus();
	const r = relayOn(bus, dir);
	await r.hooks.get("session_start")!({}, fakeCtx(dir));
	await r.hooks.get("session_start")!({}, fakeCtx(dir));
	const count = (name: string, extra: object) => {
		let n = 0;
		bus.emit(name, { v: 1, ...extra, claim: () => void n++ });
		return n;
	};
	const claimed = (name: string, extra: object) => emitClaims((d) => bus.emit(name, d), { v: 1, ...extra }, 100).claimed;
	assert.equal(claimed("relay:job-query", { ids: [] }), true);
	// the bus fake calls every handler; a doubled listener would claim twice
	assert.equal(count("relay:job-query", { ids: [] }), 1);
	await r.hooks.get("session_shutdown")!({}, fakeCtx(dir));
	assert.equal(claimed("relay:dispatch", { brief: "x" }), false);
	assert.equal(claimed("relay:control", { job: "r000000", action: "stop" }), false);
	assert.equal(claimed("relay:job-query", { ids: [] }), false);
	assert.equal(claimed("relay:hosted", { on: true }), false);
	cleanup(dir);
});

test("defaultMerge is after-pass: a job with merge n/a merges after PASS and its wakes are prefixed; merge no does not merge", async () => {
	const w = world();
	try {
		w.write({ worker: [work], judge: [PASS] });
		const a = await w.engine.dispatch({ brief: brief({ repo: w.repo, authority: { merge: "n/a" } }), tag: { run: "r", package: "pk" } });
		if (!("id" in a)) throw new Error(JSON.stringify(a));
		const jr = w.engine.get(a.id)!;
		await waitFor(() => jr.ended, 60_000, "job end");
		assert.equal(jr.job.repos[0].merged, true);
		assert.ok(w.wakes.length && w.wakes.every((t) => t.startsWith("[pk] ")), w.wakes.join("|"));
		const q = w.engine.query([a.id]);
		assert.equal(q[0].state, "done");
		assert.deepEqual(q[0].repos, [{ key: w.repo, merged: true }]);
		const names = w.events.map((e) => e.name);
		assert.ok(names.indexOf("relay:job-start") < names.indexOf("relay:job-progress") && names.lastIndexOf("relay:job-progress") < names.indexOf("relay:job-end"));
	} finally {
		w.end();
	}
});

test("merge no in the brief still keeps the PR-only behaviour under the new default", async () => {
	const w = world();
	try {
		w.write({ worker: [work], judge: [PASS] });
		const b = await w.engine.dispatch({ brief: brief({ repo: w.repo, authority: { merge: "no" } }) });
		if (!("id" in b)) throw new Error(JSON.stringify(b));
		const jb = w.engine.get(b.id)!;
		await waitFor(() => jb.ended, 60_000, "job end");
		assert.notEqual(jb.job.repos[0].merged, true);
	} finally {
		w.end();
	}
});
