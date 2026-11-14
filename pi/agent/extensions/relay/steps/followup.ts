/**
 * Step "followup" (S29): gives a finished job a workspace for a follow-up and starts a new worker session.
 * The lead's tool (engine.followup) has already taken the lock, appended the amendment and had the critic check it.
 *
 * Workspace, by what is left of the job:
 * - not merged, set still there: the set and its branch are reused (remoteBranch and remotePushed stay, so the push updates the same PR)
 * - not merged, set gone: a new set `<id>-f<N>` from origin/<remoteBranch> (or the local job branch); remoteBranch and remotePushed stay
 * - merged: a new set `<id>-f<N>` from origin/<target>, a new branch and no remoteBranch: delivery opens a new PR; the old set gets W2 without force
 */

import * as fs from "node:fs";
import { gitOut } from "../sh.ts";
import type { Job } from "../job.ts";
import type { Step, StepCtx } from "../types.ts";
import { workerPrompt } from "./dispatch.ts";

const fwd = (p: string) => p.split("\\").join("/").replace(/\/+$/, "");
const same = (a: string, b: string) => fwd(a).toLowerCase() === fwd(b).toLowerCase();

async function refExists(ctx: StepCtx, dir: string, ref: string): Promise<boolean> {
	return (await ctx.run("git", ["rev-parse", "--verify", "--quiet", ref], dir)).code === 0;
}

export const followupStep: Step = {
	name: "followup",
	async run(job: Job, ctx: StepCtx) {
		const pending = job.followupPending;
		const fail = (why: string) => {
			job.endReason = `follow-up ${pending?.n ?? "?"}: ${why}`;
			job.state = "failed";
			delete job.followupPending;
			ctx.save(job);
			ctx.wake(`relay job ${job.id}: the follow-up could not start: ${why}. The job is failed again; nothing was changed in its repos.`);
			return "report" as const;
		};
		if (!pending) return fail("no follow-up is pending");
		const { n, text } = pending;
		const allMerged = job.repos.length > 0 && job.repos.every((r) => r.merged);
		const setPresent = job.repos.length > 0 && job.repos.every((r) => fs.existsSync(r.worktree));
		const oldSet = job.set;

		if (allMerged || !setPresent) {
			const name = `${job.id}-f${n}`;
			const bases: Record<string, string> = {};
			for (const r of job.repos) {
				await ctx.run("git", ["fetch", "origin"], r.main);
				if (allMerged) bases[r.main] = `origin/${r.target}`;
				else if (r.remoteBranch && (await refExists(ctx, r.main, `origin/${r.remoteBranch}`))) bases[r.main] = `origin/${r.remoteBranch}`;
				else if (await refExists(ctx, r.main, r.branch)) bases[r.main] = r.branch;
				else return fail(`the set of ${r.key} is gone and its branch ${r.remoteBranch ?? r.branch} exists nowhere to continue from`);
			}
			const lead = ctx.folders().map(fwd);
			const folders = lead.filter((f) => job.repos.some((r) => same(r.main, f)));
			const reply = await ctx.wt.create({ name, bases, ...(folders.length ? { folders } : {}) });
			if ("error" in reply) return fail(`could not create the set ${name}: ${reply.error}`);
			for (const r of job.repos) {
				const entry = reply.repos.find((x) => same(x.top, r.main));
				if (!entry) return fail(`the new set has no worktree for ${r.key}`);
				r.worktree = fwd(entry.cwd);
				r.branch = reply.branch;
				delete r.leadEdits;
				if (allMerged) {
					r.base = await gitOut(ctx.run, r.main, ["rev-parse", `origin/${r.target}`]).catch(() => r.base);
					delete r.remoteBranch;
					delete r.remotePushed;
					delete r.pr;
					r.mergedBefore = true;
					delete r.merged;
				}
			}
			job.cwd = reply.cwd;
			job.set = name;
			if (allMerged && setPresent) {
				const rm = await ctx.wt.remove({ name: oldSet });
				const msg = "error" in rm ? `old set ${oldSet} kept: ${rm.error}` : rm.kept.length ? `old set ${oldSet} removed, branches kept: ${rm.kept.join(", ")}` : "";
				if (msg) {
					job.notes.push(msg);
					ctx.notify(`relay job ${job.id}: ${msg}`);
				}
			}
		}

		// the judge reviews only what this follow-up adds
		for (const r of job.repos) {
			r.followBase = await gitOut(ctx.run, r.worktree, ["rev-parse", "HEAD"]).catch(() => r.base);
			delete r.judgedTree;
			delete r.acceptedTree;
			delete r.passedViaRebase;
		}
		job.followups = n;
		job.round = 0;
		job.escalated = 0;
		job.restarts = 0;
		delete job.lastVerdict;
		delete job.endReason;
		delete job.followupPending;
		delete job.paused;
		job.state = "working";
		ctx.save(job);
		await ctx.startWorker(job, { prompt: workerPrompt(ctx, job, `Follow-up ${n} on a finished job: ${text}\n\nThe earlier work is in this worktree already. Do only what the follow-up asks (it is the last amendment); the judge reviews only your new commits.`) });
		ctx.log("followup", `follow-up ${n} started in set ${job.set}`);
		ctx.notify(`relay job ${job.id}: follow-up ${n} started`);
		return "work";
	},
};
