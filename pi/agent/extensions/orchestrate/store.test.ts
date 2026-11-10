// node --experimental-strip-types --test store.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Run } from "./brief.ts";
import { addAccepted, appendMessage, commonDir, findSubByToplevel, listActiveRuns, readAccepted, readCursor, readNew, readRun, readStatus, runDir, writeCursor, writeRun, writeStatus } from "./store.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-store-")).replace(/\\/g, "/");
const mkRun = (id: string, state: Run["state"] = "active", cwd = "C:/Work/Repo-wt/o1-a"): Run => ({
	v: 1, id, title: "t", created: "", owner: { pid: 1, host: "h", session: "s" }, state,
	subs: [{ id: "a", goal: "g", criteria: [], owns: ["x"], forbids: [], dependsOn: [], decisions: [], name: "o1-a", cwd, state: "spawned" }],
});

test("appendMessage and readNew with cursors", () => {
	const f = `${tmp()}/inbox.jsonl`;
	const m1 = appendMessage(f, "orch", { type: "info", text: "one" });
	appendMessage(f, "orch", { type: "answer", text: "two", replyTo: "a-1" });
	assert.equal(m1.id, "orch-1");
	const r1 = readNew(f, 0);
	assert.deepEqual(r1.msgs.map((m) => m.text), ["one", "two"]);
	assert.equal(r1.msgs[1].id, "orch-2");
	assert.equal(r1.cursor, 2);
	assert.deepEqual(readNew(f, r1.cursor).msgs, []);
	appendMessage(f, "orch", { type: "info", text: "three" });
	assert.deepEqual(readNew(f, 2).msgs.map((m) => m.text), ["three"]);
	assert.deepEqual(readNew(`${tmp()}/none`, 0), { msgs: [], cursor: 0, bad: 0 });
});

test("an unterminated last line is skipped, then read once completed", () => {
	const f = `${tmp()}/o.jsonl`;
	fs.writeFileSync(f, '{"v":1,"id":"a-1","ts":"x","type":"note","text":"ok"}\n{"v":1,"id":"a-2","ts"');
	const r = readNew(f, 0);
	assert.equal(r.msgs.length, 1);
	assert.equal(r.cursor, 1);
	fs.appendFileSync(f, ':"x","type":"note","text":"late"}\n');
	const r2 = readNew(f, r.cursor);
	assert.deepEqual(r2.msgs.map((m) => m.text), ["late"]);
	assert.equal(r2.cursor, 2);
});

test("a corrupt complete line is counted and skipped", () => {
	const f = `${tmp()}/o.jsonl`;
	fs.writeFileSync(f, 'garbage\n{"v":1,"id":"a-2","ts":"x","type":"note","text":"ok"}\n');
	const r = readNew(f, 0);
	assert.equal(r.bad, 1);
	assert.equal(r.msgs.length, 1);
});

test("run.json, status, cursor and accepted round-trip", () => {
	const common = tmp();
	writeRun(common, mkRun("o1-x"));
	writeRun(common, mkRun("o2-y", "ended"));
	assert.equal(readRun(common, "o1-x").run?.id, "o1-x");
	assert.deepEqual(listActiveRuns(common).runs.map((r) => r.id), ["o1-x"]);
	assert.ok(!fs.readdirSync(runDir(common, "o1-x")).some((n) => n.endsWith(".tmp")));
});

test("corrupt run.json is reported", () => {
	const common = tmp();
	fs.mkdirSync(runDir(common, "o9-bad"), { recursive: true });
	fs.writeFileSync(`${runDir(common, "o9-bad")}/run.json`, "{nope");
	const l = listActiveRuns(common);
	assert.equal(l.runs.length, 0);
	assert.equal(l.corrupt.length, 1);
	assert.ok(readRun(common, "o9-bad").corrupt);
});

test("status, cursor and accepted", () => {
	const d = tmp();
	writeStatus(`${d}/status.json`, { v: 1, phase: "plan", heartbeat: 5, pid: 1 });
	assert.equal(readStatus(`${d}/status.json`).status?.phase, "plan");
	assert.equal(readStatus(`${d}/missing.json`).status, undefined);
	assert.equal(readCursor(`${d}/c.json`), 0);
	writeCursor(`${d}/c.json`, 7);
	assert.equal(readCursor(`${d}/c.json`), 7);
	assert.deepEqual(readAccepted(`${d}/acc.json`), []);
	assert.equal(addAccepted(`${d}/acc.json`, "t1"), true);
	assert.equal(addAccepted(`${d}/acc.json`, "t1"), false);
	assert.equal(addAccepted(`${d}/acc.json`, "t2"), true);
	assert.deepEqual(readAccepted(`${d}/acc.json`), ["t1", "t2"]);
});

test("findSubByToplevel ignores case and slashes", () => {
	const runs = [mkRun("o1-x")];
	assert.equal(findSubByToplevel(runs, "c:\\work\\repo-wt\\O1-A\\", true)?.sub.id, "a");
	assert.equal(findSubByToplevel(runs, "C:/Work/Other", true), null);
	assert.equal(findSubByToplevel(runs, "c:/work/repo-wt/o1-a", false), null);
});

test("commonDir uses the exec it is given", async () => {
	const ok = async () => ({ stdout: "C:\\r\\.git\n", code: 0 });
	assert.equal(await commonDir(ok, "x"), "C:/r/.git");
	assert.equal(await commonDir(async () => ({ stdout: "", code: 128 }), "x"), null);
});
