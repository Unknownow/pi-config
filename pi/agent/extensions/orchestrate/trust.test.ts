// node --experimental-strip-types --test trust.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run, Sub } from "./brief.ts";
import { decideTrust, trustStep, type TrustDeps } from "./trust.ts";

const NOW = Date.parse("2026-01-01T00:10:00Z");
const sub = (state: Sub["state"], o: Partial<Sub> = {}): Sub => ({ id: "a", goal: "g", criteria: [], owns: ["x"], forbids: [], dependsOn: [], decisions: [], name: "o1-a", cwd: "C:/Work/Repo-wt/o1-a", state, ...o });
const run = (subs: Sub[], o: Partial<Run> = {}): Run => ({ v: 1, id: "o1", title: "t", created: "", owner: { pid: 1, host: "h", session: "s" }, state: "active", originTrusted: true, subs, ...o });

test("trustStep: yes for a worktree of an active sub, whatever the path spelling", () => {
	assert.equal(trustStep("C:/Work/Repo-wt/o1-a", [run([sub("spawned")])], NOW), "yes");
	assert.equal(trustStep("c:/work/repo-wt/o1-a/", [run([sub("executing")])], NOW, ), process.platform === "win32" ? "yes" : "undecided");
	assert.equal(trustStep(String.raw`C:\Work\Repo-wt\o1-a`, [run([sub("planning")])], NOW), "yes");
	assert.equal(trustStep("D:/other", [run([sub("awaiting-acceptance", { worktrees: [{ key: "api", cwd: "D:/other" }] })])], NOW), "yes");
});

test("trustStep: undecided without a match, a trusted origin, or for a stale or finished sub", () => {
	assert.equal(trustStep("C:/elsewhere", [run([sub("spawned")])], NOW), "undecided");
	assert.equal(trustStep("C:/Work/Repo-wt/o1-a", [], NOW), "undecided");
	assert.equal(trustStep("C:/Work/Repo-wt/o1-a", [run([sub("spawned")], { originTrusted: false })], NOW), "undecided");
	assert.equal(trustStep("C:/Work/Repo-wt/o1-a", [run([sub("spawned")], { originTrusted: undefined })], NOW), "undecided");
	assert.equal(trustStep("C:/Work/Repo-wt/o1-a", [run([sub("merged")])], NOW), "undecided");
	assert.equal(trustStep("C:/Work/Repo-wt/o1-a", [run([sub("planned")])], NOW), "undecided");
});

test("trustStep: poll while a fresh spawn is under way, undecided when it is stale", () => {
	const fresh = new Date(NOW - 30_000).toISOString();
	const old = new Date(NOW - 4 * 60_000).toISOString();
	assert.equal(trustStep("C:/new", [run([sub("spawning", { spawningAt: fresh, cwd: undefined })])], NOW), "poll");
	assert.equal(trustStep("C:/new", [run([sub("spawning", { spawningAt: old, cwd: undefined })])], NOW), "undecided");
	assert.equal(trustStep("C:/new", [run([sub("spawning", { cwd: undefined })])], NOW), "undecided");
	assert.equal(trustStep("C:/new", [run([sub("spawning", { spawningAt: fresh, cwd: undefined })], { originTrusted: false })], NOW), "undecided");
});

function deps(o: { runs: () => Run[]; located?: { common: string; top: string } | null }): TrustDeps & { clock: { t: number } } {
	const clock = { t: NOW };
	return { clock, locate: async () => (o.located === undefined ? { common: "C:/Work/Repo/.git", top: "C:/new" } : o.located), listRuns: () => o.runs(), sleep: async (ms) => void (clock.t += ms), now: () => clock.t };
}

test("decideTrust: a match at once; a spawning sub that turns spawned during the poll", async () => {
	assert.equal(await decideTrust(deps({ runs: () => [run([sub("spawned", { cwd: "C:/new" })])] }), "C:/new"), "yes");
	const d = deps({ runs: () => [] });
	let polls = 0;
	d.listRuns = () => {
		polls++;
		return [run([polls < 4 ? sub("spawning", { cwd: undefined, spawningAt: new Date(d.clock.t - 1000).toISOString() }) : sub("spawned", { cwd: "C:/new" })])];
	};
	assert.equal(await decideTrust(d, "C:/new"), "yes");
	assert.equal(polls, 4);
});

test("decideTrust: undecided without a repo, without a run, after 15 s of polling, or when listing throws", async () => {
	assert.equal(await decideTrust(deps({ runs: () => [run([sub("spawned", { cwd: "C:/new" })])], located: null }), "C:/new"), "undecided");
	assert.equal(await decideTrust(deps({ runs: () => [] }), "C:/new"), "undecided");
	const d = deps({ runs: () => [] });
	let polls = 0;
	d.listRuns = () => {
		polls++;
		return [run([sub("spawning", { cwd: undefined, spawningAt: new Date(d.clock.t - 1000).toISOString() })])];
	};
	assert.equal(await decideTrust(d, "C:/new"), "undecided");
	assert.ok(d.clock.t - NOW <= 15_000);
	assert.ok(polls >= 25 && polls <= 31, String(polls));
	d.listRuns = () => {
		throw new Error("unreadable");
	};
	assert.equal(await decideTrust(d, "C:/new"), "undecided");
});
