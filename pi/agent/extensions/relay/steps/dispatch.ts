/** Step "dispatch": moves the lead's edits into a new set and starts the worker (S16 steps 4-9). */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseBrief } from "../brief.ts";
import { JOB_START, jobStartPayload } from "../events.ts";
import { repoPolicy } from "../config.ts";
import { gitOut } from "../sh.ts";
import { applySnapshot, dropSnapshotBranch, revertSnapshotted, snapshotEdits } from "../snapshot.ts";
import type { Job, RepoState } from "../job.ts";
import type { Step, StepCtx } from "../types.ts";

const fwd = (p: string) => p.split("\\").join("/").replace(/\/+$/, "");
const same = (a: string, b: string) => fwd(a).toLowerCase() === fwd(b).toLowerCase();

/** The repo top level a Targets key names: an existing folder (absolute, or relative to the lead's cwd), or the name of the lead's repo or of one of its added folders. */
export async function resolveRepo(ctx: Pick<StepCtx, "run" | "leadCwd" | "folders">, key: string): Promise<string | undefined> {
	const candidates = [path.isAbsolute(key) ? key : path.resolve(ctx.leadCwd, key), ...[ctx.leadCwd, ...ctx.folders()].filter((f) => path.basename(f).toLowerCase() === key.toLowerCase())];
	for (const c of candidates) {
		if (!fs.existsSync(c)) continue;
		const top = await ctx.run("git", ["rev-parse", "--show-toplevel"], c);
		if (top.code === 0 && top.stdout.trim()) return fwd(top.stdout.trim());
	}
	return undefined;
}

/** The first prompt of a worker session: its rules, the job, the current brief; `extra` says why the session is new (a restart, a re-plan, a follow-up). */
export function workerPrompt(ctx: Pick<StepCtx, "relayDir" | "brief">, job: Job, extra?: string): string {
	const rules = fs.readFileSync(path.join(ctx.relayDir, "prompts", "worker.md"), "utf8");
	const p = parseBrief(ctx.brief());
	const version = "errors" in p ? job.briefVersion : p.version;
	job.workerVersion = version;
	return `${rules}

# Your job (brief version ${version})

Work in ${job.cwd}. Finish with report_done.
${extra ? `
${extra}
` : ""}
${ctx.brief()}`;
}

/** The lead's added folders that are Targets (W1 `folders`), and the repos' own mains. */
export const dispatchStep: Step = {
	name: "dispatch",
	async run(job, ctx) {
		const fail = async (why: string) => {
			job.endReason = why;
			job.state = "failed";
			ctx.save(job);
			return "report" as const;
		};
		const parsed = parseBrief(ctx.brief());
		if ("errors" in parsed) return fail(`brief unreadable: ${parsed.errors.join("; ")}`);
		const tops: { key: string; main: string; target: string }[] = [];
		for (const t of parsed.targets) {
			const main = await resolveRepo(ctx, t.repo);
			if (!main) return fail(`Targets: "${t.repo}" is not a git repo (a folder, or the name of the lead's repo or an added folder)`);
			tops.push({ key: t.repo, main, target: t.branch });
		}

		// a stacked job starts each repo at the head of its predecessor's pushed branch (D17); a merged predecessor means a plain start
		const stacked = new Map<string, NonNullable<RepoState["stackedOn"]>>();
		const pred = job.dependsOn ? ctx.job(job.dependsOn) : undefined;
		if (job.dependsOn && !pred) return fail(`Depends on: job ${job.dependsOn} was not found`);
		for (const t of tops) {
			const pr = pred?.repos.find((x) => same(x.main, t.main));
			if (!pred || !pr || pr.merged || pr.mergedBefore) continue;
			// never a quiet plain start: the dependent would not sit on its predecessor's work
			if (!pr.remoteBranch || !pr.remotePushed) return fail(`Depends on: predecessor ${pred.id} has not pushed its branch for ${t.key}`);
			await ctx.run("git", ["fetch", "origin"], t.main);
			const head = await gitOut(ctx.run, t.main, ["rev-parse", `origin/${pr.remoteBranch}`]).catch(() => "");
			if (!head) return fail(`Depends on: origin/${pr.remoteBranch} of predecessor ${pred.id} was not found in ${t.key}`);
			stacked.set(t.main, { job: pred.id, branch: pr.remoteBranch, head });
		}

		// 4: snapshot the lead's edits in each Target repo
		const snaps = new Map<string, Awaited<ReturnType<typeof snapshotEdits>>>();
		for (const t of tops) snaps.set(t.main, await snapshotEdits(ctx.run, t.main, job.id));
		const dropSnaps = async () => {
			for (const t of tops) if (snaps.get(t.main)) await dropSnapshotBranch(ctx.run, t.main, job.id);
		};

		// 5: the set
		const bases: Record<string, string> = {};
		for (const t of tops) bases[t.main] = `origin/${stacked.get(t.main)?.branch ?? t.target}`;
		const lead = ctx.folders().map(fwd);
		const folders = lead.filter((f) => tops.some((t) => same(t.main, f)));
		const reply = await ctx.wt.create({ name: job.set, bases, ...(folders.length ? { folders } : {}) });
		if ("error" in reply) {
			await dropSnaps();
			return fail(`could not create the set: ${reply.error}`);
		}
		job.cwd = reply.cwd;

		// 6: base and branch per repo
		const repos: RepoState[] = [];
		for (const t of tops) {
			const entry = reply.repos.find((r) => same(r.top, t.main));
			if (!entry) {
				await dropSnaps();
				await ctx.wt.remove({ name: job.set, force: true });
				return fail(`the set has no worktree for ${t.key}`);
			}
			const st = stacked.get(t.main);
			const sha = st ? st.head : await gitOut(ctx.run, t.main, ["rev-parse", `origin/${t.target}`]).catch(() => "");
			repos.push({ key: t.key, main: t.main, worktree: fwd(entry.cwd), target: t.target, base: sha, branch: reply.branch, ...(st ? { stackedOn: st } : {}), ...(snaps.get(t.main) ? { leadEdits: snaps.get(t.main)! } : {}) });
		}
		job.repos = repos;
		ctx.save(job);

		// 7: apply the snapshots as the first job commit
		for (const r of repos) {
			if (!r.leadEdits) continue;
			const ap = await applySnapshot(ctx.run, r.worktree, r.leadEdits.sha);
			if (!ap.ok) {
				await ctx.wt.remove({ name: job.set, force: true });
				await dropSnaps();
				job.repos = [];
				return fail(`the lead's edits do not apply on origin/${r.target} (${ap.conflicts.join(", ") || ap.error}); commit or rebase them first. The edits are untouched.`);
			}
		}

		// 8: revert the lead's checkout, only now
		for (const r of repos) {
			if (!r.leadEdits) continue;
			const rev = await revertSnapshotted(ctx.run, r.main, r.leadEdits);
			if (rev.skipped.length) job.notes.push(`lead checkout ${r.key}: left as is: ${rev.skipped.map((s) => `${s.path} (${s.reason})`).join("; ")}`);
		}

		// the worker guard's facts
		const sensitive = [...new Set(repos.flatMap((r) => repoPolicy(ctx.cfg, r.main).sensitivePaths))];
		fs.writeFileSync(path.join(ctx.dir, "guard.json"), JSON.stringify({ sensitivePaths: sensitive }, null, 2));

		// 9: the worker
		job.state = "working";
		ctx.save(job);
		await ctx.startWorker(job, { prompt: workerPrompt(ctx, job) });
		ctx.emit(JOB_START, jobStartPayload(job.id, job.title, repos.map((r) => r.key)));
		ctx.log("dispatch", `set ${job.set}, ${repos.length} repo(s), worker started${stacked.size ? `, stacked on job ${job.dependsOn}` : ""}`);
		return "work";
	},
};
