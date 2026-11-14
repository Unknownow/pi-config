/** Steps "report" and "cleanup" (S20). */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseBrief } from "../brief.ts";
import { parseFindings } from "../../shared/findings.ts";
import { JOB_END, jobEndPayload } from "../events.ts";
import type { Job } from "../job.ts";
import type { Step, StepCtx } from "../types.ts";

/** How the job ended, for the event and the first line of the notice. */
export function howEnded(job: Job): "delivered" | "stopped" | "failed" {
	if (job.state === "done") return "delivered";
	return job.state === "failed" ? "failed" : "stopped";
}

function minors(dir: string, round: number): string[] {
	try {
		const text = fs.readFileSync(path.join(dir, "judge", `round-${round}.md`), "utf8");
		return parseFindings(text)
			.filter((f) => f.severity === "minor")
			.map((f) => `- ${f.head}`);
	} catch {
		return [];
	}
}

/** report.md: Approvals, Overrides, Done-when with evidence, Decision log, open minor findings, PR and merge state (or why the job stopped). */
export function buildReport(job: Job, brief: string, dir: string): string {
	const parsed = parseBrief(brief);
	const done = "errors" in parsed ? [] : (parsed.sections["Done when"] ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[-*]\s/.test(l));
	const out: string[] = [`# Report: ${job.title}`, `Job ${job.id} - ${howEnded(job)}${job.endReason ? ` - ${job.endReason}` : ""}`, ""];

	out.push("## Approvals");
	if (job.approvals.length === 0) out.push("None: no sensitive action was approved.");
	for (const a of job.approvals) out.push(`- [${a.category}] ${a.item} - by ${a.by} (${a.reason}) at ${a.at}`);
	out.push("");

	out.push("## Overrides");
	if (job.overrides.length === 0) out.push("None.");
	for (const o of job.overrides) out.push(`- ${o.decision}: overridden for finding "${o.finding}" - ${o.reason}`);
	out.push("");

	out.push("## Done when");
	const v = job.lastVerdict;
	const evidence = v ? `judge ${v.verdict} in round ${v.round} on brief version ${v.briefVersion} (judge/round-${v.round}.md)` : "no judge verdict";
	for (const d of done) out.push(`${d} - ${evidence}`);
	if (job.doneSummary) out.push("", `Worker's summary: ${job.doneSummary}`);
	out.push("");

	out.push("## Decision log");
	out.push(`- judge rounds: ${v?.round ?? 0}; escalated rounds: ${job.escalated}; re-plans: ${job.replans}`);
	out.push(`- budget used: ${Math.round(job.used.wallMs / 60_000)} min, ${job.used.tokens} weighted tokens`);
	for (const n of job.notes) out.push(`- ${n}`);
	out.push("");

	out.push("## Open minor findings");
	const m = v ? minors(dir, v.round) : [];
	out.push(...(m.length ? m : ["None."]));
	out.push("");

	out.push("## State");
	for (const r of job.repos) {
		const bits = [`${r.key}: ${r.target}`, r.pr ? `PR ${r.pr}` : r.remoteBranch ? `branch ${r.remoteBranch} pushed, no PR` : "not pushed", r.merged ? "merged" : "not merged", r.passedViaRebase ? "passed via rebase" : ""].filter(Boolean);
		out.push(`- ${bits.join(", ")}`);
	}
	if (!job.repos.length) out.push("- no repos (the job ended before its set was created)");
	return `${out.join("\n")}\n`;
}

export const reportStep: Step = {
	name: "report",
	async run(job, ctx) {
		if (job.state !== "failed" && job.state !== "stopped") job.state = "done";
		const text = buildReport(job, ctx.brief(), ctx.dir);
		const file = path.join(ctx.dir, "report.md");
		fs.writeFileSync(file, text);
		ctx.save(job);
		const how = howEnded(job);
		const merged = job.repos.filter((r) => r.merged).length;
		ctx.wake(`relay job ${job.id} ${how}: ${job.title}\n${job.endReason ?? `${merged}/${job.repos.length} repo(s) merged${job.repos.some((r) => r.pr) ? ", PR " + job.repos.filter((r) => r.pr).map((r) => r.pr).join(", ") : ""}`}\nReport: ${file}`);
		ctx.emit(JOB_END, jobEndPayload(job.id, how, file));
		return "cleanup";
	},
};

export const cleanupStep: Step = {
	name: "cleanup",
	async run(job, ctx) {
		await ctx.stopWorker();
		const delivered = job.state === "done";
		const allMerged = job.repos.length > 0 && job.repos.every((r) => r.merged);
		if (delivered && allMerged) {
			const r = await ctx.wt.remove({ name: job.set });
			if ("error" in r) {
				job.notes.push(`set ${job.set} kept: ${r.error}`);
				ctx.notify(`relay job ${job.id}: set ${job.set} kept (${r.error})`);
			} else if (r.kept.length) {
				job.notes.push(`branches kept: ${r.kept.join(", ")}`);
				ctx.notify(`relay job ${job.id}: set removed, branches kept: ${r.kept.join(", ")}`);
			}
		} else if (delivered) {
			job.notes.push(`set ${job.set} kept until the PR merges`);
		}
		ctx.save(job);
		ctx.log("cleanup", delivered ? (allMerged ? "set removed" : "set kept until the PR merges") : "set kept");
		return "end";
	},
};
