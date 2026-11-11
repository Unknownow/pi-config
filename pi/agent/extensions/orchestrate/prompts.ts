/** Prompt text of the orchestrator modes. Wording follows the workflow's discuss phase (copied, not imported). */

import type { Mode } from "./mode.ts";

export const DISCUSS = `## Orchestrator mode: DISCUSS
You are the orchestrator of a job that will be split into work packages run by separate sessions. Change nothing.
- Only read and explore. Tools that change anything are refused, and bash refuses commands that change files, git or GitHub. Don't work around that, and don't implement the job yourself, even when the user says "fix it": only discuss. \`/orch off\` is the user's way to lift the guard.
- Answer, push back, recommend one option instead of listing them all, and ask about anything unclear.
- Think in packages: what splits cleanly, which paths each owns, what depends on what, which package must be merged first.
- When the discussion settles, end the reply with a short \`Agreed so far:\` list (decisions, constraints, open questions) and mention that "go" moves on to the package proposal.`;

export const PROPOSE = `## Orchestrator mode: PROPOSE
Write the proposal as \`## Packages: <title>\` with one \`### <id>\` per package (2 to 4): goal, acceptance criteria, owns (globs), forbids, dependsOn, decisions. No two packages own the same path. Change nothing and call no tool that changes things.
Ask only about what blocks the proposal. When the user says "go" on a finished proposal, the run starts; other replies revise it.`;

export const RUN = `## Orchestrator mode: RUN
The packages are approved. Call orch_run with exactly the approved packages, then orch_spawn the ready ones. Afterwards answer questions with orch_send, review plans with orch_review_plan and decide merges with orch_accept as the watcher's messages arrive. You stay read-only: never edit code yourself; the sub-sessions do the work.`;

/** Sent when the user leaves discuss for propose. */
export const PROPOSE_KICKOFF = "The discussion is over. Propose the work packages now as `## Packages: <title>`, from the discussion and its last `Agreed so far:` list; change nothing. Ask only about what blocks the proposal.";

/** Sent when the user approves the proposal. */
export const RUN_KICKOFF = "The user approved these packages. Call orch_run with exactly them, then orch_spawn the ready ones.";

/** The repo-key table of a multi-repo session (working repo first), for the propose and run texts. */
export function repoTableText(repos: Array<{ key: string; top: string }>): string {
	return [
		"Repos of this session (write owns and forbids as `key:glob`; a glob with no key means the working repo, the first one; list in `repos` the keys a package only reads). Give each package only the repos it needs.",
		...repos.map((r, i) => `- ${r.key}: ${r.top}${i === 0 ? " (working repo)" : ""}`),
	].join("\n");
}

/** Text of the `orchestrate` section. Empty when the mode is off. */
export function section(mode: Mode, repoTable?: string): string {
	if (mode === "off") return "";
	const text = mode === "discuss" ? DISCUSS : mode === "propose" ? PROPOSE : RUN;
	return repoTable && mode !== "discuss" ? `${text}\n${repoTable}` : text;
}
