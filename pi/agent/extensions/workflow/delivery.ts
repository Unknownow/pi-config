/** What happens after the judge passes, chosen for each flow when the plan is approved. Pure text and decisions, kept apart so node tests can reach them. */

export const DELIVERIES = ["commit", "push", "pr", "merge", "off"] as const;
export type Delivery = (typeof DELIVERIES)[number];
export type MergeMethod = "merge" | "rebase" | "squash";

export const DELIVERY_LABELS: Record<Delivery, string> = {
	commit: "commit only",
	push: "commit + push",
	pr: "commit + push + pull request",
	merge: "commit + push + pull request + merge",
	off: "don't commit",
};

export function isDelivery(v: unknown): v is Delivery {
	return typeof v === "string" && (DELIVERIES as readonly string[]).includes(v);
}

/** Menu order: the default first, then the rest in DELIVERIES order. */
export function deliveryChoices(def: Delivery): Delivery[] {
	return [def, ...DELIVERIES.filter((d) => d !== def)];
}

export function deliveryMenuLabel(d: Delivery, def: Delivery): string {
	return `${DELIVERY_LABELS[d]}${d === def ? " (default)" : ""}`;
}

/** The plan's title: the text after the first "## Plan:" heading, or "". */
export function planTitle(plan: string | undefined): string {
	const m = /^#+\s*Plan:?\s*(.*)$/m.exec(plan ?? "");
	return (m?.[1] ?? "").trim();
}

/** A branch for a pull request started on a protected branch: prefix + slug of the plan title (at most 40 characters), or a timestamp. */
export function branchName(prefix: string, title: string, now: Date): string {
	const p = prefix.replace(/[^A-Za-z0-9._/-]/g, "");
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
	if (slug) return `${p}${slug}`;
	const two = (n: number) => String(n).padStart(2, "0");
	return `${p}flow-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

export interface DeliveryOptions {
	mode: Exclude<Delivery, "off">;
	/** The branch the commits go on. */
	branch: string;
	/** Set when the commits go on a new branch, created from this one first. */
	from?: string;
	/** Pull request base; "" lets gh use the repo's default branch. */
	base: string;
	/** One commit per function instead of one commit. */
	split: boolean;
	mergeMethod: MergeMethod;
	deleteBranch: boolean;
	/** Knowledge-deviations block for the commit message, or "". */
	deviations: string;
}

const SPLIT =
	"Commit exactly the reviewed changes now, without editing any file first. Split them into commits by function: one commit per logical change (a feature, a fix, a refactor, config, docs), each with the tests that cover it. Follow the plan's Commits section when it has one, adjusted to the actual diff; a change with one function is one commit. Stage each commit's files by path (`git add <paths>`, never `git add -A` or `git add .`), commit, then stage the next. A file whose changes serve several functions stays whole, in the commit of its main change; don't stage parts of files. Order the commits so each one builds on the ones before it. Each message follows the repo's conventions (check `git log --oneline -10`), and its subject says what that commit does. When you are done, `git status --short` shows none of the reviewed files.";
const SINGLE =
	"Commit exactly the reviewed changes now: stage the changed and new files from the diff without editing anything first, and write a clear message that follows the repo's conventions.";
const CHAIN =
	"Use as few tool calls as you can: chain steps that depend on each other with `&&` in one bash call, so a failure stops the chain (for example each commit's `git add <paths> && git commit …`, and several commits in one call).";
const CHAIN_REMOTE =
	"Run the push and any pull request commands that follow it in one bash call where the next step doesn't depend on reading their output.";
const RULES =
	"Never force-push, use --no-verify, or use `--admin` or `--auto` when merging. If a hook, the commit, the push or a gh command fails, stop and report it instead of working around it.";

/** The instruction the commit step gets after the judge passes. */
export function deliveryInstruction(o: DeliveryOptions): string {
	const b = o.branch;
	const method: MergeMethod = (["merge", "rebase", "squash"] as const).includes(o.mergeMethod) ? o.mergeMethod : "merge";
	const parts = ["The judge passed."];
	if (o.from) parts.push(`First create branch \`${b}\` with \`git switch -c ${b}\` (the working-tree changes come along). Commit there and leave \`${o.from}\` as it is.`);
	parts.push(o.split ? SPLIT : SINGLE);
	if (o.mode !== "commit") {
		parts.push(
			o.from
				? `Then push it with \`git push -u origin ${b}\`.`
				: `Then push branch \`${b}\` (\`git push\`, or \`git push -u origin ${b}\` if it has no upstream).`,
		);
	}
	if (o.mode === "pr" || o.mode === "merge") {
		parts.push(
			`Then the pull request: run \`gh pr view ${b} --json number,state,url\`. If it shows an OPEN pull request, the push already updated it: don't open another. Otherwise (none, or only a MERGED or CLOSED one) open one with \`gh pr create --head ${b}${o.base ? ` --base ${o.base}` : ""} --title "<title>" --body "<body>"\`: the title says what the change does, the body gives the plan's goal and lists the commit subjects. Report the pull request's URL.`,
		);
	}
	if (o.mode === "merge") {
		parts.push(
			`Then merge it: wait for its checks with \`gh pr checks <number> --watch --fail-fast\` (a pull request without checks is fine). If a check fails, stop and report it; don't merge. Then run \`gh pr merge <number> --${method}${o.deleteBranch ? " --delete-branch" : ""}\`. If GitHub refuses the merge (a required review, a conflict, a branch rule), stop and report why; don't approve it yourself.`,
		);
	}
	parts.push(CHAIN);
	if (o.mode !== "commit") parts.push(CHAIN_REMOTE);
	parts.push(RULES);
	let text = parts.join("\n\n");
	if (o.deviations) {
		const where = o.split ? "End the message body of the commit that holds the code these deviations are about (the last commit if unclear) with this block, unchanged:" : "End the commit message body with this block, unchanged:";
		text += `\n\n${where}\n\n${o.deviations}`;
	}
	return text;
}

export interface PrState {
	number: number;
	state: string;
}

/** `pr`, unless it is the PR that already existed, closed or merged, before the commit step ran: then it says nothing about this flow. */
export function freshPr(pr: PrState | null, prBefore: number | undefined): PrState | null {
	return pr && prBefore !== undefined && pr.number === prBefore ? null : pr;
}

/** The flow summary's outcome after the commit step, and whether it did what the delivery asked. `commits` undefined: not counted. */
export function deliveryOutcome(mode: Exclude<Delivery, "off">, commits: number | undefined, pushed: boolean, pr: PrState | null, prUnknown = false): { text: string; ok: boolean } {
	const n = commits === undefined ? "" : ` (${commits} commit${commits === 1 ? "" : "s"})`;
	if (mode === "commit") return { text: `committed${n}`, ok: true };
	if ((mode === "pr" || mode === "merge") && pr?.state === "MERGED") return { text: `committed${n}, PR #${pr.number} merged`, ok: true };
	const text = `committed${n}, ${pushed ? "pushed" : "not pushed"}`;
	if (mode === "push") return { text, ok: pushed };
	if (pr?.state === "OPEN") return { text: `${text}, PR #${pr.number} open${mode === "merge" ? ", not merged" : ""}`, ok: pushed && mode === "pr" };
	if (prUnknown && !pr) return { text: `${text}, pull request state unknown (gh not found)`, ok: false };
	return { text: `${text}, no open pull request`, ok: false };
}

/** One instruction for a change that spans several repositories: each repo's own delivery steps, run in that repo. */
export function repoDeliveryInstruction(parts: { root: string; options: DeliveryOptions }[]): string {
	const head = `The judge passed. The change spans ${parts.length} repositories; deliver each one below, one after the other.`;
	const sections = parts.map((p) => {
		const body = deliveryInstruction(p.options).replace(/^The judge passed\.\s*/, "");
		const dir = /\s/.test(p.root) ? `"${p.root}"` : p.root;
		return `### Repository \`${p.root}\`\n\nRun this repository's git commands as \`git -C ${dir} …\` and its gh commands as \`cd ${dir} && gh …\`.\n\n${body}`;
	});
	return [head, ...sections].join("\n\n");
}

/** The flow's outcome over several repositories; a null outcome is a repository with no commit. */
export function combineOutcomes(parts: { name: string; outcome: { text: string; ok: boolean } | null }[]): { text: string; ok: boolean } {
	if (parts.every((p) => p.outcome === null)) return { text: "commit step ended without a commit", ok: false };
	return {
		text: parts.map((p) => `${p.name}: ${p.outcome ? p.outcome.text : "no commit"}`).join("; "),
		ok: parts.every((p) => p.outcome?.ok === true),
	};
}
