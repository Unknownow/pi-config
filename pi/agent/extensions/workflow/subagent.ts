/**
 * Runs one role as a separate `pi` process in JSON print mode, so it gets its
 * own model, thinking level, tools and context window.
 *
 * Sub-processes start with `--no-extensions` and load only the extensions
 * listed in workflow.json (`subagent.extensions`, normally just the provider).
 * That keeps the pi-config sync extension from pulling and importing on every
 * subagent start, and keeps this extension from recursing into itself.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { RoleSpec } from "./config.ts";
import { FORWARD_ENV } from "./mcp-forward.ts";

export interface RunOptions {
	role: RoleSpec;
	/** Appended to the sub-agent's system prompt, one file per entry. */
	systemPrompts: string[];
	tools: string[];
	task: string;
	cwd: string;
	extensions: string[];
	timeoutMs: number;
	signal?: AbortSignal;
	/** Live activity, for the workflow view. */
	onEvent?: (event: SubagentEvent) => void;
	/** MCP servers to connect in the subagent (name -> config), registered by `extension` (mcp-forward.ts). */
	mcp?: { servers: Record<string, Record<string, unknown>>; extension: string };
}

export type SubagentEvent =
	| { type: "tool"; name: string; args: Record<string, unknown> }
	| { type: "text"; text: string }
	/** Usage of the assistant message in flight (cumulative while streaming); `done` once it ends. */
	| { type: "usage"; usage: Usage; done: boolean };

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	/** From tool_execution_end; undefined when the tool never finished. */
	isError?: boolean;
	/** The start of the result's text, from tool_execution_end. */
	result?: string;
}

/** How much of a tool result ToolCall.result keeps. */
const RESULT_CHARS = 4000;

export interface RunResult {
	ok: boolean;
	text: string;
	error?: string;
	model?: string;
	turns: number;
	usage: Usage;
	/** Every tool call, in order. */
	toolCalls: ToolCall[];
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(into: Usage, u: Partial<Usage> | undefined): Usage {
	if (!u) return into;
	into.input += u.input ?? 0;
	into.output += u.output ?? 0;
	into.cacheRead += u.cacheRead ?? 0;
	into.cacheWrite += u.cacheWrite ?? 0;
	into.totalTokens += u.totalTokens ?? 0;
	into.cost.input += u.cost?.input ?? 0;
	into.cost.output += u.cost?.output ?? 0;
	into.cost.cacheRead += u.cost?.cacheRead ?? 0;
	into.cost.cacheWrite += u.cost?.cacheWrite ?? 0;
	into.cost.total += u.cost?.total ?? 0;
	return into;
}

/** Records tool_execution_start / tool_execution_end events into `calls`; other events are ignored. */
export function recordToolEvent(
	calls: ToolCall[],
	event: { type?: unknown; toolCallId?: unknown; toolName?: unknown; args?: unknown; isError?: unknown; result?: unknown },
): void {
	if (event.type === "tool_execution_start") {
		const args = typeof event.args === "object" && event.args !== null ? (event.args as Record<string, unknown>) : {};
		calls.push({ id: String(event.toolCallId ?? ""), name: String(event.toolName ?? ""), args });
	} else if (event.type === "tool_execution_end") {
		const call = calls.findLast((c) => c.id === String(event.toolCallId ?? "") && c.isError === undefined);
		if (!call) return;
		call.isError = event.isError === true;
		const content = (event.result as { content?: unknown } | undefined)?.content;
		if (Array.isArray(content)) {
			call.result = content
				.map((c) => (typeof c?.text === "string" ? c.text : ""))
				.join("\n")
				.slice(0, RESULT_CHARS);
		}
	}
}

/** Same resolution as Pi's subagent example: re-run the CLI script under the current runtime. */
function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

export function expandHome(p: string): string {
	return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(os.homedir(), p.slice(1)) : p;
}

function lastAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const text = m.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text: string }).text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export async function runSubagent(opts: RunOptions): Promise<RunResult> {
	const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-workflow-"));
	const result: RunResult = { ok: false, text: "", turns: 0, usage: emptyUsage(), toolCalls: [] };
	const messages: Message[] = [];

	try {
		const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates"];
		for (const ext of opts.extensions) args.push("-e", expandHome(ext));
		if (opts.mcp) args.push("-e", "builtin:mcp", "-e", opts.mcp.extension);
		args.push("--model", opts.role.model);
		if (opts.role.thinking) args.push("--thinking", opts.role.thinking);
		if (opts.tools.length > 0) args.push("--tools", opts.tools.join(","));
		// Windows caps a command line at ~32k characters; long tasks travel as a prompt file instead.
		const longTask = opts.task.length > 8000;
		const prompts = longTask ? [...opts.systemPrompts, `## Task\n\n${opts.task}`] : opts.systemPrompts;
		for (const [i, prompt] of prompts.entries()) {
			const file = path.join(tmp, `system-${i}.md`);
			await fs.promises.writeFile(file, prompt, { encoding: "utf-8", mode: 0o600 });
			args.push("--append-system-prompt", file);
		}
		args.push(longTask ? "Do the task described under '## Task' in your system prompt." : opts.task);

		const stderr: string[] = [];
		let timedOut = false;
		let aborted = false;

		const code = await new Promise<number>((resolve) => {
			const inv = piInvocation(args);
			const proc = spawn(inv.command, inv.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: opts.mcp ? { ...process.env, [FORWARD_ENV]: JSON.stringify(opts.mcp.servers) } : process.env,
			});
			let buffer = "";

			const onLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				recordToolEvent(result.toolCalls, event);
				if (event.type === "tool_execution_start") {
					opts.onEvent?.({ type: "tool", name: event.toolName, args: event.args ?? {} });
					return;
				}
				if (event.type === "message_update") {
					if (event.usage) opts.onEvent?.({ type: "usage", usage: event.usage, done: false });
					return;
				}
				if (event.type !== "message_end" || !event.message) return;
				const msg = event.message as Message;
				messages.push(msg);
				if (msg.role !== "assistant") return;
				result.turns++;
				addUsage(result.usage, msg.usage);
				result.model ??= msg.model;
				if (msg.stopReason === "error" || msg.stopReason === "aborted") result.error = msg.errorMessage ?? msg.stopReason;
				if (msg.usage) opts.onEvent?.({ type: "usage", usage: msg.usage, done: true });
				const text = lastAssistantText(messages);
				if (text) opts.onEvent?.({ type: "text", text });
			};

			proc.stdout.on("data", (d) => {
				buffer += d.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const l of lines) onLine(l);
			});
			proc.stderr.on("data", (d) => stderr.push(d.toString()));

			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 5000);
			};
			const timer = setTimeout(() => {
				timedOut = true;
				kill();
			}, opts.timeoutMs);
			const onAbort = () => {
				aborted = true;
				kill();
			};
			if (opts.signal?.aborted) onAbort();
			else opts.signal?.addEventListener("abort", onAbort, { once: true });

			proc.on("close", (c) => {
				clearTimeout(timer);
				opts.signal?.removeEventListener("abort", onAbort);
				if (buffer.trim()) onLine(buffer);
				resolve(c ?? 0);
			});
			proc.on("error", (e) => {
				stderr.push(e.message);
				resolve(1);
			});
		});

		result.text = lastAssistantText(messages);
		if (aborted) result.error = "aborted";
		else if (timedOut) result.error = `timed out after ${Math.round(opts.timeoutMs / 1000)}s`;
		else if (code !== 0 && !result.error) result.error = stderr.join("").trim().slice(-2000) || `exit code ${code}`;
		result.ok = !result.error && result.text.length > 0;
		if (!result.ok && !result.error) result.error = "no output";
		return result;
	} finally {
		await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}
