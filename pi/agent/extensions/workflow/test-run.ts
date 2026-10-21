/**
 * Pure parts of the test_run tool: task IDs, scheduling by resource, the runner's reply, and the
 * check of its claims against the commands it really ran. test-run.test.ts covers them.
 */

import type { ToolCall } from "./subagent.ts";
import { mapLimit } from "./subagent.ts";

export interface TestTask {
	id: string;
	run: string;
	observe: string;
	pass: string;
	/** What the task needs alone, e.g. `unity:<project>`, `device:<serial>`, or `none`. */
	resource: string;
}

const ID_CHARS = 40;

/** Safe, unique task IDs ([A-Za-z0-9_-]{1,40}): bad characters become `_`, empty ones `task<n>`, repeats get `-2`, `-3`, ... */
export function sanitizeIds(ids: string[]): string[] {
	const seen = new Set<string>();
	return ids.map((raw, i) => {
		const base = (raw.trim().replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, ID_CHARS - 4).replace(/^_+|_+$/g, "") || `task${i + 1}`);
		let id = base;
		for (let n = 2; seen.has(id.toLowerCase()); n++) id = `${base}-${n}`;
		seen.add(id.toLowerCase());
		return id;
	});
}

const resourceKey = (r: string) => r.trim().toLowerCase();

/**
 * Runs `runOne` over the tasks: tasks with the same resource one after another (input order), the
 * groups at most `concurrency` at a time. A task without a resource, or `none`, is its own group.
 * Results come back in input order.
 */
export async function scheduleTasks<T extends { resource: string }, R>(tasks: T[], concurrency: number, runOne: (task: T, index: number) => Promise<R>): Promise<R[]> {
	const groups: number[][] = [];
	const byResource = new Map<string, number[]>();
	tasks.forEach((t, i) => {
		const k = resourceKey(t.resource);
		if (!k || k === "none") {
			groups.push([i]);
			return;
		}
		const g = byResource.get(k);
		if (g) g.push(i);
		else {
			const fresh = [i];
			byResource.set(k, fresh);
			groups.push(fresh);
		}
	});
	const out: R[] = new Array(tasks.length);
	await mapLimit(groups, concurrency, async (group) => {
		for (const i of group) out[i] = await runOne(tasks[i], i);
	});
	return out;
}

export type RunnerResult = "PASS" | "FAIL" | "ERROR";
export const OBSERVED_LINES = 40;

export interface RunnerReply {
	result: RunnerResult;
	command: string;
	exit: string;
	observed: string;
	artifacts: string[];
	/** Why the result is ERROR when the reply was unusable. */
	note?: string;
}

/** The runner's reply: RESULT, Command, Exit, Observed (cut to 40 lines), Artifacts. No RESULT line means ERROR. */
export function parseRunnerReply(text: string): RunnerReply {
	const lines = text.split(/\r?\n/);
	const get = (name: string) => lines.map((l) => new RegExp(`^\\s*\\**${name}\\**:\\s*(.*)$`, "i").exec(l)).find((m) => m)?.[1].trim() ?? "";
	const m = /^\s*\**RESULT\**:\s*\**\s*(PASS|FAIL|ERROR)\b/im.exec(text);
	let observed = "";
	const at = lines.findIndex((l) => /^\s*\**Observed\**:/i.test(l));
	if (at >= 0) {
		const rest: string[] = [lines[at].replace(/^\s*\**Observed\**:\s*/i, "")];
		for (const l of lines.slice(at + 1)) {
			if (/^\s*\**Artifacts\**:/i.test(l)) break;
			rest.push(l);
		}
		observed = rest.join("\n").trim().split("\n").slice(0, OBSERVED_LINES).join("\n");
	}
	const art = at >= 0 || /Artifacts/i.test(text) ? artifactsOf(lines) : [];
	const reply: RunnerReply = { result: (m?.[1].toUpperCase() as RunnerResult | undefined) ?? "ERROR", command: get("Command"), exit: get("Exit"), observed, artifacts: art };
	if (!m) reply.note = "runner gave no RESULT line";
	return reply;
}

function artifactsOf(lines: string[]): string[] {
	const at = lines.findIndex((l) => /^\s*\**Artifacts\**:/i.test(l));
	if (at < 0) return [];
	const raw = [lines[at].replace(/^\s*\**Artifacts\**:\s*/i, ""), ...lines.slice(at + 1)].join("\n");
	return raw
		.split(/[\n,]/)
		.map((s) => s.replace(/^\s*[-*]\s+/, "").trim())
		.filter((s) => s && !/^none$/i.test(s));
}

export interface RanCommand {
	ok: boolean;
	/** The first 200 characters of the command. */
	command: string;
}

const isBash = (name: string) => /(^|__)bash$/.test(name);

export interface Verified {
	/** `PASS`, `FAIL`, `ERROR`, or the result with `(unverified: ...)`. */
	status: string;
	ran: RanCommand[];
}

/** The runner's claim against the bash commands it really ran. */
export function verifyRun(reply: RunnerReply, toolCalls: ToolCall[]): Verified {
	const ran = toolCalls
		.filter((c) => isBash(c.name))
		.map((c) => ({ ok: c.isError !== true, command: String(c.args?.command ?? "").slice(0, 200) }));
	if (reply.result === "ERROR") return { status: reply.note ? `ERROR: ${reply.note}` : "ERROR", ran };
	if (!ran.length) return { status: `${reply.result} (unverified: no command was run)`, ran };
	const failed = ran.filter((r) => !r.ok).length;
	if (reply.result === "PASS" && failed) return { status: `PASS (unverified: ${failed} command(s) failed)`, ran };
	return { status: reply.result, ran };
}

/** The text the runner gets for its task. */
export function taskCard(task: TestTask, cwd: string, artifacts: string): string {
	return [`## Task ${task.id}`, `Run: ${task.run}`, `Observe: ${task.observe}`, `Pass when: ${task.pass}`, `Resource: ${task.resource}`, `Working folder: ${cwd}`, `Artifacts folder: ${artifacts}`].join("\n");
}

/** One task's section of the tool result. */
export function formatTaskResult(o: { id: string; resource: string; status: string; reply?: RunnerReply; ran: RanCommand[]; record?: string }): string {
	const out = [`### ${o.id} · ${o.resource || "none"} · ${o.status}`];
	if (o.reply) {
		out.push(`Command: ${o.reply.command || "(none given)"}`, `Exit: ${o.reply.exit || "(none given)"}`);
		out.push(`Observed:\n${o.reply.observed || "(nothing)"}`);
		out.push(`Artifacts: ${o.reply.artifacts.length ? o.reply.artifacts.join(", ") : "none"}`);
	}
	out.push(`Commands actually run (${o.ran.length}):`);
	for (const r of o.ran) out.push(`- ${r.ok ? "ok" : "error"} \`${r.command.replace(/\s*\n\s*/g, " ")}\``);
	if (o.record) out.push(`Record: ${o.record}`);
	return out.join("\n");
}

/** The per-task record file: the card, the reply, and each bash call with the start of its result. */
export function taskRecord(card: string, replyText: string, toolCalls: ToolCall[]): string {
	const calls = toolCalls
		.filter((c) => isBash(c.name))
		.map((c, i) => `### Command ${i + 1} (${c.isError ? "error" : "ok"})\n\`\`\`\n${String(c.args?.command ?? "")}\n\`\`\`\n\`\`\`\n${(c.result ?? "").slice(0, 2000)}\n\`\`\``);
	return [card, "## Runner reply", replyText || "(empty)", "## Commands", ...(calls.length ? calls : ["(none)"])].join("\n\n") + "\n";
}
