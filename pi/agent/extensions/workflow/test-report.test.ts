// node --test test-report.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTestReport } from "./test-report.ts";

const expect = { nextId: 1, known: [] as string[], mustReport: [] as string[] };

const full = `Some preamble.
## Test report: login flow
Ran: unity run-tests EditMode → 12 passed, 1 failed
Ran: adb logcat check → clean
**S1.** [bug] Login crashes on empty name
  Repro: unity run-tests --filter Login
  Expected: shows an error (source: Assets/Login.cs:40)
  Actual: NullReferenceException
    in LoginForm.Submit
  Suspect: Assets/Login.cs:52
  Root cause: name is not null-checked
  Fix direction: guard the empty name
**S2.** [ask] Should guests log in?
  Question: allow guests?
  Options: a) yes b) no
**S3.** [blocked] Store sandbox
  Needs: a sandbox account
**S4.** [manual] Button feel
  Steps: tap the button
  Look for: lag
**S5.** [fixed] Old crash
  Evidence: passes now
VERDICT: BUGS
`;

test("a full report parses", () => {
	const r = parseTestReport(full, { nextId: 1, known: [], mustReport: [] });
	assert.ok(r);
	assert.equal(r.title, "login flow");
	assert.equal(r.verdict, "BUGS");
	assert.deepEqual(r.items.map((i) => i.tag), ["bug", "ask", "blocked", "manual", "fixed"]);
	assert.equal(r.ran.length, 2);
	assert.equal(r.items[0].fields.actual, "NullReferenceException\nin LoginForm.Submit");
	assert.equal(r.items[0].fields["root cause"], "name is not null-checked");
	assert.deepEqual(r.problems, []);
});

test("a bug without Root cause is a problem naming the ID", () => {
	const r = parseTestReport(full.replace("  Root cause: name is not null-checked\n", ""), expect);
	assert.ok(r?.problems.some((p) => p.startsWith("S1:") && /Root cause/.test(p)));
});

test("CLEAN with a bug is a problem", () => {
	const r = parseTestReport(full.replace("VERDICT: BUGS", "VERDICT: CLEAN"), expect);
	assert.ok(r?.problems.some((p) => /CLEAN/.test(p)));
});

test("no VERDICT or no heading gives null", () => {
	assert.equal(parseTestReport(full.replace("VERDICT: BUGS", ""), expect), null);
	assert.equal(parseTestReport("VERDICT: CLEAN", expect), null);
});

test("mustReport", () => {
	const r = parseTestReport(full, { nextId: 1, known: [], mustReport: ["S9"] });
	assert.ok(r?.problems.some((p) => p.startsWith("S9:")));
});

test("a new ID below nextId that is not known is a problem", () => {
	const text = "## Test report: x\nRan: a\n**S2.** [fixed] y\nVERDICT: CLEAN\n";
	assert.ok(parseTestReport(text, { nextId: 5, known: [], mustReport: [] })?.problems.some((p) => p.startsWith("S2:")));
	assert.deepEqual(parseTestReport(text, { nextId: 5, known: ["S2"], mustReport: [] })?.problems, []);
});

test("the three item line forms", () => {
	const text = "## Test report: x\nRan: a\n**S1.** [fixed] one\n- S2: [fixed] two\nS3) [fixed] three\nVERDICT: CLEAN\n";
	const r = parseTestReport(text, expect);
	assert.deepEqual(r?.items.map((i) => [i.id, i.title]), [["S1", "one"], ["S2", "two"], ["S3", "three"]]);
});

test("a duplicate ID keeps the first and is a problem", () => {
	const text = "## Test report: x\nRan: a\n**S1.** [fixed] one\n**S1.** [fixed] again\nVERDICT: CLEAN\n";
	const r = parseTestReport(text, expect);
	assert.equal(r?.items.length, 1);
	assert.equal(r?.items[0].title, "one");
	assert.ok(r?.problems.some((p) => /twice/.test(p)));
});

test("unknown tag and missing Ran", () => {
	const r = parseTestReport("## Test report: x\n**S1.** [nit] y\nVERDICT: CLEAN\n", expect);
	assert.ok(r?.problems.some((p) => /unknown tag/.test(p)));
	assert.ok(r?.problems.some((p) => /Ran/.test(p)));
});
