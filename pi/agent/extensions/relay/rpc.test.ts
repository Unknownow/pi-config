// node --experimental-strip-types --test rpc.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { LfParser, RpcWorker, workerArgs } from "./rpc.ts";

test("LfParser keeps U+2028 and U+2029 inside a record, strips CR, and joins split chunks", () => {
	const p = new LfParser();
	const rec = JSON.stringify({ text: "a b c" });
	assert.deepEqual(p.feed(Buffer.from(`${rec}\r\n{"x":1}\n`)), [rec, '{"x":1}']);
	const bytes = Buffer.from('{"t":"é"}\n');
	assert.deepEqual(p.feed(bytes.subarray(0, 7)), []);
	assert.deepEqual(p.feed(bytes.subarray(7)), ['{"t":"é"}']);
	assert.deepEqual(p.feed(Buffer.from('{"half":')), []);
	assert.equal(p.rest(), '{"half":');
});

test("responses are matched by id, not by order", async () => {
	// replies to the second command before the first
	const script = `
		let buf = "", got = [];
		process.stdin.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { got.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); if (got.length === 2) { for (const c of got.reverse()) process.stdout.write(JSON.stringify({ id: c.id, type: "response", command: c.type, success: true, data: { echo: c.type } }) + "\\n"); } } });
		process.stdin.on("end", () => process.exit(0));
	`;
	const proc = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
	const w = new RpcWorker(proc, {});
	const [a, b] = await Promise.all([w.getState(), w.abort()]);
	assert.equal(a.data.echo, "get_state");
	assert.equal(b.data.echo, "abort");
	await w.stop(2000);
	assert.equal(w.exited, true);
});

test("events reach the callbacks: tools, usage, settled, exit; a pending command ends when the worker exits", async () => {
	const script = `
		const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
		out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		out({ type: "tool_execution_end", toolCallId: "t1", isError: false });
		out({ type: "message_end", message: { role: "assistant", usage: { input: 3, output: 4 } } });
		out({ type: "agent_settled" });
		setTimeout(() => process.exit(2), 100);
	`;
	const seen: string[] = [];
	const proc = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
	const exited = new Promise<number | null>((r) => {
		const w = new RpcWorker(proc, {
			onToolStart: (id, name, args) => seen.push(`start ${id} ${name} ${JSON.stringify(args)}`),
			onToolEnd: (id, err) => seen.push(`end ${id} ${err}`),
			onUsage: (u) => seen.push(`usage ${u.input} ${u.output}`),
			onSettled: () => seen.push("settled"),
			onExit: (c) => r(c),
		});
		void w.getState().then((res) => seen.push(`pending: ${res.success}`));
	});
	assert.equal(await exited, 2);
	assert.deepEqual(seen.slice(0, 4), ['start t1 bash {"command":"ls"}', "end t1 false", "usage 3 4", "settled"]);
	assert.ok(seen.includes("pending: false"));
});

test("workerArgs: the exact -e list, no other extension", () => {
	const base = { cwd: "/c", model: "p/m", sessionDir: "/s", extensions: [] as string[], env: {} };
	const a = workerArgs(base);
	assert.deepEqual(a.slice(0, 5), ["--mode", "rpc", "-ne", "-ns", "-np"]);
	const es = (args: string[]) => args.flatMap((x, i) => (args[i - 1] === "-e" ? [x] : []));
	assert.equal(es(a).length, 1);
	assert.match(es(a)[0], /worker\.ts$/);
	assert.deepEqual(a.slice(a.indexOf("--session-dir"), a.indexOf("--session-dir") + 2), ["--session-dir", "/s"]);
	assert.ok(!a.includes("-c") && !a.includes("-a") && !a.includes("-na"));
	const b = workerArgs({ ...base, extensions: ["/x/e.ts"], mcp: { knowledge: {} }, resume: true, trusted: false, thinking: "medium" });
	assert.deepEqual(es(b).map((x) => x.replace(/^.*[\\/]/, "")), ["worker.ts", "e.ts", "builtin:mcp", "mcp-forward.ts"]);
	assert.ok(b.includes("-c") && b.includes("-na") && b.includes("--thinking"));
	assert.ok(workerArgs({ ...base, trusted: true }).includes("-a"));
});
