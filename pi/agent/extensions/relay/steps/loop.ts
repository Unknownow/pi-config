/** Steps "work" and "judge": the worker <-> judge loop (S18). */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseBrief } from "../brief.ts";
import { countTokens } from "../../shared/tokens.ts";
import { judgeVerdict, parseFindings, type Finding } from "../../shared/findings.ts";
import { collectRepoDiff } from "../repo-diff.ts";
import type { Job } from "../job.ts";
import type { Step, StepCtx } from "../types.ts";

const MAX_NUDGES = 2;

/** Step "work": parked while the worker works; goes to the judge when the worker reported done. */
export const workStep: Step = {
	name: "work",
	async run(job, ctx) {
		const w = ctx.worker;
		if (w.done !== undefined) {
			ctx.log("done", w.done.slice(0, 300));
			job.doneSummary = w.done;
			w.done = undefined;
			job.state = "judging";
			ctx.save(job);
			return "judge";
		}
		if (w.exited && !w.alive) {
			job.endReason = "the worker process exited without report_done";
			job.state = "failed";
			ctx.save(job);
			ctx.wake(`relay job ${job.id}: the worker exited without report_done. The job is failed; its set is kept.`);
			return "report";
		}
		if (w.settled && w.openAsks.length === 0) {
			if (w.nudges >= MAX_NUDGES) {
				job.endReason = "the worker stopped without calling report_done (asked twice)";
				job.state = "failed";
				ctx.save(job);
				ctx.wake(`relay job ${job.id}: the worker stopped without calling report_done. The job is failed; its set is kept.`);
				return "report";
			}
			w.nudges++;
			await ctx.prompt("You stopped without calling report_done. If the work is finished, call report_done with your summary; otherwise continue.");
		}
		return "wait";
	},
};

/** Per-repo diffs as one text, within `max` characters: past it only the file list plus the diffs that fit. */
export function fitDiffs(parts: { key: string; base: string; full: string; names: string[] }[], max: number): string {
	const total = parts.reduce((n, p) => n + p.full.length, 0);
	if (total <= max) return parts.map((p) => `### Repo ${p.key} (base ${p.base.slice(0, 10)})\n\n${p.full || "(no changes)"}`).join("\n\n");
	let left = max;
	const out: string[] = [`The diff is ${total} characters, over the limit of ${max}: the file list of every repo comes first, then as many diffs as fit. Read the rest with the read tool.`];
	for (const p of parts) out.push(`### Repo ${p.key} files\n${p.names.map((n) => `- ${n}`).join("\n")}`);
	for (const p of [...parts].sort((a, b) => a.full.length - b.full.length)) {
		if (p.full.length > left) continue;
		left -= p.full.length;
		out.push(`### Repo ${p.key} diff (base ${p.base.slice(0, 10)})\n\n${p.full}`);
	}
	return out.join("\n\n");
}

/** The judge's task: the current brief and version, the diffs, and the findings of the last round. */
export async function judgeTask(job: Job, ctx: StepCtx): Promise<string> {
	const brief = ctx.brief();
	const parsed = parseBrief(brief);
	const version = "errors" in parsed ? job.briefVersion : parsed.version;
	const parts: { key: string; base: string; full: string; names: string[] }[] = [];
	for (const r of job.repos) {
		const d = await collectRepoDiff((cwd, ...args) => ctx.run("git", args, cwd), r.worktree, r.followBase ?? r.base);
		parts.push({ key: r.key, base: r.followBase ?? r.base, full: d?.full ?? "", names: d?.rootNames ?? [] });
	}
	let prev = "";
	if (job.round > 0) {
		try {
			prev = fs.readFileSync(path.join(ctx.dir, "judge", `round-${job.round}.md`), "utf8");
		} catch {
			// no previous round on disk
		}
	}
	return [
		`Judge the result of job ${job.id} against brief version ${version}.`,
		`## Brief (version ${version})\n\n${brief}`,
		`## Diff\n\n${fitDiffs(parts, ctx.cfg.judge.maxDiffChars)}`,
		prev ? `## Findings of the previous round (check each is fixed; report new problems and unfixed ones)\n\n${prev}` : "",
		"End with a `VERDICT: PASS` or `VERDICT: FAIL` line.",
	]
		.filter(Boolean)
		.join("\n\n");
}

export interface Verdict {
	verdict: "PASS" | "FAIL";
	findings: Finding[];
	text: string;
}

/** PASS only when the judge says so and no blocker or major finding is left. */
export function verdictOf(text: string): Verdict {
	const findings = parseFindings(text);
	const hard = findings.some((f) => f.severity === "blocker" || f.severity === "major");
	return { verdict: judgeVerdict(text) === "PASS" && !hard ? "PASS" : "FAIL", findings, text };
}

const count = (f: Finding[], s: Finding["severity"]) => f.filter((x) => x.severity === s).length;

/** The treatment of a FAIL: prompt the worker with the findings, or stop at the cap. Shared with delivery's fix rounds. */
export async function failRound(job: Job, ctx: StepCtx, why: string, body: string): Promise<"work" | "report"> {
	job.round++;
	if (job.round >= ctx.cfg.caps.judge) {
		job.endReason = `judge cap reached (${job.round} failed rounds): ${why}`;
		job.state = "stopped";
		ctx.save(job);
		ctx.wake(`relay job ${job.id}: stopped at the judge cap (${job.round} rounds). ${why}. The set is kept; /wt open ${job.set} to look at it.`);
		return "report";
	}
	job.state = "working";
	ctx.save(job);
	ctx.worker.done = undefined;
	ctx.notify(`relay job ${job.id}: ${why}; round ${job.round + 1}`);
	await ctx.prompt(`${why}\n\n${body}\n\nFix every blocker and major finding, run Verify again, then call report_done.`);
	return "work";
}

/** Step "judge": reviews the diff against the current brief version. */
export const judgeStep: Step = {
	name: "judge",
	async run(job, ctx) {
		if (!ctx.isOwner()) {
			ctx.log("lost", "this lead no longer owns the job; not judging");
			return "wait";
		}
		// anything the worker left uncommitted is committed so the judged tree is the delivered tree
		for (const r of job.repos) {
			const st = await ctx.run("git", ["status", "--porcelain"], r.worktree);
			if (st.stdout.trim()) {
				await ctx.run("git", ["add", "-A"], r.worktree);
				await ctx.run("git", ["-c", "user.name=relay", "-c", "user.email=relay@localhost", "commit", "-q", "-m", "relay: wip"], r.worktree);
			}
		}
		const briefVersion = (() => {
			const p = parseBrief(ctx.brief());
			return "errors" in p ? job.briefVersion : p.version;
		})();
		job.briefVersion = briefVersion;
		// the tree the judge sees is recorded before it reviews, and checked again after
		const treeOf = async (r: Job["repos"][number]) => (await ctx.run("git", ["rev-parse", "HEAD^{tree}"], r.worktree)).stdout.trim();
		const seen = await Promise.all(job.repos.map(treeOf));
		const task = await judgeTask(job, ctx);
		const cwd = job.cwd ?? job.repos[0].worktree;
		const addUsage = (u: unknown) => void (job.used.tokens += countTokens(u as Parameters<typeof countTokens>[0], ctx.cfg.tokenWeights).cost);
		let res = await ctx.review("judge", task, cwd);
		addUsage(res.usage);
		if (!res.ok && !ctx.stopped()) {
			ctx.log("judge-error", res.error ?? "no output");
			res = await ctx.review("judge", task, cwd);
			addUsage(res.usage);
		}
		if (ctx.stopped()) return "report";
		if (!res.ok) {
			job.state = "paused";
			ctx.save(job);
			ctx.wake(`relay job ${job.id}: the judge failed twice (${res.error ?? "no output"}). The job is paused, never passed by default; relay_deliver ${job.id} runs the judge again.`);
			return "wait";
		}
		// a verdict is for the brief version it judged; an amendment since makes it stale
		const nowVersion = (() => {
			const p = parseBrief(ctx.brief());
			return "errors" in p ? briefVersion : p.version;
		})();
		if (nowVersion !== briefVersion) {
			ctx.log("stale", `verdict on brief version ${briefVersion} discarded (now ${nowVersion})`);
			return "judge";
		}
		const after = await Promise.all(job.repos.map(treeOf));
		if (after.some((t, i) => t !== seen[i])) {
			ctx.log("moved", "the branch changed while the judge ran; judging again");
			return "judge";
		}
		const v = verdictOf(res.text);
		fs.mkdirSync(path.join(ctx.dir, "judge"), { recursive: true });
		fs.writeFileSync(path.join(ctx.dir, "judge", `round-${job.round + 1}.md`), `${res.text}\n`);
		job.repos.forEach((r, i) => {
			r.judgedTree = seen[i];
			delete r.acceptedTree;
			delete r.passedViaRebase;
		});
		job.lastVerdict = { round: job.round + 1, briefVersion, verdict: v.verdict, blockers: count(v.findings, "blocker"), majors: count(v.findings, "major"), minors: count(v.findings, "minor") };
		ctx.log("verdict", `${v.verdict} round ${job.round + 1}: ${job.lastVerdict.blockers} blocker, ${job.lastVerdict.majors} major, ${job.lastVerdict.minors} minor`);
		const plan = v.findings.filter((f) => /\[plan\]/i.test(f.head));
		if (v.verdict === "PASS") {
			job.state = "delivering";
			ctx.save(job);
			ctx.wake(`relay job ${job.id}: judge PASS (round ${job.round + 1}, ${job.lastVerdict.minors} minor). Delivering.`);
			return "deliver";
		}
		if (plan.length) ctx.wake(`relay job ${job.id}: the judge reports a plan flaw: ${plan.map((f) => f.head).join("; ")}. Amend the brief (or stop the job).`);
		const body = v.findings.map((f) => `- ${f.head}\n${f.body}`).join("\n") || res.text;
		return failRound(job, ctx, `The judge returned FAIL (round ${job.round + 1})`, body);
	},
};
