/** Whether a repo's judged, already-committed work is still to be published, and the refusal for commits no judge saw. Pure, so publish.test.ts covers it. */

import * as path from "node:path";
import { type Delivery, type DeliveryOptions, type PrState, pushSkipReason } from "./delivery.ts";

export interface PublishFacts {
	repo: string;
	/** The current branch; empty or "HEAD" when detached. */
	branch: string;
	head: string;
	/** What the workflow's commit step produced in this flow for this repo. */
	judged?: { base: string; head: string; branch: string };
	/** `<sha7> <subject>` of the commits after the judged head that are on no remote. */
	foreign: string[];
	hasUpstream: boolean;
	/** Commits ahead of the upstream; 0 without one. */
	ahead: number;
	/** HEAD contains the judged head. */
	descends: boolean;
	/** The judged head is contained in a remote branch. */
	judgedOnRemote: boolean;
	/** The judged branch still exists locally. */
	judgedBranchExists: boolean;
	pr: PrState | null;
	protectedBranch: boolean;
}

export type PublishDecision =
	| { kind: "publish"; base: string; branch: string }
	| { kind: "nothing"; reason: string }
	| { kind: "refuse"; judgedHead: string; commits: string[] }
	| { kind: "moved"; judgedBranch: string; judgedHead: string }
	| { kind: "not-judged" };

export function publishDecision(f: PublishFacts, mode: "push" | "pr" | "merge"): PublishDecision {
	if (!f.judged) return { kind: "not-judged" };
	if (f.foreign.length) return { kind: "refuse", judgedHead: f.judged.head, commits: f.foreign };
	// The branch was merged and deleted, or HEAD moved on: work already on a remote needs no publishing.
	if ((!f.descends || f.branch !== f.judged.branch) && f.judgedOnRemote && !f.judgedBranchExists) return { kind: "nothing", reason: "already published" };
	if (!f.descends || f.branch !== f.judged.branch) return { kind: "moved", judgedBranch: f.judged.branch, judgedHead: f.judged.head };
	if (!f.branch || f.branch === "HEAD" || f.protectedBranch) return { kind: "nothing", reason: pushSkipReason(f.branch) };
	const wantsPr = mode === "pr" || mode === "merge";
	const open = f.pr?.state === "OPEN";
	if (!f.hasUpstream || f.ahead > 0) return { kind: "publish", base: f.judged.base, branch: f.branch };
	if (wantsPr && (!f.pr || f.pr.state === "CLOSED")) return { kind: "publish", base: f.judged.base, branch: f.branch };
	if (mode === "merge" && open) return { kind: "publish", base: f.judged.base, branch: f.branch };
	return { kind: "nothing", reason: f.pr?.state === "MERGED" ? "pull request already merged" : "already published" };
}

/** The refusal for commits after the judged head that no judge saw, with the recovery. */
export function refuseText(root: string, d: { judgedHead: string; commits: string[] }): string {
	const lines = d.commits.map((c) => `  ${c}`).join("\n");
	return `${path.basename(root)}: these commits were not made by the workflow's commit step and are on no remote, so they are not published:\n${lines}\nIf you made them yourself, run \`git -C ${root} reset --soft ${d.judgedHead}\` and call deliver again: the judge reviews the changes and the commit step commits them. Run the reset only on commits you made yourself.`;
}

/** The refusal for a repo whose HEAD is no longer the judged branch's work. */
export function movedText(root: string, d: { judgedBranch: string; judgedHead: string }): string {
	return path.basename(root) + ": HEAD is not on the judged work (branch " + d.judgedBranch + ", head " + d.judgedHead.slice(0, 7) + "). Run `git -C " + root + " switch " + d.judgedBranch + "` and call deliver again.";
}

/** A judged repo whose commits are published beside (or instead of) a commit step's own repos. */
export interface PublishEntry {
	root: string;
	mode: Exclude<Delivery, "off">;
	head: string;
	branch: string;
	prBefore?: number;
	options: DeliveryOptions;
}

type PendingRepo = { root: string; mode: Exclude<Delivery, "off">; head: string; branch?: string; prBefore?: number; pushSkipped?: string };

/** The commit step's repos with the published ones added after them: instruction parts and pending records, in the same order. */
export function mergePublish(parts: { root: string; options: DeliveryOptions }[], repos: PendingRepo[], extras: PublishEntry[]): { parts: { root: string; options: DeliveryOptions }[]; repos: PendingRepo[] } {
	return {
		parts: [...parts, ...extras.map((e) => ({ root: e.root, options: e.options }))],
		repos: [...repos, ...extras.map((e) => ({ root: e.root, mode: e.mode, head: e.head, branch: e.branch, prBefore: e.prBefore }))],
	};
}
