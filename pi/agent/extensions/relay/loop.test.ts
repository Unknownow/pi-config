// node --experimental-strip-types --import ../agents/test-hooks.ts --test loop.test.ts
// The judge step on its own: the tree it records, a branch that moves while it runs, token counting, the agents judge request, ## Files.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { appendAmendment } from "./brief.ts";
import { parseConfig } from "./config.ts";
import { emptyJob } from "./job.ts";
import { run } from "./sh.ts";
import { writeFilesGuard } from "./files.ts";
import { JUDGE_CRITERIA } from "./reviews.ts";
import { judgeStep } from "./steps/loop.ts";
import type { JudgeCall, StepCtx } from "./types.ts";
import { brief, reviewOf } from "./test/env.ts";
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
	const calls: JudgeCall[] = [];
	let reply = PASS;
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
		judge: async (req) => {
			reviews.push("judge");
			calls.push(req);
			onReview(reviews.length);
			return reviewOf(reply, 1500);
		},
		now: () => 0,
		relayDir: "",
		leadCwd: dir,
		folders: () => [],
	};
	return { dir, job, ctx, logs, wakes, reviews, calls, setReply: (t: string) => (reply = t), setReview: (f: (n: number) => void) => (onReview = f) };
}

test("the judged tree is the tree the judge saw; judge tokens count against the budget", async () => {
	const s = setup();
	try {
		assert.equal(await judgeStep.run(s.job, s.ctx), "deliver");
		assert.equal(s.job.repos[0].judgedTree, git(s.dir, "rev-parse", "HEAD^{tree}"));
		assert.equal(s.job.lastVerdict?.verdict, "PASS");
		assert.deepEqual([s.job.lastVerdict?.blockers, s.job.lastVerdict?.majors, s.job.lastVerdict?.minors], [0, 0, 0]);
		assert.ok(s.wakes.some((w) => /round 1, 0 minor/.test(w)));
		assert.equal(s.job.used.tokens, 1500, "the judge's weightedCost (agents costOf: weighted tokens x model multiplier)");
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

test("an amendment the worker has not seen goes to the worker before the judge runs; an approval alone does not", async () => {
	const s = setup();
	try {
		const prompts: string[] = [];
		s.ctx.prompt = async (p) => void prompts.push(p);
		s.job.workerVersion = 1;
		s.ctx.brief = () => appendAmendment(brief({ repo: s.dir }), "user", "also say goodbye");
		assert.equal(await judgeStep.run(s.job, s.ctx), "work");
		assert.equal(s.reviews.length, 0, "the judge did not run");
		assert.match(prompts[0], /also say goodbye/);
		assert.equal(s.job.workerVersion, 2);
		assert.equal(s.job.state, "working");
		// an approval only widens Authority: the judge runs
		s.job.state = "judging";
		s.ctx.brief = () => appendAmendment(brief({ repo: s.dir }), "approval", "[deps] x approved");
		s.job.workerVersion = 1;
		assert.equal(await judgeStep.run(s.job, s.ctx), "deliver");
		assert.equal(s.reviews.length, 1);
	} finally {
		cleanup(s.dir);
	}
});

test("the judge gets the brief as spec, relay's criteria with the brief's own lines, the diff parts and the last round's findings; every round is full", async () => {
	const s = setup();
	try {
		const FAIL = "- major - [bug] `greeting.txt:1` - wrong fix: auto\n  Why: w\n  Fix: f\nVERDICT: FAIL";
		s.setReply(FAIL);
		assert.equal(await judgeStep.run(s.job, s.ctx), "work");
		const c = s.calls[0];
		assert.match(c.spec, /^Job r1, brief version 1:\n\n## Goal/);
		assert.ok(c.criteria.startsWith(JUDGE_CRITERIA));
		assert.match(c.criteria, /### Done when\n- greeting\.txt exists/);
		assert.match(c.criteria, /### Non-goals\n- nothing else/);
		assert.match(c.criteria, /### Decisions \(locked\)\n- the file is greeting\.txt/);
		assert.match(c.criteria, /### Authority\n- merge: no/);
		assert.match(JUDGE_CRITERIA, /\[plan\]/);
		assert.equal(c.previousFindings, undefined);
		assert.deepEqual(c.diff.map((p) => [p.key, p.names]), [["R0", ["greeting.txt"]]]);
		assert.equal(c.diff[0].base, s.job.repos[0].base);
		assert.match(c.diff[0].full, /\+hello/);
		assert.equal(c.cwd, s.dir);
		// the next round gets the findings of this one, and the whole diff again
		s.job.state = "judging";
		s.setReply(PASS);
		assert.equal(await judgeStep.run(s.job, s.ctx), "deliver");
		assert.deepEqual(s.calls[1].previousFindings?.map((f) => f.head), ["major - [bug] `greeting.txt:1` - wrong fix: auto"]);
		assert.deepEqual(s.calls[1].diff.map((p) => p.names), [["greeting.txt"]]);
		assert.equal(s.job.used.tokens, 3000);
	} finally {
		cleanup(s.dir);
	}
});

test("a missing verdict is retried once; twice pauses the job, never passes it", async () => {
	const s = setup();
	try {
		let n = 0;
		s.ctx.judge = async () => (n++, reviewOf("", 10, false));
		assert.equal(await judgeStep.run(s.job, s.ctx), "wait");
		assert.equal(n, 2);
		assert.equal(s.job.state, "paused");
		assert.equal(s.job.used.tokens, 20, "failed judge runs count too");
	} finally {
		cleanup(s.dir);
	}
});

test("## Files: a diff with paths outside the globs fails the round without a judge call, naming the paths; an approved files item lets it through", async () => {
	const s = setup();
	try {
		const prompts: string[] = [];
		s.ctx.prompt = async (p) => void prompts.push(p);
		writeFilesGuard(s.ctx.dir, ["src/**"], []);
		assert.equal(await judgeStep.run(s.job, s.ctx), "work");
		assert.equal(s.reviews.length, 0, "no judge call");
		assert.equal(s.job.round, 1, "it counts as a judge round");
		assert.equal(s.job.lastVerdict?.verdict, "FAIL");
		assert.equal(s.job.lastVerdict?.majors, 1);
		assert.match(prompts[0], /Files check failed \(round 1\)[\s\S]*- greeting\.txt[\s\S]*category: "files"/);
		const round = fs.readFileSync(path.join(s.ctx.dir, "judge", "round-1.md"), "utf8");
		assert.match(round, /- major - \[files\] `greeting\.txt` - changed outside the brief's Files/);
		// the lead approves the path: the judge runs, and gets the Files finding as the previous round's
		s.job.state = "judging";
		s.job.approvals.push({ at: "", item: "greeting.txt", category: "files", by: "lead", reason: "ok" });
		assert.equal(await judgeStep.run(s.job, s.ctx), "deliver");
		assert.equal(s.reviews.length, 1);
		assert.match(s.calls[0].previousFindings?.[0].head ?? "", /\[files\] `greeting\.txt`/);
	} finally {
		cleanup(s.dir);
	}
});

test("## Files: the snapshot paths are part of the globs; a job without a Files section is not limited", async () => {
	const s = setup();
	try {
		writeFilesGuard(s.ctx.dir, ["src/**"], ["greeting.txt"]);
		assert.equal(await judgeStep.run(s.job, s.ctx), "deliver");
		const t = setup();
		try {
			writeFilesGuard(t.ctx.dir, undefined, ["x"]);
			assert.equal(await judgeStep.run(t.job, t.ctx), "deliver");
			assert.ok(!fs.existsSync(path.join(t.ctx.dir, "files.json")));
		} finally {
			cleanup(t.dir);
		}
	} finally {
		cleanup(s.dir);
	}
});
