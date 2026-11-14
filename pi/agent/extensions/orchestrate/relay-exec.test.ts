// node --experimental-strip-types --test relay-exec.test.ts
// The relay executor against a fake relay listener on a fake bus (no relay code, no relay files).
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Run, Sub } from "./brief.ts";
import { buildReport, checkRelayBrief, claimHosted, executorOf, hostedChange, hostedDecision, readApprovals, RelayExec, relayNames, renderRelayBrief, retryAllowed } from "./relay-exec.ts";

const AUTH = ["merge: yes (squash-merge into master after PASS)", "publish: no", "comments: n/a", "delete: no", "formats: no", "deps: no"];

function sub(id: string, dependsOn: string[] = [], extra: Partial<Sub> = {}): Sub {
	return { id, goal: `do ${id}`, criteria: [`${id} works`], owns: [`src/${id}/**`], forbids: [], dependsOn, decisions: [`${id} uses x`], name: `o1-${id}`, state: "planned", verify: [`npm test -- ${id}`], ...extra };
}

function makeRun(subs: Sub[] = [sub("a"), sub("b"), sub("c", ["a"])]): Run {
	return {
		v: 1, id: "o11140900-x", title: "X", created: "2026-11-14T09:00:00Z", owner: { pid: 1, host: "h", session: "s" }, state: "active", executor: "relay",
		charter: "Goal: x\nUser decisions: keep the API\nNon-goals: no UI\nStanding orders:\n- run the tests\nReserved for the user: stopping", authority: AUTH, top: "D:/w/proj", targets: { "": "origin/master" }, subs,
	};
}

type Listener = (d: unknown) => void;
class Bus {
	private ls = new Map<string, Listener[]>();
	on(e: string, f: Listener) {
		this.ls.set(e, [...(this.ls.get(e) ?? []), f]);
	}
	emit = (e: string, d: unknown) => {
		for (const f of this.ls.get(e) ?? []) f(d);
	};
}

interface FakeJob {
	id: string;
	state: string;
	tag: { run: string; package: string };
	used: { tokens: number; wallMs: number };
	repos: Array<{ key: string; pr?: string; merged: boolean }>;
	report?: string;
	reason?: string;
	brief: string;
}

/** relay's side: answers dispatch / control / job-query like relay does, emits tagged job-progress and job-end on request. */
class FakeRelay {
	jobs = new Map<string, FakeJob>();
	controls: Array<{ job: string; action: string; text?: string }> = [];
	controlErrors: string[] = [];
	queryError: string | undefined;
	n = 0;
	private bus: Bus;
	constructor(bus: Bus) {
		this.bus = bus;
		bus.on("relay:dispatch", (d) => {
			const p = d as { v: number; brief: string; tag: { run: string; package: string }; claim: (a: unknown) => void };
			const id = `r${String(++this.n).padStart(6, "0")}`;
			this.jobs.set(id, { id, state: "queued", tag: p.tag, used: { tokens: 0, wallMs: 0 }, repos: [{ key: "proj", merged: false }], brief: p.brief });
			p.claim(Promise.resolve({ id, queued: true }));
		});
		bus.on("relay:control", (d) => {
			const p = d as { job: string; action: string; text?: string; claim: (a: unknown) => void };
			const err = this.controlErrors.shift();
			if (err) return p.claim(Promise.resolve({ error: err }));
			this.controls.push({ job: p.job, action: p.action, text: p.text });
			const j = this.jobs.get(p.job);
			if (j) j.state = p.action === "stop" ? "stopped" : "queued";
			p.claim(Promise.resolve({ ok: true, job: p.job }));
		});
		bus.on("relay:job-query", (d) => {
			const p = d as { ids: string[]; claim: (a: unknown) => void };
			if (this.queryError) return p.claim(Promise.resolve({ error: this.queryError }));
			p.claim(Promise.resolve({ jobs: p.ids.map((id) => {
				const j = this.jobs.get(id);
				return j ? { id, state: j.state, tag: j.tag, used: j.used, repos: j.repos, ...(j.report ? { report: j.report } : {}), ...(j.reason ? { reason: j.reason } : {}) } : { id, state: "unknown", used: { tokens: 0, wallMs: 0 }, repos: [] };
			}) }));
		});
	}
	byPkg(pkg: string): FakeJob {
		const j = [...this.jobs.values()].reverse().find((x) => x.tag.package === pkg);
		assert.ok(j, `job of ${pkg}`);
		return j;
	}
	progress(pkg: string, tokens: number) {
		const j = this.byPkg(pkg);
		j.used.tokens = tokens;
		j.state = "working";
		this.bus.emit("relay:job-progress", { v: 1, job: j.id, tag: j.tag, state: "working", round: 1, used: j.used });
	}
	end(pkg: string, how: "delivered" | "stopped" | "failed", o: { merged?: boolean; reason?: string; tokens?: number } = {}) {
		const j = this.byPkg(pkg);
		j.state = how === "delivered" ? "done" : how;
		j.repos = [{ key: "proj", pr: `https://github.com/o/proj/pull/${j.id}`, merged: o.merged ?? true }];
		j.report = `D:/w/proj/.git/pi/relay/${j.id}/report.md`;
		j.reason = o.reason;
		if (o.tokens !== undefined) j.used.tokens = o.tokens;
		this.bus.emit("relay:job-end", { v: 1, job: j.id, how, report: j.report, tag: j.tag, used: j.used, repos: j.repos, ...(o.reason ? { reason: o.reason } : {}) });
	}
}

function harness(run: Run = makeRun(), runTokens = 20_000_000) {
	const bus = new Bus();
	const relay = new FakeRelay(bus);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-relay-"));
	let stored: Run = JSON.parse(JSON.stringify(run));
	const told: string[] = [];
	let ended = 0;
	let chain: Promise<unknown> = Promise.resolve();
	const mutate = <T>(fn: (r: Run) => T): Promise<T> => {
		const p = chain.then(() => {
			const r = JSON.parse(JSON.stringify(stored)) as Run;
			const out = fn(r);
			stored = r;
			return out;
		});
		chain = p.catch(() => {});
		return p;
	};
	const ex = new RelayExec({ emit: bus.emit, read: () => JSON.parse(JSON.stringify(stored)), mutate, dir, runTokens: () => runTokens, tell: (t) => told.push(t), ended: () => ended++, timeoutMs: 2000 });
	const pending: Promise<unknown>[] = [];
	bus.on("relay:job-end", (d) => pending.push(ex.onJobEnd(d)));
	bus.on("relay:job-progress", (d) => pending.push(ex.onProgress(d)));
	bus.on("relay:approval", (d) => ex.onApproval(d));
	const settle = async () => {
		while (pending.length) await pending.shift();
		await chain;
	};
	return { bus, relay, dir, ex, told, settle, run: () => stored, st: (id: string) => stored.subs.find((s) => s.id === id) as Sub, ended: () => ended, set: (r: Run) => (stored = r) };
}

test("dispatch: A and B at once with tags and complete briefs, C only after A merged", async () => {
	const h = harness();
	await h.ex.dispatchReady();
	assert.deepEqual([...h.relay.jobs.values()].map((j) => j.tag), [{ run: "o11140900-x", package: "a" }, { run: "o11140900-x", package: "b" }]);
	for (const j of h.relay.jobs.values()) {
		assert.deepEqual(checkRelayBrief(j.brief, ["proj"]), [], "the local check passes");
		assert.ok(!/^##\s+Depends on/m.test(j.brief), "no Depends on");
		for (const s of ["Goal", "Done when", "Non-goals", "Constraints", "Decisions (locked)", "Design", "Scale", "Verify", "Targets", "Authority", "Files"]) assert.match(j.brief, new RegExp(`^## ${s.replace(/[()]/g, "\\$&")}$`, "m"), s);
		assert.match(j.brief, /^- proj: master$/m, "Targets: folder name, origin/ stripped");
		assert.ok(fs.existsSync(path.join(h.dir, j.tag.package, "brief.md")));
	}
	assert.equal(h.st("a").state, "dispatched");
	assert.equal(h.st("a").job, h.relay.byPkg("a").id);
	assert.equal(h.st("c").state, "planned");
	h.relay.end("a", "delivered");
	await h.settle();
	assert.equal(h.st("a").state, "merged");
	assert.equal(h.st("c").state, "dispatched", "C follows once A merged");
	assert.equal(h.relay.jobs.size, 3);
});

test("A fails twice: one followup retry (with a still-finishing answer), then failed and C blocked", async () => {
	const h = harness();
	await h.ex.dispatchReady();
	h.relay.controlErrors.push("job r000001 is still finishing; try again in a moment");
	h.relay.end("a", "failed", { reason: "the worker exited without report_done" });
	await h.settle();
	assert.equal(h.st("a").state, "retry-pending", "still finishing: retried at the next poll");
	assert.equal(h.relay.controls.length, 0);
	await h.ex.tick();
	assert.equal(h.relay.controls.length, 1);
	assert.equal(h.relay.controls[0].action, "followup");
	assert.match(h.relay.controls[0].text ?? "", /the worker exited without report_done/);
	assert.match(h.relay.controls[0].text ?? "", /report\.md/);
	assert.equal(h.st("a").state, "dispatched");
	assert.equal(h.st("a").retries, 1);
	h.relay.end("a", "failed", { reason: "judge cap" });
	await h.settle();
	assert.equal(h.st("a").state, "failed");
	assert.match(h.st("a").reason ?? "", /judge cap/);
	assert.equal(h.st("c").state, "blocked");
	assert.equal(h.st("c").reason, "blocked by a: judge cap (after its retry)");
	assert.ok(h.told.some((t) => /package a failed/.test(t) && /Blocked: c/.test(t)), "the user is told");
	assert.equal(h.relay.controls.length, 1, "no second retry");
});

test("a followup error other than still finishing fails the package", async () => {
	const h = harness();
	await h.ex.dispatchReady();
	h.relay.controlErrors.push("job is not finished");
	h.relay.end("a", "stopped", { reason: "stopped by the lead" });
	await h.settle();
	assert.equal(h.st("a").state, "failed");
	assert.equal(h.st("c").state, "blocked");
});

test("no retry after a budget reason or an orchestrator stop", async () => {
	const h = harness();
	await h.ex.dispatchReady();
	h.relay.end("a", "failed", { reason: "budget: tokens 4000000 reached" });
	await h.settle();
	assert.equal(h.st("a").state, "failed");
	assert.equal(h.st("c").state, "blocked");
	assert.ok(await h.ex.markOwnStop(h.relay.byPkg("b").id));
	assert.equal(h.st("b").stoppedBy, "orchestrator");
	h.relay.end("b", "stopped", { reason: "stopped by the lead" });
	await h.settle();
	assert.equal(h.st("b").state, "failed");
	assert.equal(h.relay.controls.length, 0);
	assert.equal(retryAllowed({ retries: 0 }, "budget: wall"), false);
	assert.equal(retryAllowed({ retries: 0 }, "crash"), true);
	assert.equal(retryAllowed({ retries: 1 }, "crash"), false);
});

test("PR-only A holds C until job-query shows it merged; the run stays active meanwhile", async () => {
	const h = harness(makeRun([sub("a"), sub("c", ["a"])]));
	await h.ex.dispatchReady();
	h.relay.end("a", "delivered", { merged: false });
	await h.settle();
	assert.equal(h.st("a").state, "delivered-pr");
	assert.ok(h.told.some((t) => t.includes("pull/r000001") && /holds c/.test(t)), "the user is told which PR holds which package");
	assert.ok(h.told.some((t) => /run report/.test(t)), "only a hold left: the report is written");
	assert.equal(h.run().state, "active");
	assert.equal(h.ended(), 0);
	await h.ex.tick();
	assert.equal(h.st("c").state, "planned");
	h.relay.byPkg("a").repos[0].merged = true;
	await h.ex.tick();
	assert.equal(h.st("a").state, "merged");
	assert.equal(h.st("c").state, "dispatched");
	h.relay.end("c", "delivered");
	await h.settle();
	assert.equal(h.run().state, "ended");
	assert.equal(h.ended(), 1);
	assert.match(fs.readFileSync(path.join(h.dir, "report.md"), "utf8"), /### c: merged/, "the report is replaced");
});

test("run cap: every unfinished job is stopped, undispatched packages blocked, the user told", async () => {
	const h = harness(undefined, 1000);
	await h.ex.dispatchReady();
	h.relay.progress("a", 600);
	await h.settle();
	assert.equal(h.relay.controls.length, 0);
	h.relay.progress("b", 500);
	await h.settle();
	assert.deepEqual(h.relay.controls.map((c) => c.action).sort(), ["stop", "stop"]);
	assert.equal(h.st("a").stoppedBy, "orchestrator");
	assert.equal(h.st("c").state, "blocked");
	assert.equal(h.st("c").reason, "run cap");
	assert.ok(h.told.some((t) => /run cap reached: 1,100 of 1,000/.test(t)));
	// relay is still finishing the stops: another progress event or poll stops nothing and tells nothing again
	h.relay.byPkg("a").state = "working";
	h.relay.progress("a", 700);
	await h.settle();
	await h.ex.tick();
	assert.equal(h.relay.controls.length, 2);
	assert.equal(h.told.filter((t) => /run cap reached/.test(t)).length, 1);
	// a fresh executor (restart) does not stop them again either
	const ex2 = new RelayExec({ emit: h.bus.emit, read: () => h.run(), mutate: (fn) => Promise.resolve(fn(h.run())), dir: h.dir, runTokens: () => 1000, tell: (t) => h.told.push(t), ended: () => {} });
	await ex2.checkCap();
	assert.equal(h.relay.controls.length, 2);
	h.relay.end("a", "stopped", { reason: "stopped by the lead" });
	h.relay.end("b", "stopped", { reason: "stopped by the lead" });
	await h.settle();
	assert.equal(h.st("a").state, "failed", "no retry after the orchestrator's stop");
	assert.equal(h.run().state, "ended");
	assert.match(fs.readFileSync(path.join(h.dir, "report.md"), "utf8"), /1,200 weighted tokens used of 1,000/);
});

test("a duplicate job-end is ignored; a job-end of another run too", async () => {
	const h = harness(makeRun([sub("a"), sub("c", ["a"])]));
	await h.ex.dispatchReady();
	h.relay.end("a", "delivered");
	h.relay.end("a", "delivered");
	await h.settle();
	assert.equal(h.relay.jobs.size, 2, "C dispatched once");
	await h.ex.onJobEnd({ v: 1, job: h.relay.byPkg("c").id, how: "failed", report: "x", tag: { run: "other", package: "c" } });
	assert.equal(h.st("c").state, "dispatched");
});

test("report: approvals first, then packages, tokens and open findings; the run ends after it", async () => {
	const h = harness(makeRun([sub("a"), sub("b")]));
	fs.writeFileSync(path.join(h.dir, "findings.md"), "- major - [x] fix: auto - an open finding\n");
	await h.ex.dispatchReady();
	const a = h.relay.byPkg("a");
	h.bus.emit("relay:approval", { v: 1, job: a.id, category: "deps", item: "npm install x", by: "lead", reason: "user said yes", tag: a.tag });
	h.bus.emit("relay:approval", { v: 1, job: a.id, category: "deps", item: "y", by: "lead", reason: "r", tag: { run: "other", package: "a" } });
	assert.equal(readApprovals(h.dir).length, 1);
	h.relay.end("a", "delivered", { tokens: 1234 });
	h.relay.end("b", "failed", { reason: "budget: tokens" });
	await h.settle();
	const report = fs.readFileSync(path.join(h.dir, "report.md"), "utf8");
	assert.ok(report.indexOf("## Approvals") < report.indexOf("## Packages"));
	assert.match(report, /- a \(r000001\): deps `npm install x` by lead: user said yes/);
	assert.match(report, /### a: merged/);
	assert.match(report, /report: .*r000001\/report\.md/);
	assert.match(report, /pull\/r000001/);
	assert.match(report, /### b: failed\n.*\n.*\n- reason: budget: tokens/);
	assert.match(report, /1,234 weighted tokens used/);
	assert.match(report, /an open finding/);
	assert.equal(h.run().state, "ended");
	assert.equal(h.ended(), 1);
	assert.ok(h.told.some((t) => t.includes("## Approvals")), "the report is shown to the user");
});

test("restart: rebuild from job-query (no session context first), finished jobs processed as job-ends, unknown fails", async () => {
	const h = harness(makeRun([sub("a"), sub("b"), sub("c", ["a"])]));
	await h.ex.dispatchReady();
	const a = h.relay.byPkg("a");
	a.state = "done";
	a.repos = [{ key: "proj", merged: true }];
	a.used.tokens = 77;
	h.relay.jobs.delete(h.relay.byPkg("b").id);
	h.relay.queryError = "no session context";
	// a new session: a fresh executor over the same run.json
	const ex2 = new RelayExec({ emit: h.bus.emit, read: () => h.run(), mutate: (fn) => Promise.resolve(fn(h.run())), dir: h.dir, runTokens: () => 1e9, tell: () => {}, ended: () => {} });
	await ex2.tick();
	assert.equal(ex2.needsContext, true, "retried at the first turn");
	assert.equal(h.st("a").state, "dispatched");
	h.relay.queryError = undefined;
	await ex2.tick();
	assert.equal(h.st("a").state, "merged");
	assert.equal(h.st("a").tokens, 77);
	assert.equal(h.st("b").state, "failed");
	assert.equal(h.st("b").reason, "job not found");
	assert.equal(h.st("c").state, "dispatched");
});

test("restart: hosted is claimed again; no session context is pending once, then off", async () => {
	const bus = new Bus();
	const answers: unknown[] = [{ on: true, mode: "off", reason: "no session context" }, { on: true, mode: "on" }];
	const seen: unknown[] = [];
	bus.on("relay:hosted", (d) => {
		seen.push({ ...(d as object), claim: undefined });
		const c = (d as { claim?: (a: unknown) => void }).claim;
		c?.(Promise.resolve(answers.shift()));
	});
	assert.deepEqual(hostedDecision(await claimHosted(bus.emit, true), false), { state: "pending" });
	assert.deepEqual(hostedDecision(await claimHosted(bus.emit, true), true), { state: "on" });
	await claimHosted(bus.emit, false);
	assert.deepEqual(seen.map((s) => (s as { on: boolean }).on), [true, true, false]);
	assert.deepEqual(hostedDecision({ on: true, mode: "off", reason: "no session context" }, true), { state: "off", reason: "no session context" });
	assert.deepEqual(hostedDecision({ on: true, mode: "off", reason: "workflow owns this session" }, false), { state: "off", reason: "workflow owns this session" });
	assert.deepEqual(hostedDecision(null, false), { state: "off", reason: "relay is not loaded" });
	assert.deepEqual(hostedDecision({ error: "no answer within 5 s" }, false), { state: "off", reason: "no answer within 5 s" });
	assert.equal(await claimHosted(new Bus().emit, true), null, "nobody listening");
});

test("hostedChange and executorOf", () => {
	assert.equal(hostedChange("off", "discuss", "relay"), "on");
	assert.equal(hostedChange("discuss", "propose", "relay"), null);
	assert.equal(hostedChange("run", "off", "relay"), "off");
	assert.equal(hostedChange("off", "discuss", "workflow"), null);
	assert.equal(executorOf(null, "relay"), "relay");
	assert.equal(executorOf({}, "relay"), "workflow", "an older run is a workflow run");
	assert.equal(executorOf({ executor: "relay" }, "workflow"), "relay", "the run's executor wins over a later config change");
});

test("brief mapping: multi-repo keys become relay repo names, a clash uses the full top", () => {
	const run = makeRun([sub("a", [], { owns: ["api:src/**"], verify: ["api: npm test", "web: npm run lint", "echo a: b"], repos: ["api", "web"], scale: "1000 users", budget: "wall: 60m; tokens: 2M" }), sub("b", [], { owns: ["web:ui/**"], repos: ["web"] })]);
	run.repos = [{ key: "api", top: "D:/w/Api" }, { key: "web", top: "D:/w/web" }];
	run.targets = { api: "origin/main", web: "origin/dev" };
	delete run.top;
	assert.deepEqual([...relayNames(run)], [["api", "Api"], ["web", "web"]]);
	const brief = renderRelayBrief(run.subs[0], run);
	assert.deepEqual(checkRelayBrief(brief, ["Api", "web"]), []);
	assert.match(brief, /^- Api: main$/m);
	assert.match(brief, /^- web: dev$/m);
	assert.match(brief, /^- Api: npm test$/m);
	assert.match(brief, /^- web: npm run lint$/m);
	assert.match(brief, /^- echo a: b$/m);
	assert.match(brief, /^## Files\n- Api:src\/\*\*$/m);
	assert.match(brief, /web:ui\/\*\* \(package b owns it\)/);
	assert.match(brief, /^## Scale\n1000 users$/m);
	assert.match(brief, /^## Budget\nwall: 60m; tokens: 2M$/m);
	assert.match(brief, /User decision: keep the API/);
	assert.match(brief, /- run the tests/);
	assert.match(brief, /Non-goal of the run: no UI/);
	// b works only in web: a Verify line for api has no Targets line
	const b = renderRelayBrief({ ...run.subs[1], verify: ["api: npm test"] }, run);
	assert.ok(checkRelayBrief(b, ["Api", "web"]).some((e) => /names the repo "Api", which has no Targets line/.test(e)));
	// two repos with one folder name: the full tops are the keys, the same in Targets, Verify and Files
	const clash = makeRun([sub("a", [], { owns: ["x:src/**"], verify: ["x: npm test", "y: npm test"], repos: ["x", "y"] }), sub("b", [], { owns: ["y:lib/**"] })]);
	clash.repos = [{ key: "x", top: "D:/one/app" }, { key: "y", top: "D:/two/App" }];
	clash.targets = { x: "origin/main", y: "origin/main" };
	const names = relayNames(clash);
	assert.deepEqual([...names.values()], ["D:/one/app", "D:/two/App"]);
	const cb = renderRelayBrief(clash.subs[0], clash);
	assert.deepEqual(checkRelayBrief(cb, [...names.values()]), []);
	assert.match(cb, /^- D:\/one\/app: main$/m);
	assert.match(cb, /^- D:\/two\/App: npm test$/m);
	assert.match(cb, /^- D:\/one\/app:src\/\*\*$/m);
});

test("the local brief check: sections, Authority syntax, Targets, Depends on, Budget", () => {
	const run = makeRun();
	const good = renderRelayBrief(run.subs[0], run);
	assert.deepEqual(checkRelayBrief(good, ["proj"]), []);
	assert.ok(checkRelayBrief(good.replace(/## Scale\n[^\n]*\n/, ""), ["proj"]).some((e) => /"Scale" is missing/.test(e)));
	assert.ok(checkRelayBrief(good.replace("- publish: no", "- publish: maybe"), ["proj"]).some((e) => /cannot read "publish: maybe"/.test(e)));
	assert.ok(checkRelayBrief(good.replace("- deps: no\n", ""), ["proj"]).some((e) => /"deps" is missing/.test(e)));
	assert.ok(checkRelayBrief(good.replace("- merge: yes (squash-merge into master after PASS)", "- merge: yes"), ["proj"]).some((e) => /needs specifics/.test(e)));
	assert.ok(checkRelayBrief(`${good}\n## Depends on\nr123456\n`, ["proj"]).some((e) => /Depends on/.test(e)));
	assert.ok(checkRelayBrief(`${good}\n## Budget\nwall: soon\n`, ["proj"]).some((e) => /Budget/.test(e)));
	const noVerify = renderRelayBrief({ ...run.subs[0], verify: [] }, run);
	assert.ok(checkRelayBrief(noVerify, ["proj"]).some((e) => /"Verify" is missing/.test(e)));
	const noTarget = renderRelayBrief(run.subs[0], { ...run, targets: {} });
	assert.ok(checkRelayBrief(noTarget, ["proj"]).some((e) => /Targets/.test(e)));
	assert.ok(checkRelayBrief(good.replace("- src/a/**", "- other:src/a/**"), ["proj"]).some((e) => /unknown repo "other"/.test(e)));
});

test("buildReport lists held packages with what they hold", () => {
	const run = makeRun([sub("a", [], { state: "delivered-pr", job: "r1", prs: [{ key: "proj", pr: "https://x/pull/1", merged: false }] }), sub("c", ["a"])]);
	const r = buildReport(run, [], "", 10);
	assert.match(r, /### a: delivered-pr\n- job r1\n- proj: not merged \(https:\/\/x\/pull\/1\)\n- held: the PR waits for a merge by hand; it holds c/);
	assert.match(r, /- none/);
	assert.match(r, /None\./);
});
