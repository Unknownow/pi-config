// node --experimental-strip-types --test brief.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { kickoffText, makeRunId, readyToSpawn, renderBrief, setName, SET_NAME_RE, validatePackages, type PackageInput, type Run, type Sub } from "./brief.ts";

const pkg = (id: string, o: Partial<PackageInput> = {}): PackageInput => ({ id, goal: `do ${id}`, owns: [`src/${id}/**`], ...o });

test("validatePackages reports each problem", () => {
	assert.deepEqual(validatePackages([pkg("a"), pkg("b", { dependsOn: ["a"] })]), []);
	assert.match(validatePackages([pkg("a"), pkg("a", { owns: ["x"] })]).join("|"), /duplicate id "a"/);
	assert.match(validatePackages([pkg("a"), pkg("b", { dependsOn: ["zz"] })]).join("|"), /unknown dependency "zz"/);
	assert.match(validatePackages([pkg("a", { dependsOn: ["b"] }), pkg("b", { dependsOn: ["a"] })]).join("|"), /cycle/);
	assert.match(validatePackages([pkg("a", { owns: [] }), pkg("b")]).join("|"), /a: owns is empty/);
	assert.match(validatePackages([pkg("a", { owns: ["src/**"] }), pkg("b", { owns: ["SRC/**"] })]).join("|"), /both own/);
	assert.match(validatePackages([pkg("a")]).join("|"), /at least 2/);
	assert.match(validatePackages([pkg("A b"), pkg("b")]).join("|"), /bad id/);
});

const sub = (id: string, state: Sub["state"], dependsOn: string[] = []): Sub => ({ id, goal: `goal ${id}`, criteria: [`crit ${id}`], owns: [`src/${id}/**`], forbids: ["secret/**"], dependsOn, decisions: ["use X"], name: `o01020304-${id}`, state });
const run = (subs: Sub[]): Run => ({ v: 1, id: "o01020304-t", title: "T", created: "", owner: { pid: 1, host: "h", session: "s" }, state: "active", subs });

test("readyToSpawn follows dependencies", () => {
	assert.deepEqual(readyToSpawn(run([sub("a", "planned"), sub("b", "planned", ["a"])])), ["a"]);
	assert.deepEqual(readyToSpawn(run([sub("a", "merged"), sub("b", "planned", ["a"]), sub("c", "executing")])), ["b"]);
});

test("ids and set names", () => {
	const id = makeRunId("A very long title for the orchestrated run of many things", new Date(2026, 10, 11, 9, 5));
	assert.ok(id.length <= 30);
	assert.ok(id.startsWith("o11110905-"));
	assert.equal(makeRunId("!!!", new Date(2026, 0, 2, 3, 4)), "o01020304");
	const n = setName(id, "backend")!;
	assert.equal(n, "o11110905-backend");
	assert.ok(n.length <= 40 && SET_NAME_RE.test(n));
	assert.equal(setName(id, "Bad Id"), null);
});

test("renderBrief and kickoffText", () => {
	const r = run([sub("a", "planned"), sub("b", "planned", ["a"])]);
	const b = renderBrief(r.subs[0], r) + renderBrief(r.subs[1], r);
	for (const s of ["goal b", "crit b", "src/b/**", "secret/**", "use X", "src/a/**", "depends on a"]) assert.ok(b.includes(s), s);
	const k = kickoffText(r.subs[1], r, "C:/x/brief.md");
	assert.ok(k.includes("C:/x/brief.md") && k.includes("ask_orchestrator") && k.includes("secret/**"));
});

test("makeRunId moves on to the next minute when the stamp is taken", () => {
	const now = new Date(2026, 10, 11, 9, 5);
	const first = makeRunId("t", now);
	assert.equal(first, "o11110905-t");
	assert.equal(makeRunId("t", now, [first]), "o11110906-t");
	assert.equal(makeRunId("other", now, [first]), "o11110906-other");
	assert.equal(makeRunId("t", now, ["o11110905", "o11110906-x"]), "o11110907-t");
});
