/**
 * Worker entry: loaded with `-e` into a headless worker (pi --mode rpc), never by auto-discovery.
 * Gives the worker `ask_lead` and `report_done`, and refuses pushes, gh writes, publishing, branch moves and sensitive edits.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readJob } from "./job.ts";
import { append, inboxPath, newMsgId, outboxPath } from "./mailbox.ts";
import { loadFacts, waitReply, workerCommandProblem, workerPathProblem } from "./worker-guard.ts";

const jobDir = () => process.env.RELAY_JOB_DIR ?? "";

const git = (cwd: string, args: string[]): Promise<{ code: number; out: string }> =>
	new Promise((resolve) => {
		execFile("git", args, { cwd, windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "relay", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "relay", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "relay@localhost", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "relay@localhost" } }, (err, stdout, stderr) => {
			resolve({ code: err ? 1 : 0, out: String(stdout || stderr || "") });
		});
	});

export default function worker(pi: ExtensionAPI): void {
	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as Record<string, unknown>;
		const facts = loadFacts(jobDir());
		if (/(^|__)bash$/.test(event.toolName)) {
			const why = workerCommandProblem(String(input.command ?? ""), facts);
			if (why) return { block: true, reason: why };
		} else if (/(^|__)(edit|write)$/.test(event.toolName)) {
			const file = String(input.path ?? input.file_path ?? "");
			const why = file ? workerPathProblem(file, ctx.cwd, facts) : undefined;
			if (why) return { block: true, reason: why };
		}
		return undefined;
	});

	pi.registerTool({
		name: "ask_lead",
		label: "Ask the lead",
		description:
			"Ask the lead (the session that gave you this job) a question, or ask it to approve a sensitive action (merge, publish, comments, delete, formats/schemas/CI/secrets, dependencies). Blocks until the lead answers. Use it instead of guessing; never ask for something the brief already decides.",
		promptSnippet: "ask_lead: ask the lead a question or ask for approval of a sensitive action",
		parameters: Type.Object({
			question: Type.String({ description: "The question, or the reason for the approval" }),
			approval: Type.Optional(
				Type.Object({
					category: Type.String({ description: "merge | publish | comments | delete | formats | deps" }),
					item: Type.String({ description: "The exact path or command to approve" }),
					why: Type.String(),
				}),
			),
		}),
		async execute(_id, params, signal) {
			const id = newMsgId();
			const dir = jobDir();
			append(outboxPath(dir), params.approval ? { type: "approval", id, category: params.approval.category, item: params.approval.item, why: params.approval.why || params.question } : { type: "ask", id, question: params.question });
			const r = await waitReply(dir, id, signal);
			if (!r) return { content: [{ type: "text", text: "aborted while waiting for the lead" }], details: {} };
			const text = r.type === "answer" ? r.text : r.type === "approve" ? `approved: ${r.reason}` : `refused: ${r.reason}`;
			return { content: [{ type: "text", text }], details: { reply: r.type } };
		},
	});

	pi.registerTool({
		name: "report_done",
		label: "Report done",
		description: "Say the work is finished. Uncommitted changes are committed for you. Then stop and wait: a reviewer checks the result and you get its findings, or nothing more to do.",
		promptSnippet: "report_done: submit the finished work for review",
		parameters: Type.Object({ summary: Type.String({ description: "What you did and how you checked it, against each Done-when bullet" }) }),
		async execute(_id, params) {
			const dir = jobDir();
			const job = readJob(dir);
			for (const r of job?.repos ?? []) {
				if (!fs.existsSync(r.worktree)) continue;
				const st = await git(r.worktree, ["status", "--porcelain"]);
				if (st.out.trim()) {
					await git(r.worktree, ["add", "-A"]);
					await git(r.worktree, ["commit", "-q", "-m", "relay: wip"]);
				}
			}
			append(outboxPath(dir), { type: "done", summary: params.summary });
			return { content: [{ type: "text", text: "submitted for review; stop and wait" }], details: {} };
		},
	});
}
