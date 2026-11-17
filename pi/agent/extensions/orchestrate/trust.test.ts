// node --experimental-strip-types --test trust.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Run, Sub } from "./brief.ts";
import { readSpawnRegistry, withoutSpawnEntries, withSpawnEntry, writeSpawnRegistry, type SpawnEntry } from "./store.ts";
import { decideTrust, trustStep, type TrustDeps } from "./trust.ts";

const NOW = Date.parse("2026-01-01T00:10:00Z");
const COMMON = "C:/Work/Repo/.git";
const TOP = "C:/Work/Repo-wt/o1-a";
const sub = (state: Sub["state"], o: Partial<Sub> = {}): Sub => ({ id: "a", goal: "g", criteria: [], owns: ["x"], forbids: [], dependsOn: [], decisions: [], name: "o1-a", cwd: TOP, state, ...o });
const run = (subs: Sub[], o: Partial<Run> = {}): Run => ({ v: 1, id: "o1", title: "t", created: "", owner: { pid: 1, host: "h", session: "s" }, state: "active", originTrusted: true, subs, ...o });
const entry = (o: Partial<SpawnEntry> = {}): SpawnEntry => ({ runId: "o1", common: COMMON, sub: "a", state: "spawned", at: new Date(NOW - 60_000).toISOString(), tops: [TOP], ...o });
const at = (top = TOP, cwd = top) => ({ cwd, top, common: COMMON });

test("trustStep: yes for a registered worktree, whatever the path spelling", () => {
	const runs = [run([sub("spawned")])];
	assert.equal(trustStep(at(), [entry()], runs, NOW), "yes");
	assert.equal(trustStep(at(String.raw`C:\Work\Repo-wt\o1-a`), [entry()], runs, NOW), "yes");
	assert.equal(trustStep(at(`${TOP}/`), [entry()], runs, NOW), "yes");
	assert.equal(trustStep(at(TOP, `${TOP}/src/deep`), [entry()], runs, NOW), "yes");
	assert.equal(trustStep(at("c:/work/repo-wt/o1-a"), [entry()], runs, NOW), process.platform === "win32" ? "yes" : "undecided");
	assert.equal(trustStep(at("D:/other"), [entry({ tops: ["D:/other"] })], [run([sub("awaiting-acceptance")])], NOW), "yes");
	for (const state of ["planning", "executing"] as const) assert.equal(trustStep(at(), [entry()], [run([sub(state)])], NOW), "yes");
});

test("trustStep: a matching run.json without a registry entry is undecided (a repository can ship its own run.json)", () => {
	assert.equal(trustStep(at(), [], [run([sub("spawned")])], NOW), "undecided");
	assert.equal(trustStep(at(), [entry({ runId: "other" })], [run([sub("spawned")])], NOW), "undecided");
	assert.equal(trustStep(at(), [entry({ common: "D:/elsewhere/.git" })], [run([sub("spawned")])], NOW), "undecided");
	assert.equal(trustStep(at(), [entry({ sub: "b" })], [run([sub("spawned")])], NOW), "undecided");
});

test("trustStep: undecided without a match, with an untrusted origin, a finished sub, or a cwd outside the top", () => {
	assert.equal(trustStep(at("C:/elsewhere"), [entry()], [run([sub("spawned")])], NOW), "undecided");
	assert.equal(trustStep(at(), [entry()], [], NOW), "undecided");
	assert.equal(trustStep(at(), [entry()], [run([sub("spawned")], { originTrusted: false })], NOW), "undecided");
	assert.equal(trustStep(at(), [entry()], [run([sub("spawned")], { originTrusted: undefined })], NOW), "undecided");
	assert.equal(trustStep(at(), [entry()], [run([sub("merged")])], NOW), "undecided");
	assert.equal(trustStep(at(), [entry()], [run([sub("planned")])], NOW), "undecided");
	assert.equal(trustStep(at(TOP, "C:/Work"), [entry()], [run([sub("spawned")])], NOW), "undecided");
});

test("trustStep: poll while a fresh spawn is registered, undecided when it is stale or of another repo", () => {
	const fresh = entry({ state: "spawning", tops: [], at: new Date(NOW - 30_000).toISOString() });
	const old = entry({ state: "spawning", tops: [], at: new Date(NOW - 4 * 60_000).toISOString() });
	assert.equal(trustStep(at("C:/new"), [fresh], [], NOW), "poll");
	assert.equal(trustStep(at("C:/new"), [old], [], NOW), "undecided");
	assert.equal(trustStep(at("C:/new"), [{ ...fresh, common: "D:/x/.git" }], [], NOW), "undecided");
	assert.equal(trustStep(at("C:/new"), [{ ...fresh, at: "garbage" }], [], NOW), "undecided");
});

function deps(o: { runs?: () => Run[]; spawned?: () => SpawnEntry[]; located?: { common: string; top: string } | null }): TrustDeps & { clock: { t: number } } {
	const clock = { t: NOW };
	return {
		clock,
		locate: async () => (o.located === undefined ? { common: COMMON, top: TOP } : o.located),
		listRuns: () => (o.runs ?? (() => []))(),
		listSpawned: () => (o.spawned ?? (() => []))(),
		sleep: async (ms) => void (clock.t += ms),
		now: () => clock.t,
	};
}

test("decideTrust: a match at once; a spawn that finishes during the poll; a /resume into the worktree", async () => {
	assert.equal(await decideTrust(deps({ runs: () => [run([sub("spawned")])], spawned: () => [entry()] }), TOP), "yes");
	assert.equal(await decideTrust(deps({ runs: () => [run([sub("executing")])], spawned: () => [entry()] }), `${TOP}/src`), "yes");
	const d = deps({});
	let polls = 0;
	d.listSpawned = () => {
		polls++;
		return [polls < 4 ? entry({ state: "spawning", tops: [], at: new Date(d.clock.t - 1000).toISOString() }) : entry()];
	};
	d.listRuns = () => [run([sub("spawned")])];
	assert.equal(await decideTrust(d, TOP), "yes");
	assert.equal(polls, 4);
});

test("decideTrust: undecided without a repo, without an entry, after 15 s of polling, or when reading throws", async () => {
	assert.equal(await decideTrust(deps({ runs: () => [run([sub("spawned")])], spawned: () => [entry()], located: null }), TOP), "undecided");
	assert.equal(await decideTrust(deps({}), TOP), "undecided");
	assert.equal(await decideTrust(deps({ runs: () => [run([sub("spawned")])] }), TOP), "undecided");
	const d = deps({});
	let polls = 0;
	d.listSpawned = () => {
		polls++;
		return [entry({ state: "spawning", tops: [], at: new Date(d.clock.t - 1000).toISOString() })];
	};
	assert.equal(await decideTrust(d, TOP), "undecided");
	assert.ok(d.clock.t - NOW <= 15_000);
	assert.ok(polls >= 25 && polls <= 31, String(polls));
	d.listSpawned = () => {
		throw new Error("unreadable");
	};
	assert.equal(await decideTrust(d, TOP), "undecided");
});

test("the registry: missing or unreadable means empty; add, replace and remove entries", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-reg-"));
	assert.deepEqual(readSpawnRegistry(dir), []);
	fs.writeFileSync(path.join(dir, "orchestrate-spawned.json"), "{nope");
	assert.deepEqual(readSpawnRegistry(dir), []);
	let list = withSpawnEntry([], entry({ state: "spawning", tops: [] }));
	list = withSpawnEntry(list, entry());
	list = withSpawnEntry(list, entry({ sub: "b", tops: ["D:/b"] }));
	assert.equal(list.length, 2);
	assert.equal(list.find((e) => e.sub === "a")?.state, "spawned");
	writeSpawnRegistry(dir, list);
	assert.deepEqual(readSpawnRegistry(dir), list);
	assert.deepEqual(withoutSpawnEntries(list, "o1", "a").map((e) => e.sub), ["b"]);
	assert.deepEqual(withoutSpawnEntries(list, "o1"), []);
	assert.equal(withoutSpawnEntries(list, "other").length, 2);
});
