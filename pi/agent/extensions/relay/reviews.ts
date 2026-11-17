/**
 * Relay's rules for the agents reviewers: the judge (`runJudge`, full mode, the brief as spec) and the critic
 * (`runCritic`, a brief or an amendment as the document). The agents prompts carry the findings format and the
 * verdict rule; these texts add what is relay's own: the brief's sections, Authority, the `[plan]` policy and the
 * critic's `[locked]` / `[authority]` tags. Passed as `criteria`.
 */

import { parseBrief } from "./brief.ts";

/** The judge's relay rules. */
export const JUDGE_CRITERIA = `You judge the result of a relay job: a headless worker finished, and you decide whether it may be delivered. The spec is the job's brief, CURRENT version, amendments included (approvals are amendments too); judge against that version only. Your working folder is the job's worktree.
1. Done when: every bullet is met by the diff, with evidence you can point at (\`path:line\`).
2. Non-goals and Constraints are respected; Decisions (locked) are followed.
3. Efficiency at the brief's Scale; a path for the extensions the brief names.
4. Authority: any change the brief's Authority (and the approvals listed in it as amendments) does not cover is a blocker: a manifest or lockfile change without \`deps\`, a workflow/CI/schema/secret path without \`formats\`, a delete without \`delete\`, anything outward (comments, publish, merge, push to a protected branch) without its category.
5. [plan] policy: a problem with the brief itself (not the code) is tagged [plan] and cites \`brief\`; relay wakes the lead to amend the brief. Never fail the code for what only the brief got wrong.`;

/** The critic's relay rules for a brief (relay_critic). */
export const BRIEF_CRITERIA = `The document is a relay brief: the whole job for a headless worker that cannot ask anything the brief should have decided. Your working folder is the lead's checkout.
- Completeness: Goal, Done-when bullets that can be checked, Non-goals, Constraints, Decisions (locked), Design, Scale (numbers), Verify (runnable commands), Targets, Authority (all six categories: merge, publish, comments, delete, formats, deps).
- Efficiency at the stated Scale: will the Design hold at those numbers? Name the cost (loops, I/O, memory) when it will not.
- A path for the extensions the Goal names (new modes, kinds, providers).
- Fit with the repo's patterns (cite the file); no duplication of code the repo already has; neither under- nor over-engineered.
- Authority: a sensitive action the brief implies (merge or push to a protected branch, publish, issue or PR comments, deletions, formats/schemas/migrations/CI/secrets, dependencies) that Authority does not cover: tag the finding [authority].
- Decisions (locked) must hold up against the code: a finding about a locked decision is tagged [locked]; a locked decision may be overridden only for a blocker or major problem.
Categories: completeness, scale, extensibility, pattern, duplication, scope, verify, plus the tags [locked] and [authority] (after the category, e.g. "[scope][locked]"). A finding about the brief itself may cite \`brief\` instead of a path.`;

/** The critic's rules for an amendment of a running job (a restart, a follow-up): only the amendment is reviewed. */
export const AMENDMENT_CRITERIA = `${BRIEF_CRITERIA}
Review only the amendment (the document's "Amendment" section) against the brief it amends and the code; do not re-review the rest of the brief.`;

/** The `about` line of every relay critic run. */
export const CRITIC_ABOUT = "relay brief";

/** The judge's criteria for a brief: the rules, then the brief's own Done when, Non-goals, Decisions and Authority, verbatim. */
export function judgeCriteria(brief: string): string {
	const p = parseBrief(brief);
	if ("errors" in p) return JUDGE_CRITERIA;
	const parts = ["Done when", "Non-goals", "Decisions (locked)", "Authority"].flatMap((h) => (p.sections[h]?.trim() ? [`### ${h}\n${p.sections[h].trim()}`] : []));
	return parts.length ? `${JUDGE_CRITERIA}\n\nThe brief's own lines for these checks:\n\n${parts.join("\n\n")}` : JUDGE_CRITERIA;
}
