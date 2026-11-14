/** Step "deliver" (D14): rebase, accept, push, open the pull request, merge within Authority, publish. */

import { type AuthorityItem, parseBrief } from "../brief.ts";
import { repoPolicy } from "../config.ts";
import { dropSnapshotBranch } from "../snapshot.ts";
import type { Job, RepoState } from "../job.ts";
import { gateCheck } from "../merge-gate.ts";
import { originRepo } from "../merge-gate.ts";
import { type PushContext, pushProblem } from "../push-guard.ts";
import { failRound } from "./loop.ts";
import type { Step, StepCtx } from "../types.ts";

const firstLine = (s: string) => s.trim().split(/\r?\n/)[0] ?? "";

/** The Verify lines that are commands: bullets and fenced lines; `<repo key>: <cmd>` runs in that repo, any other line in the first repo. */
export function verifyCommands(section: string, repoKeys: string[]): { repo?: string; cmd: string }[] {
	const out: { repo?: string; cmd: string }[] = [];
	for (const raw of section.split(/\r?\n/)) {
		let line = raw.replace(/^\s*[-*]\s+/, "").trim();
		if (!line || line.startsWith("```")) continue;
		line = line.replace(/^`+|`+$/g, "").trim();
		const m = /^(.+?):\s+(.+)$/.exec(line);
		const key = m && repoKeys.find((k) => k.toLowerCase() === m[1].trim().toLowerCase());
		out.push(key && m ? { repo: key, cmd: m[2] } : { cmd: line });
	}
	return out;
}

/** Whether delivery merges: Authority `merge` yes (or an approval), or the repo's policy is after-pass and Authority is not `no`. */
export function mergeAllowed(authority: AuthorityItem | undefined, hasApproval: boolean, policyMerge: "after-pass" | "pr-only"): boolean {
	if (authority?.value === "yes" || hasApproval) return true;
	return policyMerge === "after-pass" && authority?.value !== "no";
}

type Outcome = { kind: "done" } | { kind: "stopped" } | { kind: "fix"; reason: string } | { kind: "error"; error: string } | { kind: "retry" };

async function accept(job: Job, repo: RepoState, ctx: StepCtx, verify: string): Promise<{ ok: true } | { ok: false; fix?: string; error?: string }> {
	const git = (...args: string[]) => ctx.run("git", args, repo.worktree);
	const fetch = await git("fetch", "origin");
	if (fetch.code !== 0) return { ok: false, error: `git fetch failed in ${repo.key}: ${firstLine(fetch.stderr)}` };
	const upstream = firstLine((await git("rev-parse", `origin/${repo.target}`)).stdout);
	if (!upstream) return { ok: false, error: `origin/${repo.target} not found in ${repo.key}` };
	const headTree = firstLine((await git("rev-parse", "HEAD^{tree}")).stdout);
	if (upstream === repo.base) {
		// nothing new upstream: the judged tree is the tree to deliver, and only that
		// (a retry after delivery stopped past a rebase: HEAD is the tree relay accepted then)
		if (repo.passedViaRebase && headTree === repo.acceptedTree && headTree !== repo.judgedTree) return { ok: true };
		if (headTree !== repo.judgedTree) return { ok: false, fix: `The branch of ${repo.key} changed after the judge reviewed it. Report_done again so the current tree is judged.` };
		repo.acceptedTree = headTree;
		delete repo.passedViaRebase;
		return { ok: true };
	}
	const jobFiles = (await git("diff", "--name-only", `${repo.base}..HEAD`)).stdout.split(/\r?\n/).filter(Boolean);
	const upFiles = new Set((await git("diff", "--name-only", `${repo.base}..${upstream}`)).stdout.split(/\r?\n/).filter(Boolean));
	const rebase = await ctx.run("git", ["-c", "user.name=relay", "-c", "user.email=relay@localhost", "rebase", `origin/${repo.target}`], repo.worktree);
	if (rebase.code !== 0) {
		const conflicts = (await git("diff", "--name-only", "--diff-filter=U")).stdout.split(/\r?\n/).filter(Boolean);
		await git("rebase", "--abort");
		return { ok: false, fix: `Rebasing ${repo.key} onto origin/${repo.target} conflicts in ${conflicts.join(", ") || "some files"}. Rebase your branch onto origin/${repo.target}, resolve the conflicts, and report_done again.` };
	}
	repo.base = upstream;
	const overlap = jobFiles.filter((f) => upFiles.has(f));
	if (overlap.length) return { ok: false, fix: `origin/${repo.target} changed files you also changed (${overlap.join(", ")}). The rebase went through, but check that your change still fits what is upstream now, run Verify, and report_done again.` };
	const newTree = firstLine((await git("rev-parse", "HEAD^{tree}")).stdout);
	if (newTree !== repo.judgedTree) {
		const cmds = verifyCommands(verify, job.repos.map((r) => r.key)).filter((c) => (c.repo ?? job.repos[0].key) === repo.key);
		for (const c of cmds) {
			const r = await ctx.shell(c.cmd, repo.worktree);
			if (r.code !== 0) return { ok: false, fix: `After rebasing onto origin/${repo.target}, Verify failed in ${repo.key}: \`${c.cmd}\` exited ${r.code}.\n\n${r.out.slice(-3000)}` };
		}
		repo.passedViaRebase = { from: repo.judgedTree ?? "" };
	}
	repo.acceptedTree = newTree;
	return { ok: true };
}

/** The push rule: the first push creates the branch; later pushes are force-with-lease against what relay itself pushed. */
export async function pushJobBranch(ctx: StepCtx, repo: RepoState, protectedBranches: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
	const rb = repo.remoteBranch ?? repo.branch;
	if (protectedBranches.includes(rb) || rb === repo.target) return { ok: false, error: `${rb} is a protected branch or the target; relay pushes only its own job branch` };
	const first = !repo.remotePushed;
	if (first) {
		const exists = await ctx.run("git", ["ls-remote", "--exit-code", "--heads", "origin", rb], repo.worktree);
		if (exists.code === 0) return { ok: false, error: `${rb} already exists on origin; relay does not overwrite a branch it did not push (delete it, or change the job)` };
	}
	const args = first ? ["push", "origin", `HEAD:${rb}`] : ["push", `--force-with-lease=${rb}:${repo.remotePushed}`, "origin", `HEAD:${rb}`];
	const ctxPush: PushContext = { branch: repo.branch, protectedBranches, gates: [], ...(first ? {} : { lease: { remoteBranch: rb, remotePushed: repo.remotePushed!, target: repo.target } }) };
	const problem = pushProblem(`git ${args.join(" ")}`, ctxPush);
	if (problem) return { ok: false, error: `push refused: ${problem}` };
	const r = await ctx.run("git", args, repo.worktree);
	if (r.code !== 0) {
		const stale = !first && /stale info/i.test(r.stderr);
		return { ok: false, error: stale ? `the lease failed: ${rb} on origin was changed by someone else since relay's last push (${repo.remotePushed?.slice(0, 10)}); relay does not overwrite it` : `git push failed: ${firstLine(r.stderr)}` };
	}
	repo.remoteBranch = rb;
	repo.remotePushed = firstLine((await ctx.run("git", ["rev-parse", "HEAD"], repo.worktree)).stdout);
	return { ok: true };
}

async function github(ctx: StepCtx, repo: RepoState): Promise<string | undefined> {
	const slug = await originRepo((c, a, d) => ctx.run(c, a, d), repo.worktree);
	if (!slug) return undefined;
	const v = await ctx.run("gh", ["repo", "view", "-R", slug, "--json", "name"], repo.worktree);
	return v.code === 0 ? slug : undefined;
}

async function ensurePr(ctx: StepCtx, job: Job, repo: RepoState, slug: string, goal: string): Promise<string | undefined> {
	const rb = repo.remoteBranch ?? repo.branch;
	const view = await ctx.run("gh", ["pr", "view", rb, "-R", slug, "--json", "url,state"], repo.worktree);
	if (view.code === 0) {
		try {
			const j = JSON.parse(view.stdout);
			if (j.state === "OPEN") return String(j.url);
		} catch {
			// create a new one below
		}
	}
	const create = await ctx.run("gh", ["pr", "create", "-R", slug, "--base", repo.target, "--head", rb, "--title", job.title, "--body", `${goal}\n\nrelay job ${job.id}`], repo.worktree);
	if (create.code !== 0) return undefined;
	return create.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
}

async function deliverOnce(job: Job, ctx: StepCtx, attempt: number): Promise<Outcome> {
	const parsed = parseBrief(ctx.brief());
	if ("errors" in parsed) return { kind: "error", error: `brief unreadable: ${parsed.errors.join("; ")}` };
	const verify = parsed.sections.Verify ?? "";
	// 1-3: every repo is accepted before anything is pushed
	for (const repo of job.repos) {
		if (repo.merged) continue; // merged earlier in this delivery (a retry): its state is final
		const a = await accept(job, repo, ctx, verify);
		ctx.save(job);
		if (!a.ok) return a.fix ? { kind: "fix", reason: a.fix } : { kind: "error", error: a.error ?? "delivery failed" };
	}
	if (ctx.stopped()) return { kind: "stopped" };
	// push each repo, then PRs
	const slugs = new Map<string, string | undefined>();
	for (const repo of job.repos) {
		if (repo.merged) continue;
		if (ctx.stopped()) return { kind: "stopped" };
		const pol = repoPolicy(ctx.cfg, repo.main);
		const p = await pushJobBranch(ctx, repo, pol.protectedBranches);
		ctx.save(job);
		if (!p.ok) return { kind: "error", error: p.error };
		const slug = await github(ctx, repo);
		slugs.set(repo.key, slug);
		if (slug) {
			const pr = await ensurePr(ctx, job, repo, slug, parsed.sections.Goal ?? job.title);
			if (pr) repo.pr = pr;
			else ctx.notify(`relay job ${job.id}: pushed ${repo.remoteBranch} but could not open a pull request in ${repo.key}`);
			ctx.save(job);
		}
	}
	// merge, in Targets order, only when every repo is accepted and pushed (they are)
	const mergeApproved = job.approvals.some((a) => a.category === "merge");
	for (const repo of job.repos) {
		if (ctx.stopped()) return { kind: "stopped" };
		const pol = repoPolicy(ctx.cfg, repo.main);
		if (repo.merged || !mergeAllowed(parsed.authority.merge, mergeApproved, pol.merge)) continue;
		const slug = slugs.get(repo.key);
		const tree = repo.acceptedTree ?? "";
		if (slug && repo.pr) {
			const gate = await gateCheck((c, a, d) => ctx.run(c, a, d), "merge", repo.worktree, repo.pr, { passedTrees: [tree], noMerge: false, repo: slug });
			if (gate.problem) return { kind: "error", error: `merge refused in ${repo.key}: ${gate.problem}` };
			const sha = firstLine((await ctx.run("git", ["rev-parse", "HEAD"], repo.worktree)).stdout);
			const m = await ctx.run("gh", ["pr", "merge", repo.pr, "-R", slug, "--squash", "--match-head-commit", sha], repo.worktree);
			if (m.code !== 0) return { kind: "error", error: `gh pr merge failed in ${repo.key}: ${firstLine(m.stderr)}` };
			repo.merged = true;
		} else {
			// no GitHub: a fast-forward push to the target
			await ctx.run("git", ["fetch", "origin"], repo.worktree);
			const sha = firstLine((await ctx.run("git", ["rev-parse", "HEAD"], repo.worktree)).stdout);
			const ff = await ctx.run("git", ["merge-base", "--is-ancestor", `origin/${repo.target}`, sha], repo.worktree);
			if (ff.code !== 0) {
				if (attempt >= 3) return { kind: "error", error: `origin/${repo.target} keeps moving in ${repo.key}; gave up after ${attempt} rebases` };
				return { kind: "retry" };
			}
			const gate = await gateCheck((c, a, d) => ctx.run(c, a, d), "protected-push", repo.worktree, sha, { passedTrees: [tree], noMerge: false });
			if (gate.problem) return { kind: "error", error: `merge refused in ${repo.key}: ${gate.problem}` };
			const push = await ctx.run("git", ["push", "origin", `${sha}:${repo.target}`], repo.worktree);
			if (push.code !== 0) return { kind: "error", error: `push to ${repo.target} failed in ${repo.key}: ${firstLine(push.stderr)}` };
			repo.merged = true;
		}
		ctx.save(job);
		ctx.log("merged", `${repo.key} -> ${repo.target}`);
	}
	// publish, only with `publish: yes`, only after every merge
	if (parsed.publish?.length && parsed.authority.publish?.value === "yes" && job.repos.every((r) => r.merged || !mergeAllowed(parsed.authority.merge, mergeApproved, repoPolicy(ctx.cfg, r.main).merge))) {
		for (const cmd of parsed.publish) {
			const r = await ctx.shell(cmd, job.repos[0].worktree);
			ctx.log("publish", `${cmd} -> ${r.code}`);
			if (r.code !== 0) return { kind: "error", error: `publish command failed (${r.code}): ${cmd}\n${r.out.slice(-1000)}` };
		}
	}
	for (const r of job.repos) if (r.leadEdits) await dropSnapshotBranch(ctx.run, r.main, job.id);
	return { kind: "done" };
}

export const deliverStep: Step = {
	name: "deliver",
	async run(job, ctx) {
		if (!ctx.isOwner()) {
			ctx.log("lost", "this lead no longer owns the job; not delivering");
			return "wait";
		}
		let out: Outcome = { kind: "retry" };
		for (let attempt = 1; out.kind === "retry"; attempt++) out = await deliverOnce(job, ctx, attempt);
		if (out.kind === "done") return "report";
		if (out.kind === "stopped") return "report";
		if (out.kind === "fix") {
			const next = await failRound(job, ctx, "Delivery needs a fix", out.reason);
			return next;
		}
		job.notes.push(`delivery stopped: ${out.error}`);
		ctx.save(job);
		ctx.log("delivery-stopped", out.error);
		ctx.wake(`relay job ${job.id}: delivery stopped: ${out.error}\nFix the cause, then relay_deliver ${job.id} retries.`);
		return "wait";
	},
};
