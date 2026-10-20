// node --experimental-strip-types --test rename.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { defaults } from "./config.ts";
import type { Git } from "./git-ops.ts";
import { readMeta, writeMeta } from "./meta.ts";
import { renameSet } from "./rename.ts";

const git: Git = async (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const run = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();

function fixture() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "wtren-")).replace(/\\/g, "/");
	run(d, ["init", "--bare", "-b", "main", "origin.git"]);
	run(d, ["clone", "origin.git", "repo"]);
	fs.writeFileSync(`${d}/repo/a.txt`, "a");
	run(`${d}/repo`, ["add", "."]);
	run(`${d}/repo`, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "i"]);
	run(`${d}/repo`, ["push", "origin", "HEAD:main"]);
	run(`${d}/repo`, ["fetch", "origin"]);
	const cfg = { ...defaults(d), root: `${d}/wt` };
	run(`${d}/repo`, ["worktree", "add", "--no-track", "-b", "wt/w1", `${cfg.root}/w1/repo`, "origin/main"]);
	run(d, ["clone", "origin.git", "repo2"]);
	run(`${d}/repo2`, ["worktree", "add", "--no-track", "-b", "wt/w1", `${cfg.root}/w1/repo2`, "origin/main"]);
	writeMeta(`${cfg.root}/w1`, { v: 1, created: "x", branch: "wt/w1", repos: [{ main: `${d}/repo`, dir: "repo" }, { main: `${d}/repo2`, dir: "repo2" }] });
	return { d, cfg, env: { git, cfg, inUse: () => null } };
}

test("rename moves the worktree, the branch and the metadata", async () => {
	const f = fixture();
	const r = await renameSet(f.env, "w1", "w5");
	assert.equal(r.error, false, r.text);
	assert.ok(fs.existsSync(`${f.cfg.root}/w5/repo/a.txt`));
	assert.ok(!fs.existsSync(`${f.cfg.root}/w1`));
	assert.equal(run(`${f.cfg.root}/w5/repo`, ["branch", "--show-current"]).trim(), "wt/w5");
	assert.equal(readMeta(`${f.cfg.root}/w5`)?.branch, "wt/w5");
});

test("rename refuses bad, existing, used and pushed cases", async () => {
	const f = fixture();
	assert.equal((await renameSet(f.env, "w1", "Bad Name")).error, true);
	assert.equal((await renameSet(f.env, "nope", "w2")).error, true);
	fs.mkdirSync(`${f.cfg.root}/w2`);
	assert.match((await renameSet(f.env, "w1", "w2")).text, /already exists/);
	assert.match((await renameSet({ ...f.env, inUse: () => "in use by pi 7" }, "w1", "w3")).text, /in use by pi 7/);
	run(`${f.d}/repo`, ["branch", "wt/w4", "origin/main"]);
	assert.match((await renameSet(f.env, "w1", "w4")).text, /already exists/);
	run(`${f.cfg.root}/w1/repo`, ["push", "origin", "wt/w1"]);
	const r = await renameSet(f.env, "w1", "w6");
	assert.match(r.text, /branch is pushed/);
	assert.ok(fs.existsSync(`${f.cfg.root}/w1/repo`));
});

test("a failing branch rename puts everything back", async () => {
	const f = fixture();
	const failing: Git = async (cwd, args) => (args[0] === "branch" && args[1] === "-m" && args[2] === "wt/w1" ? { code: 1, stdout: "", stderr: "boom" } : git(cwd, args));
	const r = await renameSet({ ...f.env, git: failing }, "w1", "w7");
	assert.equal(r.error, true);
	assert.ok(fs.existsSync(`${f.cfg.root}/w1/repo/a.txt`));
	assert.ok(!fs.existsSync(`${f.cfg.root}/w7`));
	assert.equal(run(`${f.cfg.root}/w1/repo`, ["branch", "--show-current"]).trim(), "wt/w1");
});

test("a failing move of the second repo puts the first back", async () => {
	const f = fixture();
	const failing: Git = async (cwd, args) => (args[0] === "worktree" && args[1] === "move" && args[3].endsWith("/w7/repo2") ? { code: 1, stdout: "", stderr: "locked" } : git(cwd, args));
	const r = await renameSet({ ...f.env, git: failing }, "w1", "w7");
	assert.equal(r.error, true);
	assert.match(r.text, /everything was put back/);
	assert.equal(run(`${f.cfg.root}/w1/repo`, ["branch", "--show-current"]).trim(), "wt/w1");
	assert.ok(fs.existsSync(`${f.cfg.root}/w1/repo2/a.txt`));
	assert.ok(!fs.existsSync(`${f.cfg.root}/w7`));
});

test("an unreachable origin refuses the rename", async () => {
	const f = fixture();
	const off: Git = async (cwd, args) => (args[0] === "ls-remote" ? { code: 128, stdout: "", stderr: "offline" } : git(cwd, args));
	const r = await renameSet({ ...f.env, git: off }, "w1", "w8");
	assert.equal(r.error, true);
	assert.match(r.text, /could not check origin/);
	assert.ok(fs.existsSync(`${f.cfg.root}/w1/repo`));
});
