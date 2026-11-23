/** A worker may rebase its branch itself: onto a newer origin/<target>, or --onto the target after its stacked predecessor merged.
 * syncBase moves repo.base (and the stack) to where the branch now sits, so the judge diff, the Files check,
 * the overlap check and the restack do not count or replay upstream commits as the job's own. */
import { type RepoState, stackState } from "../job.ts";
import type { StepCtx } from "../types.ts";

const first = (s: string) => s.split(/\r?\n/)[0]?.trim() ?? "";

export async function syncBase(repo: RepoState, ctx: StepCtx): Promise<void> {
	// a follow-up diffs against its own start, which the worker's rebases do not move
	if (repo.followBase) return;
	const git = (...args: string[]) => ctx.run("git", args, repo.worktree);
	const isAncestor = async (a: string, b: string) => (await git("merge-base", "--is-ancestor", a, b)).code === 0;
	const stack = stackState(repo, repo.stackedOn ? ctx.job(repo.stackedOn.job) : undefined);
	if (stack === "merged" && !(await isAncestor(repo.stackedOn!.head, "HEAD"))) {
		// the branch no longer carries the predecessor's commits: it was rebased --onto the target already
		const mb = first((await git("merge-base", "HEAD", `origin/${repo.target}`)).stdout);
		if (!mb) return;
		repo.base = mb;
		delete repo.stackedOn;
		repo.retarget = true;
		return;
	}
	const tgt = stack === "open" ? repo.stackedOn!.branch : repo.target;
	const mb = first((await git("merge-base", "HEAD", `origin/${tgt}`)).stdout);
	if (!mb || mb === repo.base || !(await isAncestor(repo.base, mb))) return;
	repo.base = mb;
	if (stack === "open") repo.stackedOn!.head = mb;
}
