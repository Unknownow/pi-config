// node --experimental-strip-types --test deliver.test.ts
// Delivery (D14) on temp repos with bare remotes: rebase, accept, push rule, merge.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { defaultShell } from "./engine.ts";
import { emptyJob, type Job } from "./job.ts";
import { gateCheck } from "./merge-gate.ts";
import { parseConfig } from "./config.ts";
import { run } from "./sh.ts";
import { deliverStep, mergeAllowed, pushJobBranch, verifyCommands } from "./steps/deliver.ts";
import type { StepCtx } from "./types.ts";
import { git, makeRepo, tmpDir, cleanup } from "./test/helpers.ts";
import { brief } from "./test/env.ts";

const fwd = (p: string) => p.split("\\").join("/");

const stopped = { value: false };

interface Scenario {
	job: Job;
	ctx: StepCtx;
	prompts: string[];
	wakes: string[];
	logs: string[];
	repos: { main: string; bare: string; wt: string }[];
	push(i: number, file: string, content: string): void;
	commit(i: number, file: string, content: string): void;
	clean(): void;
}

/** Repos "R0", "R1", ... each with a bare origin and a job worktree on wt/r1 that already holds one worker commit (`greeting.txt`). */
function scenario(n: number, briefOver: Parameters<typeof brief>[0] = {}, cfgRaw: object = {}): Scenario {
	const sets = tmpDir("relay-sets-");
	const repos: Scenario["repos"] = [];
	const job = emptyJob("r1", "t", "r1", "normal", { wallMs: 1e9, tokens: 1e9 });
	for (let i = 0; i < n; i++) {
		const { dir, bare } = makeRepo({ "a.txt": "a\n", "b.txt": "b\n" }, true);
		const wt = path.join(sets, `w${i}`);
		git(dir, "worktree", "add", "-q", "-b", "wt/r1", wt, "origin/main");
		git(wt, "config", "core.autocrlf", "false");
		fs.writeFileSync(path.join(wt, "greeting.txt"), "hello\n");
		git(wt, "add", "-A");
		git(wt, "commit", "-q", "-m", "work");
		repos.push({ main: fwd(dir), bare: bare!, wt: fwd(wt) });
		job.repos.push({ key: `R${i}`, main: fwd(dir), worktree: fwd(wt), target: "main", base: git(dir, "rev-parse", "origin/main"), branch: "wt/r1", judgedTree: git(wt, "rev-parse", "HEAD^{tree}") });
	}
	job.state = "delivering";
	const text = brief({ repo: "R0", ...briefOver }).replace(/## Targets\n.*\n/, `## Targets\n${repos.map((_, i) => `- R${i}: main`).join("\n")}\n`);
	const prompts: string[] = [];
	const wakes: string[] = [];
	const logs: string[] = [];
	const cfg = parseConfig(cfgRaw).config;
	const ctx: StepCtx = {
		dir: sets,
		cfg,
		run,
		shell: defaultShell,
		brief: () => text,
		save() {},
		log: (k, t) => logs.push(`${k}: ${t}`),
		notify() {},
		wake: (t) => wakes.push(t),
		isOwner: () => true,
		stopped: () => stopped.value,
		wt: { create: async () => ({ error: "x" }), remove: async () => ({ error: "x" }) },
		worker: { alive: true, settled: true, exited: false, nudges: 0, openAsks: [] },
		startWorker: async () => {},
		prompt: async (t) => void prompts.push(t),
		stopWorker: async () => {},
		review: async () => ({ ok: false, text: "", turns: 0, usage: {} as any, toolCalls: [] }),
		emit() {},
		now: () => 0,
		relayDir: "",
		leadCwd: repos[0].main,
		folders: () => [],
	};
	const other = (i: number) => {
		const d = path.join(sets, `other${i}`);
		if (!fs.existsSync(d)) git(sets, "clone", "-q", repos[i].bare, d);
		else git(d, "pull", "-q", "--rebase", "origin", "main");
		return d;
	};
	return {
		job,
		ctx,
		prompts,
		wakes,
		logs,
		repos,
		push(i, file, content) {
			const d = other(i);
			fs.writeFileSync(path.join(d, file), content);
			git(d, "add", "-A");
			git(d, "commit", "-q", "-m", `upstream ${file}`);
			git(d, "push", "-q", "origin", "main");
		},
		commit(i, file, content) {
			fs.writeFileSync(path.join(repos[i].wt, file), content);
			git(repos[i].wt, "add", "-A");
			git(repos[i].wt, "commit", "-q", "-m", `more ${file}`);
			job.repos[i].judgedTree = git(repos[i].wt, "rev-parse", "HEAD^{tree}");
		},
		clean: () => cleanup(sets, ...repos.flatMap((r) => [r.main, r.bare])),
	};
}

const MERGE = { authority: { merge: "yes (fast-forward to main)" } };

test("verifyCommands and mergeAllowed", () => {
	assert.deepEqual(verifyCommands("- npm test\n- `R1: dotnet test`\n```\nnode build.js\n```", ["R0", "R1"]), [{ cmd: "npm test" }, { repo: "R1", cmd: "dotnet test" }, { cmd: "node build.js" }]);
	assert.equal(mergeAllowed({ value: "yes", specifics: "x" }, false, "pr-only"), true);
	assert.equal(mergeAllowed({ value: "no" }, false, "after-pass"), false);
	assert.equal(mergeAllowed({ value: "n/a" }, false, "after-pass"), true);
	assert.equal(mergeAllowed(undefined, false, "pr-only"), false);
	assert.equal(mergeAllowed({ value: "no" }, true, "pr-only"), true);
});

test("a clean rebase with no overlap and passing Verify is passedViaRebase; without GitHub the merge is a push to the target", async () => {
	const s = scenario(1, MERGE);
	try {
		s.push(0, "b.txt", "upstream change\n");
		const before = s.job.repos[0].judgedTree;
		assert.equal(await deliverStep.run(s.job, s.ctx), "report");
		const r = s.job.repos[0];
		assert.equal(r.passedViaRebase?.from, before);
		assert.notEqual(r.acceptedTree, before);
		assert.equal(r.merged, true);
		assert.equal(git(s.repos[0].bare, "show", "main:greeting.txt"), "hello");
		assert.equal(git(s.repos[0].bare, "show", "main:b.txt"), "upstream change");
	} finally {
		s.clean();
	}
});

test("nothing new upstream: the judged tree is the accepted tree", async () => {
	const s = scenario(1, MERGE);
	try {
		assert.equal(await deliverStep.run(s.job, s.ctx), "report");
		assert.equal(s.job.repos[0].acceptedTree, s.job.repos[0].judgedTree);
		assert.equal(s.job.repos[0].passedViaRebase, undefined);
	} finally {
		s.clean();
	}
});

test("an overlap, a conflict and a failed Verify each give a fix round, and nothing is pushed", async () => {
	for (const [name, setup, verify, expect] of [
		["overlap", (s: Scenario) => s.push(0, "greeting.txt", "hello\n"), undefined, /changed files you also changed \(greeting\.txt\)/],
		["conflict", (s: Scenario) => s.push(0, "greeting.txt", "different\n"), undefined, /conflicts in greeting\.txt/],
		["verify", (s: Scenario) => s.push(0, "b.txt", "x\n"), 'node -e "process.exit(3)"', /Verify failed in R0.*exited 3/s],
	] as const) {
		const s = scenario(1, { ...MERGE, ...(verify ? { verify } : {}) });
		try {
			setup(s);
			assert.equal(await deliverStep.run(s.job, s.ctx), "work", name);
			assert.match(s.prompts.join("\n"), expect, name);
			assert.equal(s.job.state, "working");
			assert.equal(s.job.round, 1);
			assert.equal(s.job.repos[0].merged, undefined);
			assert.equal(git(s.repos[0].bare, "branch", "--list", "wt/r1"), "", `${name}: nothing pushed`);
			// a conflict leaves no rebase in progress
			assert.equal(git(s.repos[0].wt, "status", "--porcelain"), "");
		} finally {
			s.clean();
		}
	}
});

test("a branch that changed after the judge is not accepted even when upstream did not move", async () => {
	const s = scenario(1, MERGE);
	try {
		s.job.repos[0].judgedTree = "not-the-head-tree";
		assert.equal(await deliverStep.run(s.job, s.ctx), "work");
		assert.match(s.prompts.join("\n"), /changed after the judge reviewed it/);
		assert.equal(s.job.repos[0].acceptedTree, undefined);
		assert.equal(s.job.repos[0].merged, undefined);
		assert.equal(git(s.repos[0].bare, "branch", "--list", "wt/r1"), "");
	} finally {
		s.clean();
	}
});

test("a stop while delivery runs means no push and no merge", async () => {
	const s = scenario(1, MERGE);
	try {
		stopped.value = true;
		assert.equal(await deliverStep.run(s.job, s.ctx), "report");
		assert.equal(git(s.repos[0].bare, "branch", "--list", "wt/r1"), "");
		assert.equal(s.job.repos[0].merged, undefined);
		assert.equal(git(s.repos[0].bare, "log", "--oneline", "main").split("\n").length, 1);
	} finally {
		stopped.value = false;
		s.clean();
	}
});

test("a rejected first push is reported as a plain push failure, not as a lease failure", async () => {
	const s = scenario(1, MERGE);
	try {
		fs.mkdirSync(path.join(s.repos[0].bare, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(s.repos[0].bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'branch protection says no' >&2\nexit 1\n", { mode: 0o755 });
		const res = await pushJobBranch(s.ctx, s.job.repos[0], ["main"]);
		assert.ok(!res.ok && /git push failed/.test(res.error) && !/lease/.test(res.error), JSON.stringify(res));
	} finally {
		s.clean();
	}
});

test("the gate refuses a tree that was not accepted", async () => {
	const s = scenario(1, MERGE);
	try {
		const sha = git(s.repos[0].wt, "rev-parse", "HEAD");
		const g = await gateCheck(run, "protected-push", s.repos[0].wt, sha, { passedTrees: ["0000"], noMerge: false });
		assert.match(g.problem ?? "", /not judged/);
		const tree = git(s.repos[0].wt, "rev-parse", "HEAD^{tree}");
		assert.equal((await gateCheck(run, "protected-push", s.repos[0].wt, sha, { passedTrees: [tree], noMerge: false })).problem, null);
	} finally {
		s.clean();
	}
});

test("two repos: a failed Verify in B means no merge and no push anywhere; both accepted merge in Targets order", async () => {
	const s = scenario(2, { ...MERGE, verify: 'R1: node -e "process.exit(1)"' });
	try {
		s.push(1, "b.txt", "up\n");
		assert.equal(await deliverStep.run(s.job, s.ctx), "work");
		assert.match(s.prompts.join("\n"), /Verify failed in R1/);
		for (const r of s.repos) assert.equal(git(r.bare, "branch", "--list", "wt/r1"), "");
		assert.ok(s.job.repos.every((r) => !r.merged));
	} finally {
		s.clean();
	}
	const t = scenario(2, MERGE);
	try {
		t.push(0, "b.txt", "u0\n");
		t.push(1, "b.txt", "u1\n");
		assert.equal(await deliverStep.run(t.job, t.ctx), "report");
		assert.deepEqual(t.logs.filter((l) => l.startsWith("merged")), ["merged: R0 -> main", "merged: R1 -> main"]);
		for (const r of t.repos) assert.equal(git(r.bare, "show", "main:greeting.txt"), "hello");
	} finally {
		t.clean();
	}
});

test("pushes: the first creates the branch, a later delivery rebases and pushes with force-with-lease, someone else's push makes the lease fail", async () => {
	const s = scenario(1, { authority: { merge: "no" } });
	try {
		const r = s.job.repos[0];
		assert.equal(await deliverStep.run(s.job, s.ctx), "report");
		const first = git(s.repos[0].wt, "rev-parse", "HEAD");
		assert.equal(r.remotePushed, first);
		assert.equal(r.remoteBranch, "wt/r1");
		assert.equal(git(s.repos[0].bare, "rev-parse", "wt/r1"), first);
		assert.equal(r.merged, undefined, "pr-only: no merge");

		// origin/main moves; the job delivers again: rebase, then a lease push
		s.push(0, "b.txt", "moved\n");
		assert.equal(await deliverStep.run(s.job, s.ctx), "report");
		const second = git(s.repos[0].wt, "rev-parse", "HEAD");
		assert.notEqual(second, first);
		assert.equal(r.remotePushed, second);
		assert.equal(git(s.repos[0].bare, "rev-parse", "wt/r1"), second);

		// someone else pushes to the job branch; origin/main moves again
		const other = path.join(s.ctx.dir, "intruder");
		git(s.ctx.dir, "clone", "-q", "-b", "wt/r1", s.repos[0].bare, other);
		fs.writeFileSync(path.join(other, "intruder.txt"), "x\n");
		git(other, "add", "-A");
		git(other, "commit", "-q", "-m", "intruder");
		git(other, "push", "-q", "origin", "wt/r1");
		const theirs = git(s.repos[0].bare, "rev-parse", "wt/r1");
		s.push(0, "a.txt", "moved again\n");
		assert.equal(await deliverStep.run(s.job, s.ctx), "wait");
		assert.match(s.wakes.join("\n"), /lease failed/);
		assert.equal(git(s.repos[0].bare, "rev-parse", "wt/r1"), theirs, "never overwritten");
		assert.equal(r.remotePushed, second, "remotePushed still names relay's own last push");
		assert.equal(s.job.state, "delivering");
	} finally {
		s.clean();
	}
});

test("retrying delivery after it stopped past a rebase does not start a fix round", async () => {
	const s = scenario(1, { authority: { merge: "no" } });
	try {
		const r = s.job.repos[0];
		s.push(0, "b.txt", "moved\n");
		assert.equal(await deliverStep.run(s.job, s.ctx), "report");
		assert.ok(r.passedViaRebase);
		const pushed = r.remotePushed!;
		// someone else adds a commit to the job branch, and the lease fails on the next delivery (after origin/main moves)
		const other = path.join(s.ctx.dir, "intruder");
		git(s.ctx.dir, "clone", "-q", "-b", "wt/r1", s.repos[0].bare, other);
		fs.writeFileSync(path.join(other, "x.txt"), "x\n");
		git(other, "add", "-A");
		git(other, "commit", "-q", "-m", "intruder");
		git(other, "push", "-q", "origin", "wt/r1");
		// a retry with nothing moved: the lease fails again (the branch is not what relay pushed), and delivery waits
		assert.equal(await deliverStep.run(s.job, s.ctx), "wait");
		assert.equal(s.job.round, 0);
		// the branch is put back to what relay pushed; the retry delivers, with no fix round and no prompt
		git(s.repos[0].bare, "update-ref", "refs/heads/wt/r1", pushed);
		assert.equal(await deliverStep.run(s.job, s.ctx), "report");
		assert.equal(s.job.round, 0);
		assert.deepEqual(s.prompts, []);
	} finally {
		s.clean();
	}
});

test("the first push refuses a branch that already exists on origin, and never the target or a protected branch", async () => {
	const s = scenario(1, MERGE);
	try {
		git(s.repos[0].wt, "push", "-q", "origin", "HEAD:wt/r1");
		const r = s.job.repos[0];
		const res = await pushJobBranch(s.ctx, r, ["main"]);
		assert.ok(!res.ok && /already exists/.test(res.error));
		r.remoteBranch = "main";
		const t = await pushJobBranch(s.ctx, r, ["main"]);
		assert.ok(!t.ok && /protected branch or the target/.test(t.error));
	} finally {
		s.clean();
	}
});
