// node --experimental-strip-types --test clean.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { backupTime, cleanFlow, deleteRemotes, describeItem, discoverMains, fetchAll, planClean, pool, remoteCandidates, runClean, type CleanEnv } from "./clean.ts";
import { defaults } from "./config.ts";
import type { Gh, Git } from "./git-ops.ts";
import { writeMeta } from "./meta.ts";

const git: Git = async (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const noGh: Gh = async () => ({ code: 1, stdout: "", stderr: "no gh" });
const run = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
const ID = ["-c", "user.name=t", "-c", "user.email=t@t"];

/** A repo with a bare origin and sets s1..s3 (worktrees on wt/sN), plus a prunable entry, an orphan merged branch and two backup refs. */
function fixture() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "wtclean-")).replace(/\\/g, "/");
	run(d, ["init", "--bare", "-b", "main", "origin.git"]);
	run(d, ["clone", "origin.git", "repo"]);
	fs.writeFileSync(`${d}/repo/a.txt`, "a");
	run(`${d}/repo`, ["add", "a.txt"]);
	run(`${d}/repo`, [...ID, "commit", "-m", "i"]);
	run(`${d}/repo`, ["push", "origin", "HEAD:main"]);
	run(`${d}/repo`, ["fetch", "origin"]);
	run(`${d}/repo`, ["remote", "set-head", "origin", "main"]);
	const cfg = { ...defaults(d), root: `${d}/wt` };
	const main = `${d}/repo`;
	for (const n of ["s1", "s2", "s3", "s4"]) run(main, ["worktree", "add", "--no-track", "-b", `wt/${n}`, `${cfg.root}/${n}/repo`, "origin/main"]);
	fs.writeFileSync(`${cfg.root}/s3/repo/work.txt`, "w");
	run(`${cfg.root}/s3/repo`, ["add", "work.txt"]);
	run(`${cfg.root}/s3/repo`, [...ID, "commit", "-m", "work"]);
	// stale entry: a worktree whose folder is gone
	run(main, ["worktree", "add", "-b", "other", `${d}/gone`, "origin/main"]);
	fs.rmSync(`${d}/gone`, { recursive: true, force: true });
	// orphan merged branch and an unmerged one
	run(main, ["branch", "wt/old", "origin/main"]);
	run(main, ["branch", "wt/unmerged", "wt/s3"]);
	// backups: one 40 days old, one 5 days old
	const at = (days: number) => {
		const t = new Date(Date.now() - days * 86400000);
		const p = (n: number) => String(n).padStart(2, "0");
		return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
	};
	const old = at(40);
	run(main, ["update-ref", `refs/wt-backup/x/repo/${old}`, "HEAD"]);
	run(main, ["update-ref", `refs/wt-backup/x/repo/${at(5)}`, "HEAD"]);
	const env: CleanEnv = { git, gh: noGh, cfg, inUse: (set) => (set.endsWith("/s4") ? "in use by pi 7" : null), editors: [], now: new Date() };
	return { d, main, cfg, env, old };
}

test("backupTime reads the suffix of backup refs", () => {
	assert.equal(backupTime("refs/wt-backup/s1/repo/20261021-100507")?.getTime(), new Date(2026, 9, 21, 10, 5, 7).getTime());
	assert.equal(backupTime("refs/wt-backup/s1/repo/20261021-100507-wip")?.getTime(), new Date(2026, 9, 21, 10, 5, 7).getTime());
	assert.equal(backupTime("refs/wt-backup/s1/repo/20261021-100507-branch")?.getTime(), new Date(2026, 9, 21, 10, 5, 7).getTime());
	assert.equal(backupTime("refs/wt-backup/s1/repo/latest"), null);
});

test("pool keeps order and runs at most n at a time", async () => {
	let live = 0;
	let peak = 0;
	const r = await pool([1, 2, 3, 4, 5, 6], 2, async (x) => {
		peak = Math.max(peak, ++live);
		await new Promise((res) => setTimeout(res, 5));
		live--;
		return x * 2;
	});
	assert.deepEqual(r, [2, 4, 6, 8, 10, 12]);
	assert.ok(peak <= 2);
});

test("discoverMains and fetchAll", async () => {
	const f = fixture();
	writeMeta(`${f.cfg.root}/s1`, { v: 1, created: "x", branch: "wt/s1", repos: [{ main: f.main, dir: "repo" }] });
	const mains = await discoverMains(git, f.cfg, [`${f.cfg.root}/s2/repo`, f.main]);
	assert.equal(mains.length, 1);
	assert.deepEqual(await fetchAll(git, mains), []);
	assert.equal((await fetchAll(git, [`${f.d}/nope`])).length, 1);
});

test("clean plan: delivered sets, stale entry, merged branch and old backup go; in-use and has-work stay", async () => {
	const f = fixture();
	const plan = await planClean(f.env, [f.main]);
	const names = plan.remove.filter((i) => i.kind === "set").map((i) => (i as { name: string }).name).sort();
	assert.deepEqual(names, ["s1", "s2"]);
	assert.equal(plan.remove.filter((i) => i.kind === "prune").length, 1, run(f.main, ["worktree", "list", "--porcelain"]));
	const branches = plan.remove.filter((i) => i.kind === "branch").map((i) => (i as { branch: string }).branch);
	assert.deepEqual(branches, ["wt/old"]);
	const backups = plan.remove.filter((i) => i.kind === "backup");
	assert.equal(backups.length, 1);
	assert.match((backups[0] as { ref: string }).ref, new RegExp(f.old));
	assert.equal(plan.kept.length, 2);
	assert.ok(plan.kept.some((k) => /^s3: repo has 1 unpushed commit.*\/wt remove s3 to discard/.test(k)), plan.kept.join("|"));
	assert.ok(plan.kept.some((k) => k === "s4: in use by pi 7"));
	// backupDays 0 keeps every backup
	const none = await planClean({ ...f.env, cfg: { ...f.cfg, backupDays: 0 } }, [f.main]);
	assert.equal(none.remove.filter((i) => i.kind === "backup").length, 0);
	for (const i of plan.remove) assert.ok(describeItem(i).length > 0);
});

test("a merged PR makes an orphan branch removable", async () => {
	const f = fixture();
	const tip = run(f.main, ["rev-parse", "wt/unmerged"]).trim();
	const gh: Gh = async (_cwd, args) => ({ code: 0, stdout: JSON.stringify(args.includes("wt/unmerged") ? [{ number: 4, headRefOid: tip }] : []), stderr: "" });
	const plan = await planClean({ ...f.env, gh }, [f.main]);
	const branches = plan.remove.filter((i) => i.kind === "branch").map((i) => (i as { branch: string }).branch).sort();
	assert.deepEqual(branches, ["wt/old", "wt/unmerged"]);
});

test("runClean removes the items, goes on after a failure and leaves the kept ones", async () => {
	const f = fixture();
	const plan = await planClean(f.env, [f.main]);
	const failOnce: Git = async (cwd, args) => (args[0] === "worktree" && args[1] === "prune" ? { code: 1, stdout: "", stderr: "locked" } : git(cwd, args));
	const res = await runClean({ git: failOnce, cfg: f.cfg }, plan.remove);
	assert.equal(res.failed.length, 1, res.failed.join(" | "));
	assert.match(res.failed[0], /locked/);
	assert.equal(res.done.length, plan.remove.length - 1);
	assert.ok(!fs.existsSync(`${f.cfg.root}/s1`));
	assert.ok(!fs.existsSync(`${f.cfg.root}/s2`));
	assert.ok(fs.existsSync(`${f.cfg.root}/s3/repo`));
	assert.ok(fs.existsSync(`${f.cfg.root}/s4/repo`));
	assert.equal(run(f.main, ["branch", "--list", "wt/old"]).trim(), "");
	assert.match(run(f.main, ["branch", "--list", "wt/unmerged"]), /wt\/unmerged/);
	assert.equal(run(f.main, ["for-each-ref", "refs/wt-backup/"]).trim().split("\n").length, 1);
	// second run plans only what is still there
	const again = await planClean(f.env, [f.main]);
	assert.deepEqual(again.remove.map((i) => i.kind), ["prune"]);
});

test("a branch that moved since the plan is not deleted", async () => {
	const f = fixture();
	const plan = await planClean(f.env, [f.main]);
	run(f.main, ["update-ref", "refs/heads/wt/old", run(f.main, ["rev-parse", "wt/s3"]).trim()]);
	const res = await runClean({ git, cfg: f.cfg }, plan.remove.filter((i) => i.kind === "branch"));
	assert.equal(res.failed.length, 1);
	assert.match(run(f.main, ["branch", "--list", "wt/old"]), /wt\/old/);
});

test("remote branches need a merged PR with the same tip and no worktree on them", async () => {
	const f = fixture();
	run(f.main, ["push", "origin", "wt/s3:refs/heads/wt/s3", "wt/unmerged:refs/heads/wt/unmerged", "wt/old:refs/heads/wt/old"]);
	run(f.main, ["fetch", "origin"]);
	const tips: Record<string, string> = {};
	for (const b of ["wt/s3", "wt/unmerged", "wt/old"]) tips[b] = run(f.main, ["rev-parse", `origin/${b}`]).trim();
	const gh: Gh = async (_cwd, args) => {
		const b = args[args.indexOf("--head") + 1];
		return { code: 0, stdout: JSON.stringify([{ number: 1, headRefOid: tips[b] }]), stderr: "" };
	};
	const items = await remoteCandidates({ ...f.env, gh }, [f.main]);
	// wt/s3 is checked out in a worktree: kept
	assert.deepEqual(items.map((i) => i.branch).sort(), ["wt/old", "wt/unmerged"]);
	assert.deepEqual(await remoteCandidates(f.env, [f.main]), []);
	// the remote branch moved after the plan: kept
	const moved = items.find((i) => i.branch === "wt/unmerged")!;
	const stale = await deleteRemotes(git, [{ ...moved, tip: "1".repeat(40) }]);
	assert.equal(stale.failed.length, 1);
	assert.match(run(f.main, ["ls-remote", "--heads", "origin", "wt/unmerged"]), /wt\/unmerged/);
	const res = await deleteRemotes(git, items);
	assert.equal(res.failed.length, 0, res.failed.join("|"));
	assert.equal(run(f.main, ["ls-remote", "--heads", "origin", "wt/old"]).trim(), "");
	const bad = await deleteRemotes(git, [{ main: f.main, branch: "wt/none", tip: "0".repeat(40) }]);
	assert.equal(bad.failed.length, 1);
});

test("cleanFlow without a UI makes no removal call, with a decline neither; with a yes it runs the plan", async () => {
	const f = fixture();
	const plan = await planClean(f.env, [f.main]);
	const calls: string[] = [];
	const spy: Git = async (cwd, args) => {
		calls.push(args.join(" "));
		return git(cwd, args);
	};
	const stage = () => {};
	const none = await cleanFlow({ git: spy, cfg: f.cfg }, plan, [], { hasUI: false, confirm: async () => true, stage });
	assert.equal(none.status, "no-ui");
	assert.match(none.text, /Will remove:/);
	assert.match(none.text, /nothing was removed/);
	const no = await cleanFlow({ git: spy, cfg: f.cfg }, plan, [], { hasUI: true, confirm: async () => false, stage });
	assert.equal(no.status, "cancelled");
	assert.deepEqual(calls, []);
	assert.ok(fs.existsSync(`${f.cfg.root}/s1/repo`));
	const yes = await cleanFlow({ git: spy, cfg: f.cfg }, plan, ["w: fetch failed"], { hasUI: true, confirm: async () => true, stage });
	assert.equal(yes.status, "ran");
	assert.match(yes.text, /Removed:/);
	assert.match(yes.text, /Warnings:/);
	assert.ok(calls.some((c) => c.startsWith("worktree remove")));
	assert.ok(!fs.existsSync(`${f.cfg.root}/s1`));
	const empty = await cleanFlow({ git: spy, cfg: f.cfg }, { remove: [], kept: ["s3: x"], mains: [] }, [], { hasUI: true, confirm: async () => true, stage });
	assert.equal(empty.status, "nothing");
});

test("deleting a branch also drops its branch.<name> config", async () => {
	const f = fixture();
	run(f.main, ["config", "branch.wt/old.remote", "origin"]);
	const plan = await planClean(f.env, [f.main]);
	await runClean({ git, cfg: f.cfg }, plan.remove.filter((i) => i.kind === "branch"));
	assert.equal(spawnSync("git", ["config", "--get", "branch.wt/old.remote"], { cwd: f.main, encoding: "utf8" }).stdout.trim(), "");
});
