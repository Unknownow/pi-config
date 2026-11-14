// node --experimental-strip-types --test stage4.test.ts
// Stage 4: queue and overlap, stacked jobs, add-repo, widget and log.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { briefFiles, parseBrief } from "./brief.ts";
import { awaitingPred, toolSummary } from "./engine.ts";
import { filesOverlap } from "./glob.ts";
import { appendLog, type Job, readJob, stackState } from "./job.ts";
import { run } from "./sh.ts";
import { runSubagent } from "./subagent.ts";
import { brief, type World, waitFor, world } from "./test/env.ts";
import { cleanup, git, makeRepo, tmpDir } from "./test/helpers.ts";

const PASS = "VERDICT: PASS";
const nl = String.fromCharCode(10);
const turn = (file: string, content = "hello" + nl, done = "ok") => ({ write: [{ file, content }], done });

async function start(w: World, over: Parameters<typeof brief>[0] = {}): Promise<string> {
	const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, ...over }) });
	assert.ok("id" in r, JSON.stringify(r));
	return (r as { id: string }).id;
}
async function ended(w: World, id: string, ms = 60_000) {
	const jr = w.engine.get(id)!;
	await waitFor(() => jr.ended, ms, `job ${id} to end (state ${jr.job.state}; wakes: ${w.wakes.join(" | ").slice(0, 300)})`);
	return jr;
}
async function running(w: World, id: string) {
	const jr = w.engine.get(id)!;
	await waitFor(() => jr.job.state === "working" && jr.ws.alive, 30_000, `job ${id} to work (state ${jr.job.state})`);
	return jr;
}

// ------------------------------------------------------------------------------------------------ units

test("briefFiles: the Files section, else the paths named in Design; filesOverlap: files and globs", () => {
	const withFiles = parseBrief(brief({ repo: "R", extra: nl + "## Files" + nl + "src/**, a.txt" + nl }));
	assert.ok(!("errors" in withFiles));
	assert.deepEqual(briefFiles(withFiles as any), ["src/**", "a.txt"]);
	const text = brief({ repo: "R" }).replace("One new file.", "Change `src/app.ts` and `README.md`; call `foo()` and see `not a path`.");
	const p = parseBrief(text);
	assert.deepEqual(briefFiles(p as any), ["src/app.ts", "README.md"]);
	assert.equal(filesOverlap(["a.txt"], ["ab.txt"]), false);
	assert.equal(filesOverlap(["src/**"], ["src/x.ts"]), true);
	assert.equal(filesOverlap(["src/*.ts"], ["lib/*.ts"]), false);
	assert.equal(filesOverlap(["src/**"], ["src/ui/**"]), true);
	assert.equal(filesOverlap(["**/x.ts"], ["src/**"]), true);
	assert.equal(filesOverlap(["*.md"], ["src/*.ts"]), false);
	assert.equal(filesOverlap(["**/package.json"], ["**/package.json"]), true);
});

test("toolSummary: the tool name and a short first argument", () => {
	assert.equal(toolSummary("bash", { command: "echo   hi" }), "bash: echo hi");
	assert.equal(toolSummary("read", { path: "a/b.ts" }), "read: a/b.ts");
	assert.equal(toolSummary("x", {}), "x");
	assert.ok(toolSummary("bash", { command: "y".repeat(300) }).length < 100);
});

test("stackState: none, open until the predecessor's repo merged, then merged", () => {
	const repo: any = { main: "/r", stackedOn: { job: "rp", branch: "wt/rp", head: "abc" } };
	const pred = (merged?: boolean) => ({ repos: [{ main: "/R", merged }] }) as unknown as Job;
	assert.equal(stackState({ main: "/r" } as any, undefined), "none");
	assert.equal(stackState(repo, undefined), "open");
	assert.equal(stackState(repo, pred(false)), "open");
	assert.equal(stackState(repo, pred(true)), "merged");
});

// ------------------------------------------------------------------------------------------------ queue and overlap

test("3 jobs run and a 4th queues, then starts when a slot frees (in creation order)", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }, { hang: true }, { hang: true }, turn("greeting.txt")], judge: [PASS] });
		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			ids.push(await start(w));
			await running(w, ids[i]);
		}
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo }) });
		assert.ok("id" in r && r.queued, JSON.stringify(r));
		const fourth = (r as { id: string }).id;
		assert.equal(w.engine.get(fourth)!.job.state, "queued");
		assert.equal(w.engine.runningCount(), 3);
		await new Promise((res) => setTimeout(res, 300));
		assert.equal(w.engine.get(fourth)!.job.state, "queued", "no slot yet");
		await w.engine.stop(ids[0]);
		const jr = await ended(w, fourth);
		assert.equal(jr.job.state, "done");
		assert.equal(w.engine.get(ids[1])!.job.state, "working", "the other two kept running");
		for (const id of ids.slice(1)) await w.engine.stop(id);
	} finally {
		w.end();
	}
});

test("an overlap of the files two jobs name is a notice and a log entry in both", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }, { hang: true }, { hang: true }] });
		const a = await start(w, { extra: nl + "## Files" + nl + "src/**" + nl });
		await running(w, a);
		const b = await start(w, { extra: nl + "## Files" + nl + "src/x.ts" + nl });
		await running(w, b);
		assert.ok(w.notices.some((n) => n.includes(a) && n.includes(b) && /overlap/.test(n)), w.notices.join("|"));
		for (const id of [a, b]) assert.match(fs.readFileSync(path.join(w.engine.get(id)!.dir, "log.jsonl"), "utf8"), /"kind":"overlap"/);
		const c = await start(w, { extra: nl + "## Files" + nl + "lib/z.ts" + nl });
		await running(w, c);
		assert.equal(w.notices.filter((n) => /overlap/.test(n)).length, 1, "a disjoint job adds no notice");
		for (const id of [a, b, c]) await w.engine.stop(id);
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ stacked jobs

/** A world whose origin looks like GitHub and whose `gh` is faked: PRs are numbered, `merged` holds the PR urls that count as merged. */
function ghWorld(script: object) {
	const prs: Record<string, string> = {};
	const merged = new Set<string>();
	const gh: string[][] = [];
	let n = 1;
	const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
	const w = world({}, undefined, {
		run: async (c: string, a: string[], d: string, o?: any) => {
			if (c === "git" && a[0] === "remote" && a[1] === "get-url") return ok("git@github.com:o/r.git" + nl);
			if (c !== "gh") return run(c, a, d, o);
			gh.push(a);
			if (a[0] === "repo") return ok("{}");
			if (a[0] === "pr" && a[1] === "view") {
				if (a.includes("-R")) return prs[a[2]] ? ok(JSON.stringify({ url: prs[a[2]], state: "OPEN" })) : { code: 1, stdout: "", stderr: "no PR" };
				return ok(JSON.stringify({ state: merged.has(a[2]) ? "MERGED" : "OPEN" }));
			}
			if (a[0] === "pr" && a[1] === "create") {
				const head = a[a.indexOf("--head") + 1];
				prs[head] = `https://github.com/o/r/pull/${n++}`;
				return ok(prs[head] + nl);
			}
			if (a[0] === "pr" && a[1] === "edit") return ok("");
			return { code: 1, stdout: "", stderr: `unexpected gh ${a.join(" ")}` };
		},
	});
	w.write(script);
	return { w, prs, merged, gh };
}
/** The predecessor's branch is squash-merged into origin/main, as GitHub would, after another commit landed there. */
function squashMerge(w: World, branch: string): void {
	const c = tmpDir("relay-sq-");
	git(c, "clone", "-q", w.bare!, ".");
	fs.writeFileSync(path.join(c, "up.txt"), "u" + nl);
	git(c, "add", "-A");
	git(c, "commit", "-q", "-m", "upstream up.txt");
	git(c, "fetch", "-q", "origin", branch);
	git(c, "merge", "--squash", `origin/${branch}`);
	git(c, "commit", "-q", "-m", `squash ${branch}`);
	git(c, "push", "-q", "origin", "main");
	cleanup(c);
}

test("a stacked job starts on its predecessor's branch, opens its PR against it, and is restacked with --onto after a squash merge", async () => {
	const { w, prs, merged, gh } = ghWorld({ worker: [turn("greeting.txt"), turn("b2.txt", "b" + nl)], judge: [PASS, PASS] });
	try {
		const a = await start(w);
		const ja = await ended(w, a);
		assert.equal(ja.job.state, "done");
		const ra = ja.job.repos[0];
		assert.ok(ra.pr && ra.remotePushed && !ra.merged);
		const b = await start(w, { extra: nl + "## Depends on" + nl + a + nl });
		const jb = await ended(w, b);
		assert.equal(jb.job.state, "done");
		const rb = jb.job.repos[0];
		assert.equal(w.wtCalls.create[1].bases[w.repo], `origin/wt/${a}`, "the set starts at the predecessor's branch");
		assert.deepEqual(rb.stackedOn, { job: a, branch: `wt/${a}`, head: ra.remotePushed });
		assert.equal(rb.base, ra.remotePushed);
		const create = gh.find((x) => x[0] === "pr" && x[1] === "create" && x.includes(`wt/${b}`))!;
		assert.equal(create[create.indexOf("--base") + 1], `wt/${a}`, "the PR targets the predecessor's branch");
		assert.ok(!gh.some((x) => x[1] === "merge"), "a stacked PR is not merged");
		assert.equal(jb.job.dependsOn, a);

		// the predecessor is squash-merged and main has moved: the dependent is restacked
		squashMerge(w, `wt/${a}`);
		merged.add(prs[`wt/${a}`]);
		assert.deepEqual(await w.engine.prCleanup(), [a]);
		assert.deepEqual(await w.engine.restack(), [b]);
		const job = readJob(w.engine.get(b)!.dir)!;
		assert.equal(job.state, "done");
		assert.equal(job.repos[0].stackedOn, undefined);
		assert.equal(job.repos[0].retarget, undefined);
		const edit = gh.find((x) => x[0] === "pr" && x[1] === "edit")!;
		assert.deepEqual([edit[2], edit[edit.indexOf("--base") + 1]], [prs[`wt/${b}`], "main"]);
		for (const f of ["greeting.txt", "up.txt", "b2.txt"]) assert.ok(git(w.bare!, "show", `wt/${b}:${f}`), f);
		assert.equal(git(w.bare!, "rev-list", "--count", `main..wt/${b}`), "1", "only the dependent's own commit is left on top of main");
		assert.equal(git(w.bare!, "rev-parse", `wt/${b}`), job.repos[0].remotePushed, "pushed with the lease, recorded");
		assert.deepEqual(await w.engine.restack(), [], "nothing more to restack");
	} finally {
		w.end();
	}
});

test("a stacked job waits until its predecessor has passed; an unknown predecessor is refused", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }, turn("b2.txt", "b" + nl)], judge: [PASS] });
		const unknown = await w.engine.dispatch({ brief: brief({ repo: w.repo, extra: nl + "## Depends on" + nl + "rzzzzzz" + nl }) });
		assert.ok("error" in unknown && /unknown/.test(unknown.error), JSON.stringify(unknown));
		const a = await start(w);
		await running(w, a);
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, extra: nl + "## Depends on" + nl + a + nl }) });
		assert.ok("id" in r && r.queued);
		assert.equal(w.engine.get((r as any).id)!.job.state, "queued");
		assert.equal(w.engine.runningCount(), 1, "a waiting dependent holds no slot");
		await w.engine.stop(a);
	} finally {
		w.end();
	}
});

test("when the predecessor stops, the dependent stops too, with the reason", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }] });
		const a = await start(w);
		await running(w, a);
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, extra: nl + "## Depends on" + nl + a + nl }) });
		const b = (r as { id: string }).id;
		await w.engine.stop(a);
		const jb = await ended(w, b);
		assert.equal(jb.job.state, "stopped");
		assert.match(jb.job.endReason ?? "", new RegExp(`predecessor ${a} stopped`));
		assert.ok(w.notices.some((n) => n.includes(b) && /predecessor/.test(n)));
		assert.match(fs.readFileSync(path.join(jb.dir, "report.md"), "utf8"), /predecessor/);
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ add-repo

test("relay_add_repo: a repo joins a running job; the worker is told; the judge diff and the delivery include it", async () => {
	const second = makeRepo({ "s.txt": "s" + nl }, true);
	const tasks: string[] = [];
	const w = world({}, undefined, {
		runReviewer: (o) => {
			if (/relay-role: judge/.test(o.systemPrompts.join(nl))) tasks.push(o.task);
			return runSubagent(o);
		},
	});
	try {
		w.write({ worker: [{ delayMs: 4000, ...turn("greeting.txt") }], judge: [PASS] });
		const id = await start(w);
		const jr = await running(w, id);
		assert.deepEqual(await w.engine.addRepo(id, "/no/such/folder", "main"), { error: '"/no/such/folder" is not a git repo' });
		const r = await w.engine.addRepo(id, second.dir, "main");
		assert.ok("ok" in r, JSON.stringify(r));
		assert.equal(w.wtCalls.addRepo[0].base, "origin/main");
		assert.equal(jr.job.repos.length, 2);
		assert.equal(jr.job.repos[1].target, "main");
		assert.equal(jr.job.repos[1].base, git(second.dir, "rev-parse", "origin/main"));
		assert.ok(w.cmds().some((c) => c.type === "steer" && /Repo .* is part of this job/.test(c.message)), "the worker was told");
		assert.match(JSON.stringify(await w.engine.addRepo(id, second.dir, "main")), /already in job/);
		// the worker's change in the new repo
		const wtree = (r as any).path as string;
		fs.writeFileSync(path.join(wtree, "extra.txt"), "x" + nl);
		git(wtree, "add", "-A");
		git(wtree, "commit", "-q", "-m", "extra");
		const done = await ended(w, id);
		assert.equal(done.job.state, "done", `${done.job.endReason ?? ""} ${w.wakes.join("|")}`);
		assert.ok(tasks[0].includes("extra.txt"), "the judge diff includes the added repo");
		assert.equal(git(second.bare!, "show", `${done.job.repos[1].remoteBranch}:extra.txt`), "x", "delivery pushed the added repo");
		assert.ok(done.job.repos.every((x) => x.remotePushed));
	} finally {
		w.end();
		cleanup(second.dir, second.bare);
	}
});

test("relay_add_repo refuses a finished job", async () => {
	const w = world();
	try {
		w.write({ worker: [turn("greeting.txt")], judge: [PASS] });
		const id = await start(w);
		await ended(w, id);
		const r = await w.engine.addRepo(id, w.repo, "main");
		assert.ok("error" in r && /working or paused/.test(r.error));
	} finally {
		w.end();
	}
});

// ------------------------------------------------------------------------------------------------ widget and log

test("the widget shows a line per unfinished job; /relay log prints the last n lines and the paths", async () => {
	const w = world();
	try {
		w.write({ worker: [{ tool: { name: "bash", args: { command: "echo hi" }, hang: true }, done: "x" }, { hang: true }] });
		const a = await start(w);
		await running(w, a);
		const b = await start(w);
		await running(w, b);
		await waitFor(() => /"kind":"tool"/.test(fs.readFileSync(path.join(w.engine.get(a)!.dir, "log.jsonl"), "utf8")), 10_000, "the tool in the log");
		appendLog(w.engine.get(a)!.dir, { kind: "amendment", text: "user (steer): a note" });
		const lines = w.engine.widgetLines();
		assert.equal(lines.length, 2);
		assert.ok(lines[0].includes(a) && /working r1/.test(lines[0]) && /\d+\/120m/.test(lines[0]), lines[0]);
		assert.ok(lines[1].includes(b));
		const log = w.engine.logText(a, 3);
		const [body, paths] = log.split(nl + nl);
		assert.equal(body.split(nl).length, 3, body);
		assert.ok(paths.includes(path.join(w.engine.get(a)!.dir, "log.jsonl")) && paths.includes("report.md") && paths.includes(`set: ${a}`));
		assert.match(w.engine.logText(a, 20), /tool: bash: echo hi/);
		assert.match(w.engine.logText("nope", 3), /unknown job/);
		await w.engine.stop(a);
		await w.engine.stop(b);
		assert.equal(w.engine.widgetLines().length, 0, "finished jobs leave the widget");
	} finally {
		w.end();
	}
});

test("relay_add_repo answering an approval ask grants nothing", async () => {
	const second = makeRepo({ "s.txt": "s" + nl }, true);
	const w = world();
	try {
		w.write({ worker: [{ hang: true }] });
		const id = await start(w);
		const jr = await running(w, id);
		jr.asks.set("m1", { type: "approval", id: "m1", category: "deps", item: "left-pad", why: "needed" } as any);
		jr.ws.openAsks.push("m1");
		const before = jr.job.approvals.length;
		const r = await w.engine.addRepo(id, second.dir, "main", "m1");
		assert.ok("ok" in r, JSON.stringify(r));
		assert.equal(jr.job.approvals.length, before, "no approval was recorded");
		assert.equal(jr.asks.has("m1"), false, "the ask is closed");
		const inbox = fs.readFileSync(path.join(jr.dir, "inbox.jsonl"), "utf8");
		assert.match(inbox, /"replyTo":"m1"/);
		assert.match(inbox, /nothing was approved/);
		await w.engine.stop(id);
	} finally {
		w.end();
		cleanup(second.dir, second.bare);
	}
});

test("adoption leaves a stacked job queued until its predecessor has passed", async () => {
	const w = world();
	try {
		w.write({ worker: [{ hang: true }, { hang: true }] });
		const a = await start(w);
		await running(w, a);
		const lf = path.join(w.engine.get(a)!.dir, "log.jsonl");
		await waitFor(() => fs.existsSync(lf) && /"kind":"dispatch"/.test(fs.readFileSync(lf, "utf8")), 10_000, "the dispatch step to finish");
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, extra: nl + "## Depends on" + nl + a + nl }) });
		const b = (r as { id: string }).id;
		await w.engine.shutdown(); // the lead goes away
				const e2 = w.mk();
		e2.start();
		const adopted = await e2.adopt();
		assert.deepEqual(adopted.sort(), [a, b].sort());
		await new Promise((res) => setTimeout(res, 400));
		assert.equal(e2.get(b)!.job.state, "queued", "still waiting for the predecessor");
		assert.equal(w.wtCalls.create.length, 1, "no set was created for the dependent");
		await e2.stop(a);
		await e2.shutdown();
	} finally {
		w.end();
	}
});

test("stackState: a follow-up that cleared the predecessor's merged flag still counts as merged", () => {
	const repo: any = { main: "/r", stackedOn: { job: "rp", branch: "wt/rp", head: "abc" } };
	assert.equal(stackState(repo, { repos: [{ main: "/r", mergedBefore: true }] } as unknown as Job), "merged");
	assert.equal(stackState(repo, { repos: [{ main: "/r", mergedBefore: true, remoteBranch: "wt/rp-f1" }] } as unknown as Job), "merged", "a dependent of the old branch");
	assert.equal(stackState(repo, { repos: [{ main: "/r", mergedBefore: true, remoteBranch: "wt/rp" }] } as unknown as Job), "open", "a dependent of the follow-up branch");
});

test("a queued job keeps its lock fresh, and a lead that lost the lock does not stop it", async () => {
	const w = world({}, undefined, { heartbeatMs: 50 });
	try {
		w.write({ worker: [{ hang: true }] });
		const a = await start(w);
		await running(w, a);
		const r = await w.engine.dispatch({ brief: brief({ repo: w.repo, extra: nl + "## Depends on" + nl + a + nl }) });
		const b = (r as { id: string }).id;
		const jr = w.engine.get(b)!;
		const beat = () => fs.readdirSync(jr.dir).filter((f) => /^owner\.\d+\.lock$/.test(f)).map((f) => fs.readFileSync(path.join(jr.dir, f), "utf8")).join();
		const before = beat();
		await waitFor(() => beat() !== before, 5000, "a heartbeat of the queued job");
		// another lead takes the lock: stop refuses and writes nothing
		jr.lock.isOwner = () => false;
		const s = await w.engine.stop(b);
		assert.ok("error" in s && /no longer owns/.test(s.error), JSON.stringify(s));
		assert.equal(readJob(jr.dir)!.state, "queued");
		jr.lock.isOwner = () => true;
		await w.engine.stop(a);
	} finally {
		w.end();
	}
});

test("the dependency gate applies only before the dependent first starts", () => {
	assert.equal(awaitingPred({ dependsOn: "rp", repos: [] } as unknown as Job), true);
	assert.equal(awaitingPred({ dependsOn: "rp", repos: [{}] } as unknown as Job), false, "already built on the predecessor");
	assert.equal(awaitingPred({ dependsOn: "rp", repos: [], followupPending: { n: 1, text: "x" } } as unknown as Job), false);
	assert.equal(awaitingPred({ repos: [] } as unknown as Job), false);
});

test("a lead that lost a job stops it: no save, no report, nothing delivered, and it leaves the widget", async () => {
	const w = world({}, undefined, { heartbeatMs: 50 });
	try {
		w.write({ worker: [{ hang: true }] });
		const a = await start(w);
		const jr = await running(w, a);
		jr.lock.heartbeat = async () => "lost";
		await waitFor(() => jr.ended, 5000, "the job to be let go");
		const stateAfter = fs.readFileSync(path.join(jr.dir, "job.json"), "utf8");
		assert.equal(jr.lost, true);
		assert.equal(jr.abort.signal.aborted, true);
		assert.equal(w.engine.widgetLines().length, 0);
		assert.ok(!fs.existsSync(path.join(jr.dir, "report.md")), "no report from a lead that lost the job");
		jr.job.state = "stopped";
		jr.job.endReason = "x";
		w.engine["save"](jr);
		assert.equal(fs.readFileSync(path.join(jr.dir, "job.json"), "utf8"), stateAfter, "job.json is not written any more");
	} finally {
		w.end();
	}
});
