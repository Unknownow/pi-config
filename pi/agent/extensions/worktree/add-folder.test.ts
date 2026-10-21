// node --experimental-strip-types --test add-folder.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { worktreeForFolder } from "./add-folder.ts";
import { defaults } from "./config.ts";
import type { Git } from "./git-ops.ts";
import { readMeta, writeMeta } from "./meta.ts";
import { Progress } from "./progress.ts";

const git: Git = async (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const run = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
const id = ["-c", "user.name=t", "-c", "user.email=t@t"];

function makeRepo(d: string, name: string): void {
	run(d, ["init", "--bare", "-b", "main", `${name}-origin.git`]);
	run(d, ["clone", `${name}-origin.git`, name]);
	fs.mkdirSync(`${d}/${name}/.pi/git`, { recursive: true });
	fs.writeFileSync(`${d}/${name}/.pi/git/keep.txt`, "keep");
	fs.mkdirSync(`${d}/${name}/sub`);
	fs.writeFileSync(`${d}/${name}/sub/a.txt`, "a");
	fs.writeFileSync(`${d}/${name}/.gitignore`, ".pi/git/\n");
	run(`${d}/${name}`, ["add", "."]);
	run(`${d}/${name}`, [...id, "commit", "-m", "i"]);
	run(`${d}/${name}`, ["push", "origin", "HEAD:main"]);
	run(`${d}/${name}`, ["fetch", "origin"]);
	run(`${d}/${name}`, ["remote", "set-head", "origin", "main"]);
}

/** Repos `repo` (with worktree in set s1) and `other`; `.pi-set.json` lists only `repo`. */
function fixture() {
	const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wtadd-"))).replace(/\\/g, "/");
	makeRepo(d, "repo");
	makeRepo(d, "other");
	const cfg = { ...defaults(d), root: `${d}/wt` };
	const setRoot = `${cfg.root}/s1`;
	run(`${d}/repo`, ["worktree", "add", "--no-track", "-b", "wt/s1", `${setRoot}/repo`, "origin/main"]);
	writeMeta(setRoot, { v: 1, created: "now", branch: "wt/s1", repos: [{ main: `${d}/repo`, dir: "repo" }] });
	const ask = (folder: string) => worktreeForFolder(git, { cfg, setRoot, folder }, new Progress(null, "t", (l) => l));
	return { d, cfg, setRoot, ask };
}

test("a plain folder is left alone", async () => {
	const f = fixture();
	fs.mkdirSync(`${f.d}/plain`);
	assert.equal(await f.ask(`${f.d}/plain`), null);
});

test("a folder inside the set is left alone", async () => {
	const f = fixture();
	assert.equal(await f.ask(`${f.setRoot}/repo`), null);
});

test("a new repo gets a worktree on the set branch", async () => {
	const f = fixture();
	const r = await f.ask(`${f.d}/other`);
	assert.ok(r && "folder" in r, JSON.stringify(r));
	assert.equal(r.folder, `${f.setRoot}/other`);
	assert.equal(run(r.folder, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "wt/s1");
	assert.equal(run(r.folder, ["rev-parse", "HEAD"]), run(`${f.d}/other`, ["rev-parse", "origin/main"]));
	assert.ok(fs.existsSync(`${r.folder}/.pi/git/keep.txt`));
	assert.deepEqual(readMeta(f.setRoot)?.repos.map((x) => x.dir), ["repo", "other"]);
	assert.equal(readMeta(f.setRoot)?.repos[1].main, `${f.d}/other`);
});

test("a subfolder maps to the worktree subfolder", async () => {
	const f = fixture();
	const r = await f.ask(`${f.d}/other/sub`);
	assert.ok(r && "folder" in r, JSON.stringify(r));
	assert.equal(r.folder, `${f.setRoot}/other/sub`);
});

test("an existing worktree in the set is reused", async () => {
	const f = fixture();
	await f.ask(`${f.d}/other`);
	const before = run(`${f.d}/other`, ["worktree", "list"]).split("\n").length;
	const r = await f.ask(`${f.d}/other/sub`);
	assert.ok(r && "folder" in r, JSON.stringify(r));
	assert.equal(r.folder, `${f.setRoot}/other/sub`);
	assert.equal(run(`${f.d}/other`, ["worktree", "list"]).split("\n").length, before);
});

test("a taken target folder is refused", async () => {
	const f = fixture();
	fs.mkdirSync(`${f.setRoot}/other`);
	const r = await f.ask(`${f.d}/other`);
	assert.ok(r && "error" in r);
	assert.match(r.error, /already exists/);
	assert.equal(spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/heads/wt/s1"], { cwd: `${f.d}/other` }).status, 1);
});

test("an existing set branch is refused and nothing is left", async () => {
	const f = fixture();
	run(`${f.d}/other`, ["branch", "wt/s1", "origin/main"]);
	const r = await f.ask(`${f.d}/other`);
	assert.ok(r && "error" in r);
	assert.match(r.error, /already exists/);
	assert.equal(fs.existsSync(`${f.setRoot}/other`), false);
	assert.equal(run(`${f.d}/other`, ["worktree", "list"]).trim().split("\n").length, 1);
});

test("a worktree folder deleted by hand is recreated, not reused", async () => {
	const f = fixture();
	await f.ask(`${f.d}/other`);
	fs.rmSync(`${f.setRoot}/other`, { recursive: true, force: true });
	const r = await f.ask(`${f.d}/other`);
	assert.ok(r && ("error" in r || fs.existsSync(r.folder)), JSON.stringify(r));
});
