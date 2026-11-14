// node --experimental-strip-types --test loop.test.ts
// The judge step on its own: the tree it records, a branch that moves while it runs, token counting.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { parseConfig } from "./config.ts";
import { emptyJob } from "./job.ts";
import { run } from "./sh.ts";
import { fitDiffs, judgeStep, verdictOf } from "./steps/loop.ts";
import type { StepCtx } from "./types.ts";
import { brief } from "./test/env.ts";
import { cleanup, git, makeRepo } from "./test/helpers.ts";

const PASS = "VERDICT: PASS";

function setup() {
	const { dir } = makeRepo();
	const base = git(dir, "rev-parse", "HEAD");
	fs.writeFileSync(path.join(dir, "greeting.txt"), "hello\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "work");
	const job = emptyJob("r1", "t", "r1", "normal", { wallMs: 1e9, tokens: 1e9 });
	job.repos.push({ key: "R0", main: dir, worktree: dir, target: "main", base, branch: "main" });
	job.cwd = dir;
	job.state = "judging";
	const logs: string[] = [];
	const wakes: string[] = [];
	const reviews: string[] = [];
	let onReview: (n: number) => void = () => {};
	const dirJob = path.join(dir, ".git", "jobdir");
	fs.mkdirSync(dirJob, { recursive: true });
	const ctx: StepCtx = {
		dir: dirJob,
		cfg: parseConfig({}).config,
		run,
		shell: async () => ({ code: 0, out: "" }),
		brief: () => brief({ repo: dir }),
		save() {},
		log: (k, t) => logs.push(`${k}: ${t}`),
		notify() {},
		wake: (t) => wakes.push(t),
		isOwner: () => true,
		stopped: () => false,
		wt: { create: async () => ({ error: "x" }), remove: async () => ({ error: "x" }) },
		worker: { alive: true, settled: true, exited: false, nudges: 0, openAsks: [] },
		startWorker: async () => {},
		prompt: async () => {},
		stopWorker: async () => {},
		review: async () => {
			reviews.push("judge");
			onReview(reviews.length);
			return { ok: true, text: PASS, turns: 1, usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: {} } as any, toolCalls: [] };
		},
		emit() {},
		now: () => 0,
		relayDir: "",
		leadCwd: dir,
		folders: () => [],
	};
	return { dir, job, ctx, logs, wakes, reviews, setReview: (f: (n: number) => void) => (onReview = f) };
}

test("the judged tree is the tree the judge saw; judge tokens count against the budget", async () => {
	const s = setup();
	try {
		assert.equal(await judgeStep.run(s.job, s.ctx), "deliver");
		assert.equal(s.job.repos[0].judgedTree, git(s.dir, "rev-parse", "HEAD^{tree}"));
		assert.equal(s.job.lastVerdict?.verdict, "PASS");
		assert.equal(s.job.used.tokens, 1000 + 100 * 5, "weighted: input 1, output 5");
		assert.ok(s.wakes.some((w) => /judge PASS/.test(w)));
	} finally {
		cleanup(s.dir);
	}
});

test("a commit made while the judge runs is not recorded as judged: the judge runs again on the new tree", async () => {
	const s = setup();
	try {
		s.setReview((n) => {
			if (n !== 1) return;
			fs.writeFileSync(path.join(s.dir, "late.txt"), "late\n");
			git(s.dir, "add", "-A");
			git(s.dir, "commit", "-q", "-m", "late commit");
		});
		assert.equal(await judgeStep.run(s.job, s.ctx), "judge", "the first verdict is discarded");
		assert.match(s.logs.join("\n"), /moved: the branch changed while the judge ran/);
		assert.equal(s.job.lastVerdict, undefined);
		assert.equal(await judgeStep.run(s.job, s.ctx), "deliver");
		assert.equal(s.job.repos[0].judgedTree, git(s.dir, "rev-parse", "HEAD^{tree}"));
		assert.equal(s.reviews.length, 2);
	} finally {
		cleanup(s.dir);
	}
});

test("fitDiffs: all diffs when they fit; the file list and the diffs that fit when not", () => {
	const parts = [
		{ key: "A", base: "a".repeat(40), full: "diff A\n".repeat(10), names: ["a.ts"] },
		{ key: "B", base: "b".repeat(40), full: "diff B\n".repeat(1000), names: ["b.ts"] },
	];
	assert.match(fitDiffs(parts, 100_000), /### Repo A .*\n\ndiff A[\s\S]*### Repo B/);
	const small = fitDiffs(parts, 500);
	assert.match(small, /over the limit of 500/);
	assert.match(small, /### Repo A files\n- a\.ts/);
	assert.match(small, /### Repo A diff/);
	assert.ok(!/### Repo B diff/.test(small));
});

test("verdictOf: PASS needs the verdict line and no blocker or major finding", () => {
	assert.equal(verdictOf("- minor - [x] `a:1` t fix: auto\n  Why: w\n  Fix: f\nVERDICT: PASS").verdict, "PASS");
	assert.equal(verdictOf("- major - [x] `a:1` t fix: auto\n  Why: w\n  Fix: f\nVERDICT: PASS").verdict, "FAIL");
	assert.equal(verdictOf("VERDICT: FAIL").verdict, "FAIL");
	assert.equal(verdictOf("no verdict line").verdict, "FAIL");
});
