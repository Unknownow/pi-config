// A scripted stand-in for `pi`, used with RELAY_PI_BIN. One file serves the RPC worker (--mode rpc) and the
// json-mode critic and judge (--mode json), switching on --mode.
//
// FAKE_PI_SCRIPT points to a JSON file:
//   { "worker": [ turn, ... ], "judge": [ text, ... ], "critic": [ text, ... ] }
// A turn: { "write": [{file, content}], "ask": {question} | {approval:{category,item,why}}, "done": "summary", "crash": true, "hang": true }
// Each prompt consumes the next turn (the last one repeats). Judge and critic runs consume the next text the same way.
// State (counters) lives in <script>.state.json; every start is logged to <script>.calls.jsonl.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const scriptFile = process.env.FAKE_PI_SCRIPT;
const script = scriptFile && fs.existsSync(scriptFile) ? JSON.parse(fs.readFileSync(scriptFile, "utf8")) : {};
const stateFile = scriptFile ? `${scriptFile}.state.json` : undefined;
const loadState = () => {
	try {
		return JSON.parse(fs.readFileSync(stateFile, "utf8"));
	} catch {
		return {};
	}
};
const next = (key, list) => {
	if (!list || list.length === 0) return undefined;
	const st = stateFile ? loadState() : {};
	const i = st[key] ?? 0;
	if (stateFile) fs.writeFileSync(stateFile, JSON.stringify({ ...st, [key]: i + 1 }));
	return list[Math.min(i, list.length - 1)];
};
const modeAt = argv.indexOf("--mode");
const mode = modeAt >= 0 ? argv[modeAt + 1] : "";
const sysPrompts = argv.flatMap((a, i) => (argv[i - 1] === "--append-system-prompt" ? [fs.readFileSync(a, "utf8")] : []));
const role = (sysPrompts.join("\n").match(/relay-role:\s*(\w+)/) ?? [])[1] ?? (mode === "rpc" ? "worker" : "unknown");
if (scriptFile) fs.appendFileSync(`${scriptFile}.calls.jsonl`, `${JSON.stringify({ mode, role, args: argv, cwd: process.cwd(), env: { RELAY_ROLE: process.env.RELAY_ROLE, RELAY_JOB: process.env.RELAY_JOB } })}\n`);

const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (mode === "json") {
	const text = next(role, script[role]) ?? "VERDICT: PASS";
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage, model: "fake", stopReason: "stop" } });
	process.exit(0);
}

// ---- rpc worker
const jobDir = process.env.RELAY_JOB_DIR;
const guardUrl = pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "worker-guard.ts")).href;
const { loadFacts, waitReply, workerPathProblem } = await import(guardUrl);

const sh = (cwd, args) => {
	try {
		return execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=fake@fake", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		return "";
	}
};
const append = (file, obj) => fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
const jobRepos = () => {
	try {
		return JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8")).repos.map((r) => r.worktree);
	} catch {
		return [process.cwd()];
	}
};

let busy = false;
async function turn(message) {
	busy = true;
	const t = next("worker", script.worker) ?? { done: "ok" };
	if (t.crash) process.exit(1);
	if (t.hang) await new Promise(() => {});
	let n = 0;
	for (const w of t.write ?? []) {
		const id = `t${++n}`;
		out({ type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path: w.file } });
		let problem = workerPathProblem(w.file, process.cwd(), loadFacts(jobDir));
		let go = true;
		if (problem) {
			const mid = `q${Date.now().toString(36)}`;
			const cat = /\((\w+)\)/.exec(problem)?.[1] ?? "formats";
			append(path.join(jobDir, "outbox.jsonl"), { type: "approval", id: mid, category: cat, item: w.file.replace(/\\/g, "/"), why: "needed" });
			const r = await waitReply(jobDir, mid, undefined, 100);
			go = r?.type === "approve";
		}
		if (go) {
			fs.mkdirSync(path.dirname(path.resolve(w.file)), { recursive: true });
			fs.writeFileSync(path.resolve(w.file), w.content);
		}
		out({ type: "tool_execution_end", toolCallId: id, isError: !go });
	}
	if (t.ask) {
		const mid = `a${Date.now().toString(36)}`;
		append(path.join(jobDir, "outbox.jsonl"), t.ask.approval ? { type: "approval", id: mid, ...t.ask.approval } : { type: "ask", id: mid, question: t.ask.question });
		await waitReply(jobDir, mid, undefined, 100);
	}
	if (t.done !== undefined) {
		for (const r of jobRepos()) {
			if (sh(r, ["status", "--porcelain"]).trim()) {
				sh(r, ["add", "-A"]);
				sh(r, ["commit", "-q", "-m", "work"]);
			}
		}
		append(path.join(jobDir, "outbox.jsonl"), { type: "done", summary: t.done });
	}
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "turn" }], usage } });
	out({ type: "agent_settled" });
	busy = false;
}

let buf = Buffer.alloc(0);
process.stdin.on("data", (d) => {
	buf = Buffer.concat([buf, d]);
	for (;;) {
		const i = buf.indexOf(0x0a);
		if (i < 0) break;
		const line = buf.subarray(0, i).toString("utf8").replace(/\r$/, "");
		buf = buf.subarray(i + 1);
		if (!line.trim()) continue;
		const cmd = JSON.parse(line);
		const reply = (data) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, ...(data ? { data } : {}) });
		if (cmd.type === "prompt") {
			reply({ disposition: busy ? "queued" : "started" });
			void turn(cmd.message);
		} else if (cmd.type === "steer" || cmd.type === "follow_up") reply({ disposition: "queued" });
		else if (cmd.type === "get_state") reply({ isStreaming: busy, model: { id: "fake" } });
		else if (cmd.type === "clear_queue") reply({ steering: [], followUp: [] });
		else reply();
	}
});
process.stdin.on("end", () => process.exit(0));
