// node --experimental-strip-types --test manage.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { defaults } from "./config.ts";
import { setupFiles } from "./files.ts";
import type { Git } from "./git-ops.ts";
import { SWEEP_SCRIPT, detectSession, finishSet, listText, openPlan, parseEditors, quitReminder, removeSet, repoDirsIn, type DoneEnv, type RemoveEnv } from "./manage.ts";

const git: Git = async (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
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
	const env: RemoveEnv = { git, cfg, cwd: `${d}/repo`, added: [], hasUI: true, confirm: async () => true };
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

test("removeSet removes a clean set and keeps the link target", async () => {
	const f = fixture();
	const r = await removeSet(f.env, "s1");
	assert.equal(r.error, false, r.text);
	assert.ok(!fs.existsSync(f.wt));
	assert.ok(!fs.existsSync(`${f.cfg.root}/s1`));
	assert.equal(fs.readFileSync(`${f.d}/repo/.pi/git/keep.txt`, "utf8"), "keep");
	assert.equal(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]).trim(), "");
});

test("removeSet refuses dirty and unpushed work and changes nothing", async () => {
	const f = fixture();
	fs.writeFileSync(`${f.wt}/new.txt`, "x");
	let r = await removeSet(f.env, "s1");
	assert.ok(r.error);
	assert.match(r.text, /uncommitted/);
	run(f.wt, ["add", "new.txt"]);
	run(f.wt, [...f.id, "commit", "-m", "c"]);
	r = await removeSet(f.env, "s1");
	assert.match(r.text, /1 commit\(s\) not pushed/);
	assert.ok(fs.existsSync(f.wt));
});

test("removeSet refuses from inside the set, without UI, and when cancelled", async () => {
	const f = fixture();
	assert.match((await removeSet({ ...f.env, cwd: `${f.wt}/unity` }, "s1")).text, /uses/);
	assert.match((await removeSet({ ...f.env, added: [f.wt] }, "s1")).text, /uses/);
	assert.match((await removeSet({ ...f.env, hasUI: false }, "s1")).text, /needs a UI/);
	assert.equal((await removeSet({ ...f.env, confirm: async () => false }, "s1")).text, "Cancelled.");
	assert.match((await removeSet(f.env, "nope")).text, /No worktree set/);
	assert.ok(fs.existsSync(f.wt));
});

test("removeSet rejects names that leave the root", async () => {
	const f = fixture();
	const r = await removeSet(f.env, "..");
	assert.ok(r.error);
	assert.ok(fs.existsSync(`${f.d}/repo/.pi/git/keep.txt`));
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

const fold = (p: string) => p.split(String.fromCharCode(92)).join("/").replace(/\/+$/, "").toLowerCase();

async function doneEnv(f: ReturnType<typeof fixture>, over: Partial<DoneEnv> = {}, left: { to?: string } = {}): Promise<DoneEnv> {
	return { ...f.env, cwd: f.wt, session: await detectSession(git, f.cfg, f.wt), editors: [], leave: (to) => { left.to = to; }, ...over };
}

test("finishSet removes the set it runs in, keeps link targets, leaves for the main repo", async () => {
	const f = fixture();
	const left: { to?: string } = {};
	const r = await finishSet(await doneEnv(f, {}, left));
	assert.equal(r.error, false, r.text);
	assert.equal(r.removed, true);
	assert.deepEqual(r.leftovers, []);
	assert.ok(!fs.existsSync(f.wt));
	assert.ok(!fs.existsSync(`${f.cfg.root}/s1`));
	assert.equal(fs.readFileSync(`${f.d}/repo/.pi/git/keep.txt`, "utf8"), "keep");
	assert.equal(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]).trim(), "");
	assert.equal(fold(left.to ?? ""), fold(`${f.d}/repo`));
});

test("finishSet refuses outside a session, without UI, with an open Editor, and with dirty or unpushed work", async () => {
	const f = fixture();
	const left: { to?: string } = {};
	const expectRefused = (r: Awaited<ReturnType<typeof finishSet>>, re: RegExp) => {
		assert.equal(r.error, true);
		assert.equal(r.removed, false);
		assert.match(r.text, re);
		assert.ok(fs.existsSync(f.wt));
		assert.equal(left.to, undefined);
	};
	expectRefused(await finishSet(await doneEnv(f, { session: null }, left)), /\/wt remove/);
	expectRefused(await finishSet(await doneEnv(f, { hasUI: false }, left)), /needs a UI/);
	expectRefused(await finishSet(await doneEnv(f, { editors: [`${f.wt}/unity`] }, left)), /Unity Editor open/);
	fs.writeFileSync(`${f.wt}/x.txt`, "x");
	expectRefused(await finishSet(await doneEnv(f, {}, left)), /Nothing removed/);
	run(f.wt, ["add", "x.txt"]);
	run(f.wt, [...f.id, "commit", "-m", "x"]);
	expectRefused(await finishSet(await doneEnv(f, {}, left)), /not pushed/);
});

test("finishSet: cancel keeps everything", async () => {
	const f = fixture();
	const left: { to?: string } = {};
	const r = await finishSet(await doneEnv(f, { confirm: async () => false }, left));
	assert.equal(r.error, false);
	assert.equal(r.removed, false);
	assert.equal(r.text, "Cancelled.");
	assert.ok(fs.existsSync(f.wt));
	assert.equal(left.to, undefined);
});

test("finishSet removes the working repo last", async () => {
	const f = fixture();
	run(f.d, ["init", "--bare", "-b", "main", "origin2.git"]);
	run(f.d, ["clone", "origin2.git", "zzz"]);
	fs.writeFileSync(`${f.d}/zzz/a.txt`, "a");
	run(`${f.d}/zzz`, ["add", "a.txt"]);
	run(`${f.d}/zzz`, [...f.id, "commit", "-m", "i"]);
	run(`${f.d}/zzz`, ["push", "origin", "HEAD:main"]);
	run(`${f.d}/zzz`, ["fetch", "origin"]);
	run(`${f.d}/zzz`, ["remote", "set-head", "origin", "main"]);
	run(`${f.d}/zzz`, ["worktree", "add", "--no-track", "-b", "wt/s1", `${f.cfg.root}/s1/zzz`, "origin/main"]);
	const order: string[] = [];
	const spy: Git = async (cwd, args) => {
		if (args[0] === "worktree" && args[1] === "remove") order.push(fold(args[2]));
		return git(cwd, args);
	};
	const r = await finishSet(await doneEnv(f, { git: spy }));
	assert.equal(r.error, false, r.text);
	assert.deepEqual(order, [fold(`${f.cfg.root}/s1/zzz`), fold(f.wt)]);
});

test("finishSet treats an in-use folder as removed and leaves it to the sweeper", async () => {
	const f = fixture();
	const flaky: Git = async (cwd, args) => {
		const r = await git(cwd, args);
		if (args[0] === "worktree" && args[1] === "remove") {
			fs.mkdirSync(`${args[2]}/sub`, { recursive: true });
			return { code: 1, stdout: "", stderr: "error: failed to delete" };
		}
		return r;
	};
	const r = await finishSet(await doneEnv(f, { git: flaky }));
	assert.equal(r.error, false, r.text);
	assert.equal(r.removed, true);
	assert.deepEqual(r.leftovers, [f.wt, `${f.cfg.root}/s1`]);
	assert.match(r.text, /deleted after pi exits/);
	assert.equal(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]).trim(), "");
	spawnSync(process.execPath, ["-e", SWEEP_SCRIPT, "1", "0", ...r.leftovers]);
	assert.ok(!fs.existsSync(f.wt));
	assert.ok(!fs.existsSync(`${f.cfg.root}/s1`));
});

test("finishSet stops when the worktree stays registered", async () => {
	const f = fixture();
	const stuck: Git = async (cwd, args) => (args[0] === "worktree" && args[1] === "remove" ? { code: 1, stdout: "", stderr: "nope" } : git(cwd, args));
	const r = await finishSet(await doneEnv(f, { git: stuck }));
	assert.equal(r.error, true);
	assert.equal(r.removed, false);
	assert.match(r.text, /Stopped at/);
	assert.ok(fs.existsSync(f.wt));
	assert.match(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]), /wt\/s1/);
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

const inUse: Git = async (cwd, args) => {
	const r = await git(cwd, args);
	if (args[0] === "worktree" && args[1] === "remove") {
		fs.mkdirSync(`${args[2]}/sub`, { recursive: true });
		return { code: 1, stdout: "", stderr: "error: failed to delete" };
	}
	return r;
};

test("removeSet still stops when a folder is in use", async () => {
	const f = fixture();
	const r = await removeSet({ ...f.env, git: inUse }, "s1");
	assert.equal(r.error, true);
	assert.match(r.text, /Stopped at/);
	assert.doesNotMatch(r.text, /deleted after pi exits/);
});

test("finishSet stops when worktree list fails", async () => {
	const f = fixture();
	const broken: Git = async (cwd, args) => (args[0] === "worktree" && args[1] === "list" ? { code: 1, stdout: "", stderr: "x" } : inUse(cwd, args));
	const r = await finishSet(await doneEnv(f, { git: broken }));
	assert.equal(r.error, true);
	assert.match(r.text, /Stopped at/);
	assert.match(run(`${f.d}/repo`, ["branch", "--list", "wt/s1"]), /wt\/s1/);
});

test("finishSet sweeps the set folder when pi runs in a plain folder of the set", async () => {
	const f = fixture();
	fs.mkdirSync(`${f.cfg.root}/s1/plain`);
	const r = await finishSet(await doneEnv(f, { cwd: `${f.cfg.root}/s1/plain` }));
	assert.equal(r.error, false, r.text);
	assert.ok(r.leftovers.includes(`${f.cfg.root}/s1`));
});

test("finishSet reports an exception instead of throwing", async () => {
	const f = fixture();
	const boom: Git = async (cwd, args) => {
		if (args[0] === "worktree" && args[1] === "remove") throw new Error("boom");
		return git(cwd, args);
	};
	const r = await finishSet(await doneEnv(f, { git: boom }));
	assert.equal(r.error, true);
	assert.match(r.text, /Stopped at .*boom/);
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
