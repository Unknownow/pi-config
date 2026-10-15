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
import { listText, parseEditors, removeSet, type RemoveEnv } from "./manage.ts";

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
