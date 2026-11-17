// node --experimental-strip-types --test knowledge.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolCall } from "../agents/api.ts";

// knowledge.ts reads findings and tool names through agents/api.ts, which loads the pi packages: stub them first.
await import("./test-hooks.ts");
const { covers, deviationBlock, judgeKnowledge, knowledgeFooter, parseDeviations } = await import("./knowledge.ts");
const { parseFindings } = await import("../agents/api.ts");

const FILES = ["src/a.cs", "src/b.cs"];
const S = "knowledge";
const pack = (paths: unknown, isError: boolean | undefined = false, name = "mcp__knowledge__get_rule_pack"): ToolCall => ({
	id: "1",
	name,
	args: paths === undefined ? { generator: "code" } : { generator: "code", paths },
	isError,
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

/** A judge reply in agents' findings format, with the knowledge step's deviation notes. */
const JUDGE_TEXT = [
	"- major - [bug] `src/c.cs:9` - null check missing fix: auto",
	"  Why: x",
	"  Fix: y",
	"- minor - [knowledge eng.rule.x] `src/a.cs:3` - deviation from a recommended rule fix: user",
	"  Rule: keep it short.",
	"  Code: it is long.",
	"  Reason: generated code.",
	"  Impact: harder to read.",
	"  To follow it: split it.",
	"- minor - [knowledge eng.rule.y] `src/b.cs:5` - deviation from a recommended rule fix: user",
	"  Rule: r",
	"  Code: c",
	"  Reason: none given",
	"  To follow it: f",
	"- minor - [knowledge eng.rule.x] `src/a.cs:3` - deviation from a recommended rule fix: user",
	"  Rule: keep it short.",
	"  Code: it is long.",
	"  Reason: generated code.",
	"  Impact: harder to read.",
	"  To follow it: split it.",
	"- major - [knowledge eng.rule.z] `src/d.cs:1` - the required rule about locks is broken fix: auto",
	"  Why: w",
	"KNOWLEDGE: checked 3 rules (eng.rule.x, eng.rule.y, eng.rule.z); 1 broken",
	"VERDICT: FAIL",
].join("\n");

test("parseDeviations reads the five fields from the findings and drops repeats; other knowledge findings are not deviations", () => {
	const devs = parseDeviations(parseFindings(JUDGE_TEXT));
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
	assert.deepEqual(parseDeviations(parseFindings("src/a.cs:3 - minor - [knowledge eng.rule.x] deviation from a recommended rule\n  Rule: r")), [], "the old format has no findings");
});

test("deviationBlock lists each deviation; empty without any", () => {
	assert.equal(
		deviationBlock(parseDeviations(parseFindings(JUDGE_TEXT))),
		[
			"Knowledge deviations:",
			"- eng.rule.x at src/a.cs:3: it is long; reason: generated code; impact: harder to read",
			"- eng.rule.y at src/b.cs:5: c; reason: none given; impact: not stated",
		].join("\n"),
	);
	assert.equal(deviationBlock([]), "");
});

test("knowledgeFooter", () => {
	assert.equal(knowledgeFooter({ status: "checked" }, 0), "Knowledge: checked.");
	assert.equal(knowledgeFooter({ status: "checked" }, 2), "Knowledge: checked; 2 recommended-rule deviation(s) above go into the commit message.");
	assert.equal(knowledgeFooter({ status: "unavailable", reason: "x." }, 0), "Knowledge: not checked - x.");
	assert.equal(knowledgeFooter({ status: "skipped", reason: "no get_rule_pack call" }, 0), "Knowledge: not checked - no get_rule_pack call.");
});

test("covers: a path matches itself, a suffix either way, and backslash or ./ forms", () => {
	assert.equal(covers(["src/a.ts"], "src/a.ts"), true);
	assert.equal(covers(["sub/x.ts"], "x.ts"), true);
	assert.equal(covers(["x.ts"], "sub/x.ts"), true);
	assert.equal(covers(["src\\a.ts"], "./src/a.ts"), true);
	assert.equal(covers(["src/c.ts"], "src/a.ts"), false);
	assert.equal(covers(["b.ts"], "ab.ts"), false);
});
