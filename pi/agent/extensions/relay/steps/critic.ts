/** The critic (S17, S24): a one-shot, read-only review of a brief before dispatch, counted per draft. */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFindings } from "../../shared/findings.ts";
import { checkBrief } from "../brief.ts";
import type { RelayConfig } from "../config.ts";
import { DRAFT_ID, draftDir, newId } from "../job.ts";
import type { RunResult } from "../subagent.ts";

export interface CriticDeps {
	cfg: RelayConfig;
	/** `<job root>`; drafts live in `<root>/drafts/<draft>/`. */
	root: string;
	review: (task: string, cwd: string) => Promise<RunResult>;
	cwd: string;
}

export interface CriticResult {
	draft: string;
	round: number;
	/** The findings text, or the reason nothing ran. */
	text: string;
	ran: boolean;
	counts?: { blocker: number; major: number; minor: number; locked: number; authority: number };
}

/** Rounds already saved for a draft. */
export function draftRounds(root: string, draft: string): number {
	try {
		return fs.readdirSync(path.join(draftDir(root, draft), "critic")).filter((f) => /^round-\d+\.md$/.test(f)).length;
	} catch {
		return 0;
	}
}

/**
 * One critic round. A call without `draft` starts a new draft; a call with one continues it and counts its round, whatever the title says.
 * At `caps.critic` the critic does not run.
 */
export async function runCritic(d: CriticDeps, brief: string, draft?: string): Promise<CriticResult | { error: string }> {
	if (draft !== undefined && !DRAFT_ID.test(draft)) return { error: `unknown draft "${draft}"` };
	const id = draft ?? newId("d", (x) => fs.existsSync(draftDir(d.root, x)));
	const done = draftRounds(d.root, id);
	if (done >= d.cfg.caps.critic) return { draft: id, round: done, ran: false, text: `cap reached (${done} critic rounds on draft ${id}); decide and log: dispatch with overrides for any locked decision you keep against a finding` };
	const parsed = checkBrief(brief);
	const incomplete = "errors" in parsed ? `\n\nThe brief is incomplete (relay_dispatch will refuse it): ${parsed.errors.join("; ")}` : "";
	const round = done + 1;
	const task = `Review this brief (draft ${id}, round ${round} of ${d.cfg.caps.critic}).${incomplete}\n\n${brief}\n\nEnd with a VERDICT line.`;
	let res = await d.review(task, d.cwd);
	if (!res.ok) res = await d.review(task, d.cwd);
	if (!res.ok) return { error: `the critic failed twice: ${res.error ?? "no output"}` };
	const dir = path.join(draftDir(d.root, id), "critic");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `round-${round}.md`), `${res.text}\n`);
	fs.writeFileSync(path.join(draftDir(d.root, id), "brief.md"), brief);
	const f = parseFindings(res.text);
	const tagged = (t: string) => f.filter((x) => x.head.toLowerCase().includes(`[${t}]`)).length;
	return { draft: id, round, ran: true, text: res.text, counts: { blocker: f.filter((x) => x.severity === "blocker").length, major: f.filter((x) => x.severity === "major").length, minor: f.filter((x) => x.severity === "minor").length, locked: tagged("locked"), authority: tagged("authority") } };
}
