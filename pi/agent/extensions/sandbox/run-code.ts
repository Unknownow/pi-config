/** run_code: run a JavaScript snippet in a child node process and return a capped text result. */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CAP = 8000;
const HEAD = 6000;
const TAIL = 2000;
const DEFAULT_TIMEOUT = 60;
const MAX_TIMEOUT = 600;

export interface RunResult {
	text: string;
	exitCode: number;
	timedOut: boolean;
}

const cutNote = (head: string, tail: string, total: number) => `${head}\n[output cut: ${CAP} of ${total} characters shown; print less]\n${tail}`;

export function capOutput(s: string): string {
	return s.length <= CAP ? s : cutNote(s.slice(0, HEAD), s.slice(-TAIL), s.length);
}

/** Keeps the first HEAD and the last TAIL characters of a stream and counts the rest, so a runaway script cannot fill the host's memory. */
class Bounded {
	head = "";
	tail = "";
	total = 0;
	add(chunk: string): void {
		this.total += chunk.length;
		if (this.head.length < HEAD) {
			const room = HEAD - this.head.length;
			this.head += chunk.slice(0, room);
			chunk = chunk.slice(room);
		}
		if (chunk) this.tail = (this.tail + chunk).slice(-TAIL);
	}
	/** Counts characters that were dropped upstream. */
	skip(n: number): void {
		this.total += n;
	}
	/** Adds another bounded stream: its kept head and tail, and the count of what it dropped. */
	feed(o: Bounded): void {
		if (o.total <= CAP) return this.add(o.head + o.tail);
		this.add(o.head);
		this.skip(o.total - o.head.length - o.tail.length);
		this.add(o.tail);
	}
	/** The stream as is while it fits in CAP, else the head, the note and the tail. */
	text(): string {
		return this.total <= CAP ? this.head + this.tail : cutNote(this.head, this.tail, this.total);
	}
}

function nodeBinary(): string {
	const base = path.basename(process.execPath).toLowerCase();
	return base === "node" || base === "node.exe" ? process.execPath : "node";
}

function killTree(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
		else process.kill(-pid, "SIGKILL");
	} catch {
		// already gone
	}
}

export async function runCode(
	params: { code: string; cwd?: string; timeout?: number },
	opts: { cwd: string; signal?: AbortSignal },
): Promise<RunResult> {
	const seconds = Math.min(MAX_TIMEOUT, Math.max(1, Math.round(params.timeout ?? DEFAULT_TIMEOUT)));
	const cwd = params.cwd ? path.resolve(opts.cwd, params.cwd) : opts.cwd;
	if (!fs.existsSync(cwd)) return { text: `cwd not found: ${cwd}`, exitCode: -1, timedOut: false };
	const file = path.join(os.tmpdir(), `pi-run-${randomBytes(6).toString("hex")}.cjs`);
	fs.writeFileSync(file, `(async () => {\n${params.code}\n})().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1; });\n`);
	try {
		return await new Promise<RunResult>((resolve) => {
			const out = new Bounded();
			const err = new Bounded();
			let timedOut = false;
			let aborted = false;
			let settled = false;
			const child = spawn(nodeBinary(), [file], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
			const finish = (code: number, spawnError?: string) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(grace);
				opts.signal?.removeEventListener("abort", onAbort);
				const all = new Bounded();
				if (spawnError) all.add(spawnError);
				else {
					all.feed(out);
					if (err.total) {
						all.add("\n[stderr]\n");
						all.feed(err);
					}
					if (code !== 0) all.add(`\n[exit code ${code}]`);
				}
				if (timedOut) all.add(`\n[timed out after ${seconds} s; process tree killed]`);
				else if (aborted) all.add("\n[aborted]");
				resolve({ text: all.text(), exitCode: code, timedOut });
			};
			// A grandchild that keeps the pipes open would stop "close" from firing: give up on the pipes shortly after a kill or exit.
			let exitCode: number | null = null;
			let grace: NodeJS.Timeout | undefined;
			const giveUp = () => {
				if (grace) return;
				grace = setTimeout(() => {
					child.stdout.destroy();
					child.stderr.destroy();
					finish(exitCode ?? 137);
				}, 2000);
			};
			const onAbort = () => {
				aborted = true;
				killTree(child.pid);
				giveUp();
			};
			const timer = setTimeout(() => {
				timedOut = true;
				killTree(child.pid);
				giveUp();
			}, seconds * 1000);
			if (opts.signal?.aborted) onAbort();
			else opts.signal?.addEventListener("abort", onAbort, { once: true });
			child.stdout.setEncoding("utf8").on("data", (d: string) => out.add(d));
			child.stderr.setEncoding("utf8").on("data", (d: string) => err.add(d));
			child.on("error", (e) => finish(-1, `failed to start node: ${e.message}`));
			child.on("exit", (code) => {
				exitCode = code;
				giveUp();
			});
			child.on("close", (code) => finish(code ?? (timedOut || aborted ? 137 : 1)));
		});
	} finally {
		try {
			fs.unlinkSync(file);
		} catch {
			// ignore
		}
	}
}
