/** The RPC client for a worker: `pi --mode rpc` over strict LF-delimited JSONL (no readline: U+2028 is valid inside a JSON string). */

import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FORWARD_ENV } from "./mcp-forward.ts";
import { piCommand } from "./pi-bin.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Splits a byte stream into records on LF only; a preceding CR is stripped. */
export class LfParser {
	private buf: Buffer = Buffer.alloc(0);
	feed(chunk: Buffer): string[] {
		this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
		const out: string[] = [];
		let start = 0;
		for (;;) {
			const i = this.buf.indexOf(0x0a, start);
			if (i < 0) break;
			let end = i;
			if (end > start && this.buf[end - 1] === 0x0d) end--;
			out.push(this.buf.subarray(start, end).toString("utf8"));
			start = i + 1;
		}
		this.buf = this.buf.subarray(start);
		return out;
	}
	/** Whatever is left without a final LF. */
	rest(): string {
		return this.buf.toString("utf8");
	}
}

export interface WorkerOpts {
	cwd: string;
	model: string;
	thinking?: string;
	sessionDir: string;
	/** Continue the newest session in `sessionDir` (`-c`). */
	resume?: boolean;
	/** The lead's project trust. */
	trusted?: boolean;
	/** relay.json `worker.extensions`. */
	extensions: string[];
	/** Forward the knowledge MCP: `-e builtin:mcp -e mcp-forward.ts` and the servers. */
	mcp?: Record<string, Record<string, unknown>>;
	env: Record<string, string>;
}

/** The pi arguments for a worker. The `-e` list is exactly worker.ts, the configured extensions, and (with `mcp`) builtin:mcp and mcp-forward.ts. */
export function workerArgs(o: WorkerOpts): string[] {
	const a = ["--mode", "rpc", "-ne", "-ns", "-np", "-e", path.join(here, "worker.ts")];
	for (const e of o.extensions) a.push("-e", e);
	if (o.mcp) a.push("-e", "builtin:mcp", "-e", path.join(here, "mcp-forward.ts"));
	a.push("--session-dir", o.sessionDir);
	if (o.resume) a.push("-c");
	a.push("--model", o.model);
	if (o.thinking) a.push("--thinking", o.thinking);
	if (o.trusted !== undefined) a.push(o.trusted ? "-a" : "-na");
	return a;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface RpcCallbacks {
	onToolStart?(id: string, name: string, args: Record<string, unknown>): void;
	onToolEnd?(id: string, isError: boolean): void;
	/** Usage of one finished assistant message. */
	onUsage?(u: Usage): void;
	/** Any event at all (the stall timer). */
	onActivity?(): void;
	/** `agent_settled`: pi will not continue on its own. */
	onSettled?(): void;
	onExit?(code: number | null): void;
	onStderr?(text: string): void;
}

export interface RpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	error?: string;
	data?: any;
}

export class RpcWorker {
	readonly proc: ChildProcess;
	exited = false;
	private readonly pending = new Map<string, { resolve: (r: RpcResponse) => void; timer: ReturnType<typeof setTimeout> }>();
	private seq = 0;
	private readonly parser = new LfParser();
	private readonly cb: RpcCallbacks;

	constructor(proc: ChildProcess, cb: RpcCallbacks) {
		this.proc = proc;
		this.cb = cb;
		proc.stdout?.on("data", (d: Buffer) => {
			for (const line of this.parser.feed(d)) this.onLine(line);
		});
		proc.stderr?.on("data", (d: Buffer) => cb.onStderr?.(d.toString()));
		proc.on("close", (code) => this.end(code));
		proc.on("error", () => this.end(1));
	}

	get pid(): number | undefined {
		return this.proc.pid;
	}

	private end(code: number | null) {
		if (this.exited) return;
		this.exited = true;
		for (const [id, p] of this.pending) {
			clearTimeout(p.timer);
			p.resolve({ type: "response", id, command: "exit", success: false, error: "worker exited" });
		}
		this.pending.clear();
		this.cb.onExit?.(code);
	}

	private onLine(line: string) {
		if (!line.trim()) return;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		this.cb.onActivity?.();
		if (ev.type === "response") {
			const p = ev.id ? this.pending.get(ev.id) : undefined;
			if (p) {
				clearTimeout(p.timer);
				this.pending.delete(ev.id);
				p.resolve(ev as RpcResponse);
			}
			return;
		}
		if (ev.type === "tool_execution_start") this.cb.onToolStart?.(String(ev.toolCallId ?? ""), String(ev.toolName ?? ""), typeof ev.args === "object" && ev.args ? ev.args : {});
		else if (ev.type === "tool_execution_end") this.cb.onToolEnd?.(String(ev.toolCallId ?? ""), ev.isError === true);
		else if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) this.cb.onUsage?.(ev.message.usage);
		else if (ev.type === "agent_settled") this.cb.onSettled?.();
	}

	/** Sends a command and waits for its response by id. */
	send(cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
		if (this.exited || !this.proc.stdin?.writable) return Promise.resolve({ type: "response", command: String(cmd.type), success: false, error: "worker is not running" });
		const id = `c${++this.seq}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ type: "response", id, command: String(cmd.type), success: false, error: `no response within ${Math.round(timeoutMs / 1000)} s` });
			}, timeoutMs);
			this.pending.set(id, { resolve, timer });
			this.proc.stdin?.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	}

	prompt(message: string, streamingBehavior?: "steer" | "followUp") {
		return this.send({ type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) });
	}
	steer(message: string) {
		return this.send({ type: "steer", message });
	}
	followUp(message: string) {
		return this.send({ type: "follow_up", message });
	}
	abort() {
		return this.send({ type: "abort" });
	}
	clearQueue() {
		return this.send({ type: "clear_queue" });
	}
	getState() {
		return this.send({ type: "get_state" });
	}
	setModel(provider: string, modelId: string) {
		return this.send({ type: "set_model", provider, modelId });
	}

	/** Orderly shutdown: close stdin, kill after `graceMs`. Resolves when the process has exited. */
	async stop(graceMs = 10_000): Promise<void> {
		if (this.exited) return;
		const done = new Promise<void>((r) => this.proc.once("close", () => r()));
		this.proc.stdin?.end();
		const t = setTimeout(() => this.proc.kill(), graceMs);
		await Promise.race([done, new Promise<void>((r) => setTimeout(r, graceMs + 3000))]);
		clearTimeout(t);
	}
	kill() {
		this.proc.kill();
	}
}

/** Starts a worker process. */
export function startWorker(o: WorkerOpts, cb: RpcCallbacks): RpcWorker {
	const cmd = piCommand(workerArgs(o));
	const proc = spawn(cmd.command, cmd.args, {
		cwd: o.cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...o.env, RELAY_ROLE: "worker", ...(o.mcp ? { [FORWARD_ENV]: JSON.stringify(o.mcp) } : {}) },
		windowsHide: true,
	});
	return new RpcWorker(proc, cb);
}
