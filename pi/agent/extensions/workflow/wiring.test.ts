// node --experimental-strip-types --test wiring.test.ts
// Smoke test of index.ts's wiring: everything it registers at load, in order, and a session start, `/flow status`
// and a shutdown with a fake pi. The expected list was captured from the code before index.ts was split into flow/.
await import("./test-hooks.ts");
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

type Entry = [kind: string, name: string, ...params: string[]];
type Handler = (...a: unknown[]) => unknown;

/** A permissive fake: every unknown member is a function returning undefined. */
function permissive<T extends object>(known: T): T {
	return new Proxy(known, {
		get: (t, k) => (k in t ? (t as Record<PropertyKey, unknown>)[k] : k === "then" ? undefined : () => undefined),
	});
}

const EXPECTED: Entry[] = [
	["flag", "flow"],
	["tool", "wait_for_user", "reason", "check", "step", "kind", "manual"],
	["tool", "publish_packages", "step"],
	["tool", "git_task", "task", "repo"],
	["tool", "plan_check", "done", "undone"],
	["tool", "request_merge", "reason", "repos"],
	["events.on", "agents:judge-call"],
	["tool", "deliver", "tag", "step", "reason"],
	["on", "turn_start"],
	["on", "before_agent_start"],
	["on", "tool_call"],
	["on", "tool_result"],
	["on", "tool_result"],
	["on", "turn_end"],
	["on", "message_update"],
	["on", "message_end"],
	["on", "agent_settled"],
	["on", "agent_start"],
	["on", "input"],
	["on", "session_compact"],
	["on", "agent_end"],
	["on", "session_start"],
	["on", "session_before_switch"],
	["events.on", "agents:subagent-finished"],
	["on", "session_shutdown"],
	["command", "flow"],
];

test("index.ts registers the same flags, tools, commands and events in the same order, and starts, reports and shuts down", async () => {
	const savedPath = process.env.PATH;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-wiring-"));
	try {
		const list: Entry[] = [];
		const handlers = new Map<string, Handler[]>();
		const commands = new Map<string, { handler: Handler }>();
		const notes: string[] = [];
		let activeTools: string[] = ["read", "bash", "edit", "write"];
		const pi = permissive({
			registerFlag: (name: string) => void list.push(["flag", name]),
			registerTool: (t: { name: string; parameters?: { args?: unknown[] } }) => {
				const schema = t.parameters?.args?.[0];
				list.push(["tool", t.name, ...(schema && typeof schema === "object" ? Object.keys(schema) : [])]);
			},
			registerCommand: (name: string, c: { handler: Handler }) => {
				list.push(["command", name]);
				commands.set(name, c);
			},
			on: (event: string, h: Handler) => {
				list.push(["on", event]);
				handlers.set(event, [...(handlers.get(event) ?? []), h]);
			},
			events: permissive({
				on: (channel: string) => void list.push(["events.on", channel]),
				emit: () => undefined,
			}),
			getFlag: (name: string) => (name === "flow" ? "off" : undefined),
			exec: async () => ({ code: 1, stdout: "", stderr: "fake exec", killed: false }),
			setModel: async () => true,
			setActiveTools: (t: string[]) => void (activeTools = [...t]),
			getActiveTools: () => activeTools,
			getAllTools: () => [],
			appendEntry: () => undefined,
		});
		const ctx = permissive({
			cwd,
			hasUI: false,
			ui: permissive({
				notify: (text: string) => void notes.push(text),
				setStatus: () => undefined,
				select: async () => undefined,
			}),
			sessionManager: permissive({ getBranch: () => [] }),
			isIdle: () => true,
		});

		const mod = await import("./index.ts");
		mod.default(pi as never);
		assert.deepEqual(list, EXPECTED);

		for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start", reason: "startup" }, ctx);
		// Housekeeping and the gh check run un-awaited; let them settle.
		for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
		await commands.get("flow")!.handler("status", ctx);
		assert.ok(notes.some((n) => n.startsWith("phase      off")), `status shown: ${notes.join(" | ")}`);
		for (const h of handlers.get("session_shutdown") ?? []) await h({ type: "session_shutdown" }, ctx);
	} finally {
		process.env.PATH = savedPath;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
