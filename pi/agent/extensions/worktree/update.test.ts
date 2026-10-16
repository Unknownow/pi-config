// node --experimental-strip-types --test update.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { Git } from "./git-ops.ts";
import { updateRepo, updateSet, worthNotifying } from "./update.ts";

const git: Git = async (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
const run = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
const temps: string[] = [];
after(() => {
	for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

/** A bare origin, a clone `repo`, a worktree `wt` on wt/s1 at origin/main, and a helper that pushes a new commit to main. */
function fixture() {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "wtupd-")).replace(/\\/g, "/");
	temps.push(d);
	run(d, ["init", "--bare", "-b", "main", "origin.git"]);
	run(d, ["clone", "origin.git", "repo"]);
	const repo = `${d}/repo`;
	fs.writeFileSync(`${repo}/a.txt`, "1\n");
	run(repo, ["add", "a.txt"]);
	run(repo, [...id, "commit", "-m", "i"]);
	run(repo, ["push", "origin", "HEAD:main"]);
	run(repo, ["remote", "set-head", "origin", "main"]);
	const wt = `${d}/wt/s1/repo`;
	run(repo, ["worktree", "add", "--no-track", "-b", "wt/s1", wt, "origin/main"]);
	let n = 0;
	const pushUpstream = (file = "b.txt") => {
		const other = `${d}/other`;
		if (!fs.existsSync(other)) run(d, ["clone", "origin.git", "other"]);
		run(other, ["pull", "--quiet"]);
		fs.writeFileSync(`${other}/${file}`, `upstream ${++n}\n`);
		run(other, ["add", file]);
		run(other, [...id, "commit", "-m", `c${n}`]);
		run(other, ["push", "origin", "HEAD:main"]);
	};
	return { d, repo, wt, pushUpstream };
}

test("up to date reports current and nothing to notify", async () => {
	const f = fixture();
	const r = await updateRepo(git, f.wt, false);
	assert.equal(r.state, "current", r.text);
	assert.equal(worthNotifying([r]), false);
});

test("fast-forwards a clean branch with no own commits", async () => {
	const f = fixture();
	f.pushUpstream();
	f.pushUpstream();
	const r = await updateRepo(git, f.wt, false);
	assert.equal(r.state, "updated", r.text);
	assert.match(r.text, /fast-forwarded 2 commit\(s\) to origin\/main/);
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), run(f.wt, ["rev-parse", "origin/main"]));
	assert.equal(run(f.wt, ["rev-parse", "--abbrev-ref", "HEAD"]), "wt/s1");
});

test("leaves a branch with its own commits alone", async () => {
	const f = fixture();
	fs.writeFileSync(`${f.wt}/mine.txt`, "x\n");
	run(f.wt, ["add", "mine.txt"]);
	run(f.wt, [...id, "commit", "-m", "mine"]);
	const before = run(f.wt, ["rev-parse", "HEAD"]);
	f.pushUpstream();
	const r = await updateRepo(git, f.wt, true);
	assert.equal(r.state, "skipped", r.text);
	assert.match(r.text, /1 own commit/);
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
});

test("uncommitted changes block the automatic update but not the manual one", async () => {
	const f = fixture();
	fs.writeFileSync(`${f.wt}/a.txt`, "local edit\n");
	f.pushUpstream();
	const auto = await updateRepo(git, f.wt, false);
	assert.equal(auto.state, "skipped", auto.text);
	assert.match(auto.text, /1 uncommitted change/);
	const manual = await updateRepo(git, f.wt, true);
	assert.equal(manual.state, "updated", manual.text);
	assert.equal(fs.readFileSync(`${f.wt}/a.txt`, "utf8"), "local edit\n");
});

test("manual update fails without touching a change git would overwrite", async () => {
	const f = fixture();
	fs.writeFileSync(`${f.wt}/a.txt`, "local edit\n");
	f.pushUpstream("a.txt");
	const before = run(f.wt, ["rev-parse", "HEAD"]);
	const r = await updateRepo(git, f.wt, true);
	assert.equal(r.state, "failed", r.text);
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
	assert.equal(fs.readFileSync(`${f.wt}/a.txt`, "utf8"), "local edit\n");
});

test("updateSet reports every repo, including a folder that is not a repo", async () => {
	const f = fixture();
	f.pushUpstream();
	const plain = `${f.d}/plain`;
	fs.mkdirSync(plain);
	const res = await updateSet(git, [f.wt, plain], false);
	assert.deepEqual(res.map((r) => r.state), ["updated", "failed"]);
	assert.equal(worthNotifying(res), true);
});

test("fetchGit runs only the fetch; the merge goes through the main git", async () => {
	const f = fixture();
	f.pushUpstream();
	const fetched: string[][] = [];
	const fetchGit: Git = async (cwd, args) => {
		fetched.push(args);
		return git(cwd, args);
	};
	const main: string[][] = [];
	const mainGit: Git = async (cwd, args) => {
		main.push(args);
		return git(cwd, args);
	};
	const r = await updateRepo(mainGit, f.wt, false, fetchGit);
	assert.equal(r.state, "updated", r.text);
	assert.deepEqual(fetched.map((a) => a[0]), ["fetch"]);
	assert.ok(!main.some((a) => a[0] === "fetch"));
	assert.ok(main.some((a) => a[0] === "merge"));
});
