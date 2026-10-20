// node --experimental-strip-types --test manage.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { defaults } from "./config.ts";
import { setupFiles } from "./files.ts";
import type { Gh, Git } from "./git-ops.ts";
import { writeMeta } from "./meta.ts";
import { SWEEP_SCRIPT, backupSet, classifySet, detectSession, discardPreview, listText, openPlan, parseEditors, quitReminder, removeWithConfirm, removeWorkspace, repoDirsIn, stamp, type FlowEnv, type WorkspaceEnv } from "./manage.ts";

const git: Git = async (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const noGh: Gh = async () => ({ code: 1, stdout: "", stderr: "no gh" });
const run = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();

/** A repo with a bare origin, one worktree `<root>/s1/repo` on wt/s1, and a linked `.pi/git` folder. */
function fixture() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "wtman-")).replace(/\\/g, "/");
	const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
	run(d, ["init", "--bare", "-b", "main", "origin.git"]);
	run(d, ["clone", "origin.git", "repo"]);
	fs.mkdirSync(`${d}/repo/.pi/git`, { recursive: true });
	fs.writeFileSync(`${d}/repo/.pi/git/keep.txt`, "keep");
	fs.writeFileSync(`${d}/repo/.gitignore`, ".pi/git/\n");
	run(`${d}/repo`, ["add", ".gitignore"]);
	run(`${d}/repo`, [...id, "commit", "-m", "i"]);
	run(`${d}/repo`, ["push", "origin", "HEAD:main"]);
	run(`${d}/repo`, ["fetch", "origin"]);
	run(`${d}/repo`, ["remote", "set-head", "origin", "main"]);
	const cfg = { ...defaults(d), root: `${d}/wt` };
	run(`${d}/repo`, ["worktree", "add", "--no-track", "-b", "wt/s1", `${cfg.root}/s1/repo`, "origin/main"]);
	setupFiles(`${d}/repo`, `${cfg.root}/s1/repo`, cfg);
	const env: WorkspaceEnv = { git, gh: noGh, cfg, inUse: () => null, editors: [] };
	return { d, cfg, env, wt: `${cfg.root}/s1/repo`, id };
}

test("parseEditors reads instances and tolerates bad input", () => {
	assert.deepEqual(parseEditors('{"data":{"instances":[{"project":"D:/a"},{}]}}'), ["D:/a"]);
	assert.equal(parseEditors("nope"), null);
	assert.equal(parseEditors("{}"), null);
});

test("listText shows branch, changes and editor state", async () => {
	const f = fixture();
	fs.mkdirSync(`${f.wt}/unity/Library`, { recursive: true });
	const text = await listText(git, f.cfg, [`${f.wt}/unity`]);
	assert.match(text, /s1:/);
	assert.match(text, /repo: wt\/s1, 0 changed, not pushed: 0 commits, Library: yes, Editor open: yes/);
	assert.match(await listText(git, f.cfg, null), /Editor open: unknown/);
	assert.match(await listText(git, { ...f.cfg, root: `${f.d}/none` }, null), /No worktree sets/);
});

test("detectSession finds a worktree session and ignores the original", async () => {
	const f = fixture();
	const { detectSession, worktreePrompt } = await import("./manage.ts");
	const s = await detectSession(git, f.cfg, `${f.wt}`);
	assert.equal(s?.setRoot, `${f.cfg.root}/s1`);
	assert.equal(s?.branch, "wt/s1");
	assert.match(worktreePrompt(s!), /belongs to another session/);
	assert.equal(await detectSession(git, f.cfg, `${f.d}/repo`), null);
	assert.equal(await detectSession(git, f.cfg, f.d), null);
});

test("default root works from a worktree session (parent taken from the main repo)", async () => {
	const f = fixture();
	const { detectSession, mainParent } = await import("./manage.ts");
	const cfg = defaults(f.d);
	run(`${f.d}/repo`, ["worktree", "add", "--no-track", "-b", "wt/s2", `${f.d}/wt/s2/repo`, "origin/main"]);
	const wt = `${f.d}/wt/s2/repo`;
	assert.equal((await mainParent(git, wt)).toLowerCase(), f.d.toLowerCase());
	assert.equal((await mainParent(git, `${f.d}/repo`)).toLowerCase(), f.d.toLowerCase());
	const s = await detectSession(git, cfg, wt);
	assert.equal(s?.setRoot.toLowerCase(), `${f.d}/wt/s2`.toLowerCase());
	assert.equal(await detectSession(git, defaults(`${f.d}/wt/s2`), wt), null);
	fs.mkdirSync(`${f.d}/repo/sub`);
	assert.equal(await detectSession(git, cfg, `${f.d}/repo/sub`), null);
});

test("sessionConfig gives the same default root in the original and in a worktree", async () => {
	const f = fixture();
	const { detectSession, sessionConfig } = await import("./manage.ts");
	run(`${f.d}/repo`, ["worktree", "add", "--no-track", "-b", "wt/s3", `${f.d}/wt/s3/repo`, "origin/main"]);
	const wt = `${f.d}/wt/s3/repo`;
	const inWt = await sessionConfig(git, `${f.d}/noagent`, wt);
	const inMain = await sessionConfig(git, `${f.d}/noagent`, `${f.d}/repo`);
	assert.equal(inWt.cfg.root, inMain.cfg.root);
	assert.ok(await detectSession(git, inWt.cfg, wt));
	assert.equal(await detectSession(git, inMain.cfg, `${f.d}/repo`), null);
});

test("detectSession covers a non-git folder inside a set", async () => {
	const f = fixture();
	const { detectSession } = await import("./manage.ts");
	fs.mkdirSync(`${f.cfg.root}/s9`, { recursive: true });
	const s = await detectSession(git, f.cfg, `${f.cfg.root}/s9`);
	assert.equal(s?.setRoot.toLowerCase(), `${f.cfg.root}/s9`.toLowerCase());
	assert.equal(s?.branch, "");
});


test("SWEEP_SCRIPT deletes only empty folders", () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "wtsweep-"));
	fs.mkdirSync(`${d}/a/b/c`, { recursive: true });
	fs.mkdirSync(`${d}/x/y`, { recursive: true });
	fs.writeFileSync(`${d}/x/y/file.txt`, "f");
	spawnSync(process.execPath, ["-e", SWEEP_SCRIPT, "1", "0", `${d}/a`, `${d}/x`]);
	assert.ok(!fs.existsSync(`${d}/a`));
	assert.ok(fs.existsSync(`${d}/x/y/file.txt`));
});


test("openPlan opens a one-repo set", () => {
	const { cfg, wt } = fixture();
	assert.deepEqual(openPlan(cfg, "s1", null), { cwd: wt, folders: [] });
});

test("openPlan errors", () => {
	const { cfg } = fixture();
	assert.deepEqual(openPlan(cfg, "", null), { error: "give a name: /wt open <name>" });
	assert.match((openPlan(cfg, "Bad!", null) as { error: string }).error, /bad name/);
	const e = (openPlan(cfg, "nope", null) as { error: string }).error;
	assert.match(e, /no worktree set "nope"/);
	assert.match(e, /sets: s1/);
});

test("openPlan with several repos", () => {
	const { cfg, wt } = fixture();
	fs.mkdirSync(`${cfg.root}/s1/other`, { recursive: true });
	fs.writeFileSync(`${cfg.root}/s1/other/.git`, "gitdir: x");
	const p = openPlan(cfg, "s1", "other") as { cwd: string; folders: string[] };
	assert.ok(p.cwd.endsWith("/s1/other"));
	assert.deepEqual(p.folders, [wt]);
	assert.deepEqual(openPlan(cfg, "s1", null), { choose: ["other", "repo"] });
});

test("quitReminder text", () => {
	assert.equal(quitReminder("D:/x/wt/s1"), 'Worktree set "s1" is still on disk: D:/x/wt/s1\n  reopen: /wt open s1   remove: /wt done (inside it) or /wt remove s1\n');
});

test("repoDirsIn", () => {
	const { cfg, wt } = fixture();
	assert.deepEqual(repoDirsIn(`${cfg.root}/s1`), [wt]);
	assert.deepEqual(repoDirsIn(`${cfg.root}/missing`), []);
});

const commit = (f: ReturnType<typeof fixture>, file = "c.txt") => {
	fs.writeFileSync(`${f.wt}/${file}`, file);
	run(f.wt, ["add", file]);
	run(f.wt, [...f.id, "commit", "-m", file]);
};

test("classifySet: delivered, has-work (commit and dirty), in-use, editor", async () => {
	const f = fixture();
	let st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "delivered", st.reason);
	assert.equal(st.repos[0].delivered, "base");
	fs.writeFileSync(`${f.wt}/new.txt`, "x");
	st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "has-work");
	assert.match(st.reason, /1 uncommitted change/);
	fs.unlinkSync(`${f.wt}/new.txt`);
	commit(f);
	st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "has-work");
	assert.match(st.reason, /repo has 1 unpushed commit/);
	assert.match(st.reason, /gh unavailable/);
	// precedence: in-use beats has-work
	st = await classifySet({ ...f.env, inUse: () => "in use by pi 42" }, "s1");
	assert.deepEqual([st.kind, st.reason], ["in-use", "in use by pi 42"]);
	st = await classifySet({ ...f.env, editors: [`${f.wt}/unity`] }, "s1");
	assert.equal(st.kind, "in-use");
	assert.match(st.reason, /Unity Editor/);
});

test("classifySet: a squash-merged PR counts as delivered", async () => {
	const f = fixture();
	commit(f);
	const head = run(f.wt, ["rev-parse", "HEAD"]).trim();
	const gh: Gh = async () => ({ code: 0, stdout: JSON.stringify([{ number: 9, headRefOid: head }]), stderr: "" });
	const st = await classifySet({ ...f.env, gh }, "s1");
	assert.equal(st.kind, "delivered");
	assert.match(st.reason, /PR #9/);
});

test("classifySet: broken and leftover", async () => {
	const f = fixture();
	writeMeta(`${f.cfg.root}/s1`, { v: 1, created: "x", branch: "wt/s1", repos: [{ main: `${f.d}/repo`, dir: "repo" }, { main: `${f.d}/other`, dir: "other" }] });
	let st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "broken");
	assert.match(st.reason, /other.*missing/);
	fs.rmSync(`${f.cfg.root}/s1/.pi-set.json`);
	fs.rmSync(`${f.d}/repo/.git/worktrees`, { recursive: true, force: true });
	st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "broken");
	assert.match(st.reason, /original repo/);
	// leftover: only empty folders and the metadata file
	fs.mkdirSync(`${f.cfg.root}/s2/repo/sub`, { recursive: true });
	writeMeta(`${f.cfg.root}/s2`, { v: 1, created: "x", branch: "wt/s2", repos: [{ main: `${f.d}/repo`, dir: "repo" }] });
	st = await classifySet(f.env, "s2");
	assert.equal(st.kind, "leftover");
	fs.writeFileSync(`${f.cfg.root}/s2/repo/file.txt`, "x");
	assert.equal((await classifySet(f.env, "s2")).kind, "broken");
});

test("removeWorkspace removes a delivered set, keeps link targets, and is a no-op the second time", async () => {
	const f = fixture();
	writeMeta(`${f.cfg.root}/s1`, { v: 1, created: "x", branch: "wt/s1", repos: [{ main: `${f.d}/repo`, dir: "repo" }] });
	const r = await removeWorkspace(f.env, "s1", { discard: false });
	assert.equal(r.error, false, r.text);
	assert.match(r.text, /^Removed set "s1":/);
	assert.ok(!fs.existsSync(f.wt));
	assert.ok(!fs.existsSync(`${f.cfg.root}/s1`));
	assert.equal(fs.readFileSync(`${f.d}/repo/.pi/git/keep.txt`, "utf8"), "keep");
	assert.equal(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]).trim(), "");
	const again = await removeWorkspace(f.env, "s1", { discard: false });
	assert.equal(again.error, false);
	assert.deepEqual(again.leftovers, []);
	assert.equal((await removeWorkspace(f.env, "..", { discard: false })).error, true);
});

test("removeWorkspace unlinks first, removes the worktree, then runs branch -D", async () => {
	const f = fixture();
	const calls: string[] = [];
	const spy: Git = async (cwd, args) => {
		if (args[0] === "worktree" && args[1] === "remove") calls.push(`remove (link present: ${fs.existsSync(`${f.wt}/.pi/git`)})`);
		if (args[0] === "branch") calls.push(args.slice(0, 3).join(" "));
		return git(cwd, args);
	};
	await removeWorkspace({ ...f.env, git: spy }, "s1", { discard: false });
	assert.deepEqual(calls, ["remove (link present: false)", "branch -D wt/s1"]);
});

test("removeWorkspace treats an in-use folder as removed and leaves it to the sweeper; stops when still registered", async () => {
	const f = fixture();
	const flaky: Git = async (cwd, args) => {
		const r = await git(cwd, args);
		if (args[0] === "worktree" && args[1] === "remove") {
			fs.mkdirSync(`${args[args.length - 1]}/sub`, { recursive: true });
			return { code: 1, stdout: "", stderr: "error: failed to delete" };
		}
		return r;
	};
	const r = await removeWorkspace({ ...f.env, git: flaky }, "s1", { discard: false });
	assert.equal(r.error, false, r.text);
	assert.deepEqual(r.leftovers, [f.wt, `${f.cfg.root}/s1`]);
	assert.match(r.text, /deleted after pi exits/);
	spawnSync(process.execPath, ["-e", SWEEP_SCRIPT, "1", "0", ...r.leftovers]);
	assert.ok(!fs.existsSync(`${f.cfg.root}/s1`));

	const g = fixture();
	const stuck: Git = async (cwd, args) => (args[0] === "worktree" && args[1] === "remove" ? { code: 1, stdout: "", stderr: "nope" } : git(cwd, args));
	const s = await removeWorkspace({ ...g.env, git: stuck }, "s1", { discard: false });
	assert.equal(s.error, true);
	assert.match(s.text, /Stopped at/);
	assert.ok(fs.existsSync(g.wt));
	assert.match(run(`${g.d}/repo`, ["branch", "--list", "wt/s1"]), /wt\/s1/);
	const boom: Git = async (cwd, args) => {
		if (args[0] === "worktree" && args[1] === "remove") throw new Error("boom");
		return git(cwd, args);
	};
	assert.match((await removeWorkspace({ ...g.env, git: boom }, "s1", { discard: false })).text, /Stopped at .*boom/);
});

test("discard: preview, backup refs for commits and tracked changes, then forced removal", async () => {
	const f = fixture();
	for (let i = 0; i < 12; i++) commit(f, `c${i}.txt`);
	fs.writeFileSync(`${f.wt}/.gitignore`, "changed\n");
	const st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "has-work");
	const preview = await discardPreview(git, st);
	assert.equal(preview.split("\n").filter((l) => /^ {2}[0-9a-f]{7}/.test(l)).length, 10);
	assert.match(preview, /12 commits in all/);
	assert.match(preview, /uncommitted change/);
	// a plain remove refuses a dirty worktree
	assert.equal((await removeWorkspace(f.env, "s1", { discard: false })).error, true);
	const ts = stamp(new Date(2026, 9, 21, 10, 5, 7));
	assert.equal(ts, "20261021-100507");
	const b = await backupSet(git, "s1", st, ts);
	assert.equal(b.error, undefined);
	assert.equal(b.lines.length, 2);
	const head = run(f.wt, ["rev-parse", "HEAD"]).trim();
	assert.equal(run(`${f.d}/repo`, ["rev-parse", `refs/wt-backup/s1/repo/${ts}`]).trim(), head);
	assert.match(run(`${f.d}/repo`, ["rev-parse", `refs/wt-backup/s1/repo/${ts}-wip`]).trim(), /^[0-9a-f]{40}$/);
	const r = await removeWorkspace(f.env, "s1", { discard: true });
	assert.equal(r.error, false, r.text);
	assert.ok(!fs.existsSync(f.wt));
	assert.equal(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]).trim(), "");
	assert.equal(run(`${f.d}/repo`, ["rev-parse", `refs/wt-backup/s1/repo/${ts}`]).trim(), head);
});

test("a failing backup stops before anything is discarded", async () => {
	const f = fixture();
	commit(f);
	const st = await classifySet(f.env, "s1");
	const fail: Git = async (cwd, args) => (args[0] === "update-ref" ? { code: 1, stdout: "", stderr: "denied" } : git(cwd, args));
	const b = await backupSet(fail, "s1", st, "20261021-100000");
	assert.match(b.error ?? "", /could not write/);
	assert.ok(fs.existsSync(f.wt));
});

test("a repo without a base branch is backed up (commits and tracked changes) before a discard", async () => {
	const f = fixture();
	run(`${f.d}/repo`, ["remote", "remove", "origin"]);
	commit(f);
	fs.writeFileSync(`${f.wt}/.gitignore`, "changed\n");
	const st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "has-work");
	assert.ok(st.repos[0].own >= 1);
	assert.ok(st.repos[0].dirty >= 1);
	const b = await backupSet(git, "s1", st, "20261021-120000");
	assert.equal(b.error, undefined);
	assert.equal(b.lines.length, 2);
	assert.equal(run(`${f.d}/repo`, ["rev-parse", "refs/wt-backup/s1/repo/20261021-120000"]).trim(), run(f.wt, ["rev-parse", "HEAD"]).trim());
	assert.match(run(`${f.d}/repo`, ["rev-parse", "refs/wt-backup/s1/repo/20261021-120000-wip"]).trim(), /^[0-9a-f]{40}$/);
});

test("a detached worktree whose set branch holds commits is has-work; a plain removal keeps the branch, a backup keeps its tip", async () => {
	const f = fixture();
	commit(f);
	const tip = run(f.wt, ["rev-parse", "HEAD"]).trim();
	run(f.wt, ["checkout", "--detach", "origin/main"]);
	const st = await classifySet(f.env, "s1");
	assert.equal(st.kind, "has-work");
	assert.match(st.reason, /branch wt\/s1 with commits not in HEAD/);
	assert.match(await discardPreview(git, st), /branch wt\/s1/);
	const kept = await removeWorkspace(f.env, "s1", { discard: false });
	assert.equal(kept.error, false, kept.text);
	assert.match(kept.text, /branch wt\/s1 kept/);
	assert.match(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]), /wt\/s1/);
	const g = fixture();
	commit(g);
	const gtip = run(g.wt, ["rev-parse", "HEAD"]).trim();
	run(g.wt, ["checkout", "--detach", "origin/main"]);
	const gst = await classifySet(g.env, "s1");
	const b = await backupSet(git, "s1", gst, "20261021-120000");
	assert.equal(b.error, undefined);
	assert.equal(run(`${g.d}/repo`, ["rev-parse", "refs/wt-backup/s1/repo/20261021-120000-branch"]).trim(), gtip);
	assert.ok(tip);
});

function flowEnv(f: ReturnType<typeof fixture>, over: Partial<FlowEnv> = {}, asked: string[] = []): FlowEnv {
	return { ...f.env, hasUI: true, confirm: async (t, m) => { asked.push(`${t}\n${m}`); return true; }, stage: () => {}, now: () => new Date(2026, 9, 21, 9, 0, 0), ...over };
}

test("removeWithConfirm: refusals change nothing", async () => {
	const f = fixture();
	const asked: string[] = [];
	assert.match((await removeWithConfirm(flowEnv(f, { hasUI: false }, asked), "s1")).text, /needs a UI/);
	assert.match((await removeWithConfirm(flowEnv(f, {}, asked), "nope")).text, /No worktree set/);
	assert.equal((await removeWithConfirm(flowEnv(f, {}, asked), "..")).error, true);
	const busy = await removeWithConfirm(flowEnv(f, { inUse: () => "in use by pi 3" }, asked), "s1");
	assert.match(busy.text, /s1 is in use by pi 3/);
	assert.deepEqual(asked, []);
	assert.ok(fs.existsSync(f.wt));
});

test("removeWithConfirm: a declined question removes nothing", async () => {
	const f = fixture();
	const no = async () => false;
	assert.equal((await removeWithConfirm(flowEnv(f, { confirm: no }), "s1")).text, "Cancelled.");
	assert.ok(fs.existsSync(f.wt));
	commit(f);
	assert.equal((await removeWithConfirm(flowEnv(f, { confirm: no }), "s1")).text, "Cancelled.");
	assert.ok(fs.existsSync(f.wt));
	assert.equal(run(f.d + "/repo", ["for-each-ref", "refs/wt-backup/"]).trim(), "");
});

test("removeWithConfirm: a delivered set needs one question; a set with work is backed up and discarded", async () => {
	const f = fixture();
	const asked: string[] = [];
	fs.mkdirSync(`${f.wt}/unity/Library`, { recursive: true });
	const ok = await removeWithConfirm(flowEnv(f, {}, asked), "s1");
	assert.equal(ok.removed, true, ok.text);
	assert.equal(asked.length, 1);
	assert.match(asked[0], /Remove worktree set "s1"\?/);
	assert.match(asked[0], /Library\/ will be deleted/);

	const g = fixture();
	commit(g);
	const q: string[] = [];
	const r = await removeWithConfirm(flowEnv(g, {}, q), "s1");
	assert.equal(r.removed, true, r.text);
	assert.match(q[0], /^Discard work in "s1"\?/);
	assert.match(q[0], /Files git doesn't track are not backed up/);
	assert.match(q[0], /kept 30 days/);
	assert.match(r.text, /refs\/wt-backup\/s1\/repo\/20261021-090000/);
	assert.ok(!fs.existsSync(g.wt));
	assert.equal(run(`${g.d}/repo`, ["rev-parse", "refs/wt-backup/s1/repo/20261021-090000"]).trim().length, 40);

	const h = fixture();
	commit(h);
	const failBackup: Git = async (cwd, args) => (args[0] === "update-ref" ? { code: 1, stdout: "", stderr: "denied" } : git(cwd, args));
	const bad = await removeWithConfirm(flowEnv(h, { git: failBackup }), "s1");
	assert.equal(bad.removed, false);
	assert.match(bad.text, /Nothing removed, backup failed/);
	assert.ok(fs.existsSync(h.wt));
});

test("removeWorkspace refuses a repo that got a commit after it was checked", async () => {
	const f = fixture();
	const st = await classifySet(f.env, "s1");
	const heads = Object.fromEntries(st.repos.map((r) => [r.dir, r.head]));
	assert.equal((await removeWorkspace(f.env, "s1", { discard: false, heads })).error, false);
	const g = fixture();
	const sg = await classifySet(g.env, "s1");
	commit(g);
	const r = await removeWorkspace(g.env, "s1", { discard: false, heads: Object.fromEntries(sg.repos.map((x) => [x.dir, x.head])) });
	assert.equal(r.error, true);
	assert.match(r.text, /new commits since it was checked/);
	assert.ok(fs.existsSync(g.wt));
	assert.match(run(`${g.d}/repo`, ["branch", "--list", "wt/s1"]), /wt\/s1/);
});

test("a repo whose counts could not be read still gets its HEAD backed up", async () => {
	const f = fixture();
	const st = await classifySet(f.env, "s1");
	st.repos[0].error = "git rev-list failed: x";
	const b = await backupSet(git, "s1", st, "20261021-130000");
	assert.equal(b.error, undefined);
	assert.equal(run(`${f.d}/repo`, ["rev-parse", "refs/wt-backup/s1/repo/20261021-130000"]).trim(), run(f.wt, ["rev-parse", "HEAD"]).trim());
	assert.match(await discardPreview(git, st), /HEAD is backed up/);
});

test("removeWorkspace stops when the set became in use after the check", async () => {
	const f = fixture();
	const r = await removeWorkspace({ ...f.env, inUse: () => "in use by pi 9" }, "s1", { discard: false });
	assert.equal(r.error, true);
	assert.match(r.text, /in use by pi 9/);
	assert.ok(fs.existsSync(f.wt));
});

test("a discard refuses a repo whose HEAD moved after the check", async () => {
	const f = fixture();
	const st = await classifySet(f.env, "s1");
	commit(f);
	const r = await removeWorkspace(f.env, "s1", { discard: true, heads: Object.fromEntries(st.repos.map((x) => [x.dir, x.head])) });
	assert.equal(r.error, true);
	assert.ok(fs.existsSync(f.wt));
});

test("a removal that stopped partway leaves a set that can be removed again", async () => {
	const f = fixture();
	run(f.d, ["clone", "origin.git", "other"]);
	run(`${f.d}/other`, ["remote", "set-head", "origin", "main"]);
	run(`${f.d}/other`, ["worktree", "add", "--no-track", "-b", "wt/s1", `${f.cfg.root}/s1/other`, "origin/main"]);
	const set = `${f.cfg.root}/s1`;
	writeMeta(set, { v: 1, created: "x", branch: "wt/s1", repos: [{ main: `${f.d}/repo`, dir: "repo" }, { main: `${f.d}/other`, dir: "other" }] });
	const failing: Git = async (cwd, args) => (args[0] === "worktree" && args[1] === "remove" && args.some((a) => a.endsWith("/repo")) ? { code: 1, stdout: "", stderr: "busy" } : git(cwd, args));
	const first = await removeWorkspace({ ...f.env, git: failing }, "s1", { discard: false });
	assert.equal(first.error, true);
	assert.ok(!fs.existsSync(`${set}/other`));
	const st = await classifySet(f.env, "s1");
	assert.notEqual(st.kind, "broken", st.reason);
	const second = await removeWorkspace(f.env, "s1", { discard: false });
	assert.equal(second.error, false, second.text);
	assert.ok(!fs.existsSync(set));
});
