// node --experimental-strip-types --test index.test.ts
// The extension with a fake pi: which tools PI_AGENTS_TOOLS registers, the advisor cap, the judge takeover.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import "./test-hooks.ts";

const { default: agents, readDocument } = await import("./index.ts");
const { ADVISOR_CAP_ENV, TOOLS_ENV, advisorGate, appendUsage, parseCap, toolEnabled } = await import("./env.ts");

type Tool = { name: string; execute: (...a: unknown[]) => Promise<unknown> };

function fakePi() {
	const tools = new Map<string, Tool>();
	const listeners = new Map<string, ((d: unknown) => void)[]>();
	const pi = {
		registerTool: (t: Tool) => tools.set(t.name, t),
		registerCommand: () => {},
		on: () => {},
		getMcpServers: () => [],
		exec: async () => ({ code: 1, stdout: "", stderr: "not a repo" }),
		events: {
			emit: (name: string, d: unknown) => (listeners.get(name) ?? []).forEach((l) => l(d)),
			on: (name: string, l: (d: unknown) => void) => listeners.set(name, [...(listeners.get(name) ?? []), l]),
		},
	};
	return { pi, tools };
}

function load(env: Record<string, string | undefined> = {}) {
	const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	try {
		const f = fakePi();
		agents(f.pi as never);
		return f;
	} finally {
		for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
}

const ctx = { cwd: os.tmpdir(), sessionManager: { getBranch: () => [], getSessionFile: () => "s1" } };

test("all five tools by default; PI_AGENTS_TOOLS registers only the listed ones", () => {
	assert.deepEqual([...load({ [TOOLS_ENV]: undefined }).tools.keys()].sort(), ["advisor", "critic", "explore", "judge", "test_run"]);
	assert.deepEqual([...load({ [TOOLS_ENV]: "explore, judge" }).tools.keys()].sort(), ["explore", "judge"]);
	assert.equal(toolEnabled("x", ""), true);
	assert.equal(toolEnabled("x", "y"), false);
});

test("PI_AGENTS_ADVISOR_CAP: the advisor refuses past the cap, with a clear message", async () => {
	const { tools } = load({ [ADVISOR_CAP_ENV]: "0" });
	await assert.rejects(tools.get("advisor")!.execute("id", { situation: "approach", question: "q" }, undefined, undefined, ctx), /advisor refused: .*0 time.*PI_AGENTS_ADVISOR_CAP/);
	const gate = advisorGate(2);
	assert.equal(gate.take(), undefined);
	assert.equal(gate.take(), undefined);
	assert.match(gate.take() ?? "", /2 times/);
	assert.equal(advisorGate(undefined).take(), undefined);
	assert.equal(parseCap("3"), 3);
	assert.equal(parseCap("x"), undefined);
	assert.equal(parseCap(""), undefined);
});

test("PI_AGENTS_USAGE_FILE: one JSON line per run is appended", () => {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-")), "u.jsonl");
	const line = { role: "explore", model: "m", usage: { input: 1 } as never, weightedCost: 1, ok: true, at: "t" };
	appendUsage(file, line);
	appendUsage(file, { ...line, role: "advisor" });
	appendUsage(undefined, line);
	assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l).role), ["explore", "advisor"]);
	appendUsage(path.join(file, "no", "dir"), line); // never throws
});

test("judge takeover: a claimed answer is returned unchanged; { error } throws; null falls back to the own judge", async () => {
	const { pi, tools } = load();
	const judge = tools.get("judge")!;
	let answer: unknown = { content: [{ type: "text", text: "taken" }], details: { x: 1 }, usage: { input: 1 } };
	const payloads: Record<string, unknown>[] = [];
	pi.events.on("agents:judge-call", (d) => {
		const p = d as Record<string, unknown> & { claim: (a: unknown) => void };
		payloads.push(p);
		p.claim(Promise.resolve(answer));
	});
	const signal = new AbortController().signal;
	const onUpdate = () => {};
	const got = await judge.execute("id", { focus: "f", full: true }, signal, onUpdate, ctx);
	assert.equal(got, answer);
	assert.equal(payloads[0].v, 1);
	assert.deepEqual(payloads[0].params, { focus: "f", full: true });
	assert.equal(payloads[0].ctx, ctx);
	assert.equal(payloads[0].signal, signal);
	assert.equal(payloads[0].onUpdate, onUpdate);
	answer = { error: "flow judge failed" };
	await assert.rejects(judge.execute("id", {}, signal, onUpdate, ctx), /flow judge failed/);
	answer = null;
	// The own judge: the fake git finds no repo.
	await assert.rejects(judge.execute("id", {}, signal, onUpdate, ctx), /no git work tree/);
});

test("judge without a listener runs its own (no repo here)", async () => {
	const { tools } = load();
	await assert.rejects(tools.get("judge")!.execute("id", {}, undefined, undefined, ctx), /no git work tree/);
});

test("readDocument: a short one-line path to a file is read; anything else is the text", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-"));
	fs.writeFileSync(path.join(dir, "plan.md"), "THE PLAN");
	assert.equal(readDocument("plan.md", dir), "THE PLAN");
	assert.equal(readDocument(path.join(dir, "plan.md"), "/"), "THE PLAN");
	assert.equal(readDocument("no-such.md", dir), "no-such.md");
	assert.equal(readDocument("line one\nplan.md", dir), "line one\nplan.md");
});
