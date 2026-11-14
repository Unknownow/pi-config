// node --experimental-strip-types --test index.test.ts
// The lead (lead.ts) through a fake pi: typed "go", the edit budget, tools, the job root, job-set sessions.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { KICKOFF } from "./lead.ts";
import { listJobs } from "./job.ts";
import { fakeCtx, makeBus, relayOn, workflowSide } from "./test/fake-api.ts";
import { brief, makeWt, waitFor, FAKE_PI } from "./test/env.ts";
import { cleanup, git, makeRepo, tmpDir } from "./test/helpers.ts";

const w = (dir: string, f: string, c: string) => fs.writeFileSync(path.join(dir, f), c);
const input = (r: ReturnType<typeof relayOn>, text: string, ctx: any) => r.hooks.get("input")!({ text, source: "interactive" }, ctx);
const edit = (r: ReturnType<typeof relayOn>, file: string, ctx: any) => r.hooks.get("tool_call")!({ toolName: "edit", input: { path: file } }, ctx);

test('typed "go" in lead mode is transformed; "/go" and "go" with lead mode off pass through', async () => {
	const { dir } = makeRepo();
	const r = relayOn(makeBus(), dir);
	const ctx = fakeCtx(dir);
	const t = await input(r, "go", ctx);
	assert.deepEqual(t, { action: "transform", text: `go\n\n${KICKOFF}` });
	assert.equal((await input(r, "ok, go ahead please", ctx)).action, "transform");
	assert.equal((await input(r, "/go", ctx)).action, "continue");
	assert.equal((await input(r, "go and fix the other thing too", ctx)).action, "continue");
	assert.equal((await r.hooks.get("input")!({ text: "go", source: "extension" }, ctx)).action, "continue");
	// /relay go sends the kickoff
	await r.commands.get("relay").handler("go", ctx);
	assert.deepEqual(r.userMessages, [KICKOFF]);

	const bus = makeBus();
	workflowSide(bus, { value: "execute" });
	const off = relayOn(bus, dir);
	assert.equal((await input(off, "go", fakeCtx(dir))).action, "continue");
	cleanup(dir);
});

test("the lead prompt is added in lead mode only", async () => {
	const { dir } = makeRepo();
	const r = relayOn(makeBus(), dir);
	const ev = { systemPromptOptions: { sections: {} as Record<string, string> } };
	await r.hooks.get("before_agent_start")!(ev, fakeCtx(dir));
	assert.match(ev.systemPromptOptions.sections.relay, /you are the lead/);
	const bus = makeBus();
	workflowSide(bus, { value: "plan" });
	const off = relayOn(bus, dir);
	const ev2 = { systemPromptOptions: { sections: {} as Record<string, string> } };
	await off.hooks.get("before_agent_start")!(ev2, fakeCtx(dir));
	assert.equal(ev2.systemPromptOptions.sections.relay, undefined);
	cleanup(dir);
});

test("an edit on a 4th file is refused; an edit of an already changed file is not; a commit resets", async () => {
	const { dir } = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n", "d.txt": "d\n" });
	const r = relayOn(makeBus(), dir);
	const ctx = fakeCtx(dir);
	for (const f of ["a.txt", "b.txt", "c.txt"]) w(dir, f, `${f} changed\n`);
	const refused = await edit(r, path.join(dir, "d.txt"), ctx);
	assert.equal(refused.block, true);
	assert.match(refused.reason, /3 of 3 files.*relay_dispatch/);
	assert.equal(await edit(r, path.join(dir, "b.txt"), ctx), undefined);
	git(dir, "commit", "-q", "-am", "x");
	assert.equal(await edit(r, path.join(dir, "d.txt"), ctx), undefined, "a commit resets the count");
	cleanup(dir);
});

test("after a bash tool_result brings the total past 40 lines, the next edit is refused (and a note is shown)", async () => {
	const { dir } = makeRepo();
	const r = relayOn(makeBus(), dir);
	const ctx = fakeCtx(dir);
	assert.equal(await edit(r, path.join(dir, "a.txt"), ctx), undefined);
	w(dir, "gen.txt", `${"x\n".repeat(45)}`);
	await r.hooks.get("tool_result")!({ toolName: "bash", input: { command: "node gen.js" } }, ctx);
	assert.ok(ctx.notes.some((n) => /edit budget exceeded by bash/.test(n)));
	const refused = await edit(r, path.join(dir, "a.txt"), ctx);
	assert.equal(refused.block, true);
	assert.match(refused.reason, /edit budget reached \(45 of 40 lines/);
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "gen");
	assert.equal(await edit(r, path.join(dir, "a.txt"), ctx), undefined);
	cleanup(dir);
});

test("sensitive bash actions are logged to lead-actions.jsonl; plain commands are not", async () => {
	const { dir } = makeRepo();
	const r = relayOn(makeBus(), dir);
	const ctx = fakeCtx(dir);
	await r.hooks.get("tool_call")!({ toolName: "bash", input: { command: "npm test" } }, ctx);
	await r.hooks.get("tool_call")!({ toolName: "bash", input: { command: "git branch -D old && npm install left-pad" } }, ctx);
	const log = path.join(dir, ".git", "pi", "relay", "lead-actions.jsonl");
	const rows = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	assert.deepEqual(rows.map((x) => x.category).sort(), ["delete", "deps"]);
	cleanup(dir);
});

test("in a job-set session: edit is never refused, go passes through, relay_dispatch is refused, no engine is started", async () => {
	const root = tmpDir();
	const set = path.join(root, "r1a2b3c");
	fs.mkdirSync(set, { recursive: true });
	git(set, "init", "-q", "-b", "main");
	git(set, "config", "user.name", "t");
	git(set, "config", "user.email", "t@t");
	w(set, ".pi-set.json", "{}");
	w(set, "a.txt", "a\n");
	git(set, "add", "-A");
	git(set, "commit", "-q", "-m", "i");
	for (const f of ["a", "b", "c", "d", "e"]) w(set, `${f}2.txt`, "x\n".repeat(50));
	const r = relayOn(makeBus(), set);
	const ctx = fakeCtx(set);
	assert.equal(await edit(r, path.join(set, "z.txt"), ctx), undefined);
	assert.equal((await input(r, "go", ctx)).action, "continue");
	const res = await r.tools.get("relay_dispatch").execute("id", { brief: brief({ repo: set }) }, undefined, undefined, ctx);
	assert.match(res.content[0].text, /job's worktree/);
	assert.equal(r.lead.engine(), undefined);
	assert.equal(r.lead.scans(), 0, "a job-set session never scans for jobs to adopt");
	cleanup(root);
});

test("relay_dispatch outside a git repo is refused", async () => {
	const dir = tmpDir();
	const r = relayOn(makeBus(), dir);
	const res = await r.tools.get("relay_dispatch").execute("id", { brief: brief({ repo: dir }) }, undefined, undefined, fakeCtx(dir));
	assert.match(res.content[0].text, /inside a git repo/);
	const c = await r.tools.get("relay_critic").execute("id", { brief: brief({ repo: dir }) }, undefined, undefined, fakeCtx(dir));
	assert.match(c.content[0].text, /inside a git repo/);
	cleanup(dir);
});

test("a two-repo job's folder is created under the cwd repo's git folder, and W1 gets the added folder", async () => {
	const a = makeRepo({ "a.txt": "a\n" }, true);
	const b = makeRepo({ "b.txt": "b\n" }, true);
	const base = tmpDir("relay-two-");
	const prev = { bin: process.env.RELAY_PI_BIN, script: process.env.FAKE_PI_SCRIPT };
	const bus = makeBus();
	const ctx = fakeCtx(a.dir, [path.join(b.dir).split("\\").join("/")]);
	let r: ReturnType<typeof relayOn> | undefined;
	try {
		const script = path.join(base, "script.json");
		fs.writeFileSync(script, JSON.stringify({ worker: [{ hang: true }] }));
		process.env.RELAY_PI_BIN = FAKE_PI;
		process.env.FAKE_PI_SCRIPT = script;
		const calls = { create: [] as any[], remove: [] as any[] };
		const ext = makeWt(path.join(base, "sets"), a.dir, calls);
		bus.on("worktree:create", (d) => d.claim(ext.create({ name: d.name, bases: d.bases, folders: d.folders })));
		bus.on("worktree:remove", (d) => d.claim(ext.remove({ name: d.name })));
		const fwd = (p: string) => p.split("\\").join("/");
		r = relayOn(bus, a.dir);
		const text = brief({ repo: a.dir }).replace(/## Targets\n.*\n/, `## Targets\n- ${fwd(a.dir)}: main\n- ${fwd(b.dir)}: main\n`);
		const res = await r.tools.get("relay_dispatch").execute("id", { brief: text }, undefined, undefined, ctx);
		assert.match(res.content[0].text, /^job r[0-9a-z]{6} started/, res.content[0].text);
		const root = path.join(a.dir, ".git", "pi", "relay");
		await waitFor(() => listJobs(root).length === 1 && listJobs(root)[0].job.repos.length === 2, 30_000, "the job");
		const job = listJobs(root)[0].job;
		assert.deepEqual(job.repos.map((x) => x.key), [fwd(a.dir), fwd(b.dir)]);
		assert.deepEqual(calls.create[0].folders, [fwd(b.dir)]);
		assert.equal(calls.create[0].launch, undefined, "the fake extension's own payload; the real W1 request carries launch none");
		assert.equal(fs.existsSync(path.join(b.dir, ".git", "pi")), false, "nothing is stored in the other repo");
		const status = await r.tools.get("relay_status").execute("id", {}, undefined, undefined, ctx);
		assert.match(status.content[0].text, new RegExp(job.id));
		const stop = await r.tools.get("relay_stop").execute("id", { job: job.id }, undefined, undefined, ctx);
		assert.match(stop.content[0].text, /stopped/);
	} finally {
		if (r) await r.hooks.get("session_shutdown")!({}, ctx);
		if (prev.bin === undefined) delete process.env.RELAY_PI_BIN;
		else process.env.RELAY_PI_BIN = prev.bin;
		if (prev.script === undefined) delete process.env.FAKE_PI_SCRIPT;
		else process.env.FAKE_PI_SCRIPT = prev.script;
		cleanup(a.dir, a.bare, b.dir, b.bare, base);
	}
});

test("in lead mode the scan for unfinished jobs runs once, when lead mode turns on", async () => {
	const { dir } = makeRepo();
	try {
		const r = relayOn(makeBus(), dir);
		const ctx = fakeCtx(dir);
		assert.equal(r.lead.scans(), 0, "nothing runs before lead mode is decided");
		await input(r, "hello", ctx);
		await input(r, "hello again", ctx);
		assert.equal(r.lead.scans(), 1);
	} finally {
		cleanup(dir);
	}
});
