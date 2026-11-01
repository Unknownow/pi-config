// node --experimental-strip-types --test knowledge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { KnowledgeConfig } from "./config.ts";
import { judgeKnowledge as knowledgePrompt } from "./prompts.ts";
import {
	deviationBlock,
	forwardedServers,
	judgeKnowledge,
	knowledgeFooter,
	mergeKnowledgePass,
	parseDeviations,
	recheckKnowledgeFiles,
	roleTools,
	toolPrefix,
} from "./knowledge.ts";
import type { ToolCall } from "../agents/subagent.ts";

// DEFAULTS.knowledge, inline: config.ts loads pi at runtime.
const CFG: KnowledgeConfig = {
	server: "knowledge",
	roles: ["explore", "advisor", "judge", "arbiter"],
	tools: ["search", "get_entry", "get_rule_pack", "get_schema", "status"],
	env: { KNOWLEDGE_OFFLINE: "1" },
	judgeCheck: true,
};
const FILES = ["src/a.cs", "src/b.cs"];
const S = "knowledge";
const pack = (paths: unknown, isError: boolean | undefined = false, name = "mcp__knowledge__get_rule_pack"): ToolCall => ({
	id: "1",
	name,
	args: paths === undefined ? { generator: "code" } : { generator: "code", paths },
	isError,
});

test("toolPrefix normalizes the server name", () => {
	assert.equal(toolPrefix("knowledge"), "mcp__knowledge__");
	assert.equal(toolPrefix("my-kb"), "mcp__my_kb__");
});

test("roleTools gives the listed roles the prefixed tools", () => {
	assert.deepEqual(roleTools("judge", CFG), [
		"mcp__knowledge__search",
		"mcp__knowledge__get_entry",
		"mcp__knowledge__get_rule_pack",
		"mcp__knowledge__get_schema",
		"mcp__knowledge__status",
	]);
	assert.deepEqual(roleTools("plan", CFG), []);
	assert.deepEqual(roleTools("judge", { ...CFG, server: "" }), []);
	assert.deepEqual(roleTools("judge", { ...CFG, tools: ["search", "propose_entry"] }), ["mcp__knowledge__search"], "never a write tool");
});

test("forwardedServers adds env to stdio servers only", () => {
	const stdio = { command: "node", args: ["launch.mjs"], exposure: "direct", env: { A: "1" } };
	assert.deepEqual(forwardedServers([{ name: "knowledge", config: stdio }], CFG), {
		knowledge: { command: "node", args: ["launch.mjs"], exposure: "direct", env: { A: "1", KNOWLEDGE_OFFLINE: "1" } },
	});
	assert.deepEqual(stdio.env, { A: "1" }, "the registered config is not changed");
	const url = forwardedServers([{ name: "knowledge", config: { url: "http://h" } }], CFG);
	assert.deepEqual(url, { knowledge: { url: "http://h", exposure: "direct" } });
	const codemode = forwardedServers([{ name: "knowledge", config: { url: "http://h", exposure: "codemode", toolExposure: { search: "deferred" } } }], CFG);
	assert.deepEqual(codemode, { knowledge: { url: "http://h", exposure: "direct" } }, "subagents call the tools directly");
	assert.equal("env" in url.knowledge, false);
	assert.deepEqual(forwardedServers([{ name: "other", config: stdio }], CFG), {});
	assert.deepEqual(forwardedServers([{ name: "knowledge", config: stdio }], { ...CFG, server: "" }), {});
});

test("judgeKnowledge: checked when successful rule packs cover every changed file", () => {
	assert.deepEqual(judgeKnowledge([pack(FILES)], "", FILES, S), { status: "checked" });
	assert.deepEqual(judgeKnowledge([pack(undefined)], "", FILES, S), { status: "checked" });
	assert.deepEqual(judgeKnowledge([pack([])], "", FILES, S), { status: "checked" });
	assert.deepEqual(judgeKnowledge([pack(["src/a.cs"]), pack(["src/b.cs"])], "", FILES, S), { status: "checked" });
	assert.deepEqual(judgeKnowledge([pack(["D:\\r\\src\\a.cs", "./src/b.cs"])], "", FILES, S), { status: "checked" });
});

test("judgeKnowledge: skipped without a covering, finished rule pack call", () => {
	assert.equal(judgeKnowledge([pack(["src/a.cs"])], "", FILES, S).status, "skipped");
	assert.equal(judgeKnowledge([], "KNOWLEDGE: checked 3 rules (x); 0 broken\nVERDICT: PASS", FILES, S).status, "skipped");
	assert.equal(judgeKnowledge([], "KNOWLEDGE: unavailable - connection closed", FILES, S).status, "skipped");
	assert.equal(judgeKnowledge([{ ...pack(FILES), isError: undefined }], "", FILES, S).status, "skipped");
	assert.equal(judgeKnowledge([pack(FILES, false, "mcp__other__get_rule_pack")], "", FILES, S).status, "skipped");
});

test("judgeKnowledge: a rule pack with no rules means no index", () => {
	const empty = { ...pack(FILES), result: '{\n  "generator": "code",\n  "rules": [],\n  "notes": []\n}' };
	assert.deepEqual(judgeKnowledge([empty], "KNOWLEDGE: checked 0 rules (); 0 broken", FILES, S), {
		status: "unavailable",
		reason: "the rule pack had no rules (no team index loaded)",
	});
	const full = { ...pack(FILES), result: '{\n  "generator": "code",\n  "rules": [\n    {"id": "eng.rule.a"}\n  ]\n}' };
	assert.deepEqual(judgeKnowledge([full], "", FILES, S), { status: "checked" });
});

test("judgeKnowledge: callers pass current paths, so a renamed file is covered under its new name", () => {
	assert.deepEqual(judgeKnowledge([pack(["src/new.cs"])], "", ["src/new.cs"], S), { status: "checked" });
});

test("judgeKnowledge: unavailable when every knowledge call failed", () => {
	assert.deepEqual(judgeKnowledge([pack(FILES, true)], "x\nKNOWLEDGE: unavailable - connection closed\nVERDICT: PASS", FILES, S), {
		status: "unavailable",
		reason: "connection closed",
	});
});

const JUDGE_TEXT = [
	"src/c.cs:9 - major - [bug] null check missing",
	"  Why: x",
	"  Fix: y",
	"src/a.cs:3 - minor - [knowledge eng.rule.x] deviation from a recommended rule",
	"  Rule: keep it short.",
	"  Code: it is long.",
	"  Reason: generated code.",
	"  Impact: harder to read.",
	"  To follow it: split it.",
	"src/b.cs:5 - minor - [knowledge eng.rule.y] deviation from a recommended rule",
	"  Rule: r",
	"  Code: c",
	"  Reason: none given",
	"  To follow it: f",
	"src/a.cs:3 - minor - [knowledge eng.rule.x] deviation from a recommended rule",
	"  Rule: keep it short.",
	"  Code: it is long.",
	"  Reason: generated code.",
	"  Impact: harder to read.",
	"  To follow it: split it.",
	"VERDICT: FAIL",
].join("\n");

test("parseDeviations reads the five fields and drops repeats", () => {
	const devs = parseDeviations(JUDGE_TEXT);
	assert.equal(devs.length, 2);
	assert.deepEqual(devs[0], {
		where: "src/a.cs:3",
		id: "eng.rule.x",
		rule: "keep it short.",
		code: "it is long.",
		reason: "generated code.",
		impact: "harder to read.",
		follow: "split it.",
	});
	assert.equal(devs[1].id, "eng.rule.y");
	assert.equal(devs[1].impact, "");
});

test("deviationBlock lists each deviation; empty without any", () => {
	assert.equal(
		deviationBlock(parseDeviations(JUDGE_TEXT)),
		[
			"Knowledge deviations:",
			"- eng.rule.x at src/a.cs:3: it is long; reason: generated code; impact: harder to read",
			"- eng.rule.y at src/b.cs:5: c; reason: none given; impact: not stated",
		].join("\n"),
	);
	assert.equal(deviationBlock([]), "");
});

test("mergeKnowledgePass keeps one verdict, FAIL when either fails or has none", () => {
	const failed = mergeKnowledgePass("a\nVERDICT: PASS", "b\nVERDICT: FAIL");
	assert.equal(failed.match(/VERDICT:/g)?.length, 1);
	assert.ok(failed.endsWith("VERDICT: FAIL"));
	assert.ok(mergeKnowledgePass("a\nVERDICT: PASS", "b\nVERDICT: PASS").endsWith("VERDICT: PASS"));
	assert.ok(mergeKnowledgePass("a\nVERDICT: PASS", "b").endsWith("VERDICT: FAIL"));
});

test("knowledgeFooter", () => {
	assert.equal(knowledgeFooter({ status: "checked" }, 0), "Knowledge: checked.");
	assert.equal(knowledgeFooter({ status: "checked" }, 2), "Knowledge: checked; 2 recommended-rule deviation(s) above go into the commit message.");
	assert.equal(knowledgeFooter({ status: "unavailable", reason: "x." }, 0), "Knowledge: not checked - x.");
});

test("recheckKnowledgeFiles: scoped to changed files only after a checked round", () => {
	const all = ["src/a.ts", "src/b.ts"];
	assert.deepEqual(recheckKnowledgeFiles(true, ["src/a.ts"], all), { files: ["src/a.ts"], scoped: true });
	assert.deepEqual(recheckKnowledgeFiles(false, ["src/a.ts"], all), { files: all, scoped: false });
	assert.deepEqual(recheckKnowledgeFiles(true, ["src/c.ts"], ["src/a.ts"]), { files: ["src/a.ts"], scoped: false });
	assert.deepEqual(recheckKnowledgeFiles(true, ["sub/x.ts"], ["x.ts"]), { files: ["x.ts"], scoped: true });
	assert.deepEqual(recheckKnowledgeFiles(true, ["src\\a.ts"], ["src/a.ts"]), { files: ["src/a.ts"], scoped: true });
});

test("judgeKnowledge prompt: scoped re-check names the changed files", () => {
	const scoped = knowledgePrompt("knowledge", true, ["a.ts"], true);
	assert.match(scoped, /changed since the last round/);
	assert.match(scoped, /carry over/);
	assert.doesNotMatch(scoped, /the whole change, not only/);
	assert.match(knowledgePrompt("knowledge", true, ["a.ts"]), /the whole change, not only/);
});
