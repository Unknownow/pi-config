// node --experimental-strip-types --test update.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import type { Gh, Git } from "./git-ops.ts";
import { reattach, updateRepo, updateSet, worthNotifying, type UpdateOpts } from "./update.ts";

const git: Git = async (cwd, args) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
const run = (cwd: string, a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString().trim();
const temps: string[] = [];
const opts = (allowDirty: boolean, extra: Partial<UpdateOpts> = {}): UpdateOpts => ({ allowDirty, rebase: false, ...extra });
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
	const r = await updateRepo(git, f.wt, opts(false));
	assert.equal(r.state, "current", r.text);
	assert.equal(worthNotifying([r]), false);
});

test("fast-forwards a clean branch with no own commits", async () => {
	const f = fixture();
	f.pushUpstream();
	f.pushUpstream();
	const r = await updateRepo(git, f.wt, opts(false));
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
	const r = await updateRepo(git, f.wt, opts(true));
	assert.equal(r.state, "skipped", r.text);
	assert.match(r.text, /1 own commit/);
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
});

test("uncommitted changes block the automatic update but not the manual one", async () => {
	const f = fixture();
	fs.writeFileSync(`${f.wt}/a.txt`, "local edit\n");
	f.pushUpstream();
	const auto = await updateRepo(git, f.wt, opts(false));
	assert.equal(auto.state, "skipped", auto.text);
	assert.match(auto.text, /1 uncommitted change/);
	const manual = await updateRepo(git, f.wt, opts(true));
	assert.equal(manual.state, "updated", manual.text);
	assert.equal(fs.readFileSync(`${f.wt}/a.txt`, "utf8"), "local edit\n");
});

test("manual update fails without touching a change git would overwrite", async () => {
	const f = fixture();
	fs.writeFileSync(`${f.wt}/a.txt`, "local edit\n");
	f.pushUpstream("a.txt");
	const before = run(f.wt, ["rev-parse", "HEAD"]);
	const r = await updateRepo(git, f.wt, opts(true));
	assert.equal(r.state, "failed", r.text);
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
	assert.equal(fs.readFileSync(`${f.wt}/a.txt`, "utf8"), "local edit\n");
});

test("updateSet reports every repo, including a folder that is not a repo", async () => {
	const f = fixture();
	f.pushUpstream();
	const plain = `${f.d}/plain`;
	fs.mkdirSync(plain);
	const res = await updateSet(git, [f.wt, plain], opts(false));
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
	const r = await updateRepo(mainGit, f.wt, opts(false), fetchGit);
	assert.equal(r.state, "updated", r.text);
	assert.deepEqual(fetched.map((a) => a[0]), ["fetch"]);
	assert.ok(!main.some((a) => a[0] === "fetch"));
	assert.ok(main.some((a) => a[0] === "merge"));
});

/** Commit a new file on the worktree branch. */
const commitHere = (wt: string, file = "mine.txt", msg = "mine") => {
	fs.writeFileSync(`${wt}/${file}`, `${msg}
`);
	run(wt, ["add", file]);
	run(wt, [...id, "commit", "-m", msg]);
};
const calls = (log: string[][]): Git => async (cwd, args) => {
	log.push(args);
	return git(cwd, args);
};

test("rebases unpushed own commits onto the base branch", async () => {
	const f = fixture();
	commitHere(f.wt);
	f.pushUpstream();
	f.pushUpstream();
	const r = await updateRepo(git, f.wt, opts(false, { rebase: true, branch: "wt/s1" }));
	assert.equal(r.state, "rebased", r.text);
	assert.match(r.text, /rebased 1 commit\(s\) onto origin\/main/);
	assert.equal(run(f.wt, ["rev-list", "--count", "origin/main..HEAD"]), "1");
	assert.equal(run(f.wt, ["rev-list", "--count", "HEAD..origin/main"]), "0");
	assert.equal(run(f.wt, ["rev-parse", "--abbrev-ref", "HEAD"]), "wt/s1");
});

test("without rebase the own commits are reported and left", async () => {
	const f = fixture();
	commitHere(f.wt);
	f.pushUpstream();
	const before = run(f.wt, ["rev-parse", "HEAD"]);
	const r = await updateRepo(git, f.wt, opts(false, { rebase: false }));
	assert.equal(r.state, "skipped", r.text);
	assert.match(r.text, /\/wt update to rebase/);
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
});

test("never rebases pushed commits", async () => {
	const f = fixture();
	commitHere(f.wt);
	run(f.wt, ["push", "origin", "HEAD:refs/heads/wt/s1"]);
	f.pushUpstream();
	const log: string[][] = [];
	const before = run(f.wt, ["rev-parse", "HEAD"]);
	const r = await updateRepo(calls(log), f.wt, opts(true, { rebase: true }));
	assert.equal(r.state, "skipped", r.text);
	assert.match(r.text, /force push/);
	assert.ok(!log.some((a) => a[0] === "rebase"));
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
});

test("a conflicting rebase is aborted and the branch is left as before", async () => {
	const f = fixture();
	fs.writeFileSync(`${f.wt}/a.txt`, "mine\n");
	run(f.wt, ["add", "a.txt"]);
	run(f.wt, [...id, "commit", "-m", "mine"]);
	f.pushUpstream("a.txt");
	const before = run(f.wt, ["rev-parse", "HEAD"]);
	const log: string[][] = [];
	const r = await updateRepo(calls(log), f.wt, opts(false, { rebase: true }));
	assert.equal(r.state, "failed", r.text);
	assert.ok(log.some((a) => a[0] === "rebase" && a[1] === "--abort"));
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
	assert.equal(run(f.wt, ["rev-parse", "--abbrev-ref", "HEAD"]), "wt/s1");
	assert.equal(run(f.wt, ["status", "--porcelain"]), "");
});

test("a branch delivered as a PR is reset to the base; dirty is skipped", async () => {
	const f = fixture();
	commitHere(f.wt);
	const head = run(f.wt, ["rev-parse", "HEAD"]);
	f.pushUpstream();
	const gh: Gh = async () => ({ code: 0, stdout: JSON.stringify([{ number: 7, headRefOid: head }]), stderr: "" });
	fs.writeFileSync(`${f.wt}/a.txt`, "dirty\n");
	const dirty = await updateRepo(git, f.wt, opts(true, { branch: "wt/s1", gh }));
	assert.equal(dirty.state, "skipped", dirty.text);
	assert.match(dirty.text, /PR #7/);
	run(f.wt, ["checkout", "--", "a.txt"]);
	const r = await updateRepo(git, f.wt, opts(false, { branch: "wt/s1", gh }));
	assert.equal(r.state, "updated", r.text);
	assert.match(r.text, /delivered in PR #7/);
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), run(f.wt, ["rev-parse", "origin/main"]));
	assert.equal(run(f.wt, ["rev-parse", "--abbrev-ref", "HEAD"]), "wt/s1");
});

test("detached after a merge: updateRepo reattaches the branch", async () => {
	const f = fixture();
	commitHere(f.wt);
	run(f.wt, ["push", "origin", "HEAD:main"]);
	run(f.wt, ["checkout", "--detach"]);
	run(f.repo, ["branch", "-D", "wt/s1"]);
	const r = await updateRepo(git, f.wt, opts(false, { branch: "wt/s1" }));
	assert.equal(r.state, "reattached", r.text);
	assert.equal(run(f.wt, ["rev-parse", "--abbrev-ref", "HEAD"]), "wt/s1");
	f.pushUpstream();
	const again = await updateRepo(git, f.wt, opts(false, { branch: "wt/s1" }));
	assert.equal(again.state, "updated", again.text);
});

test("reattach: attached costs one rev-parse; extra commits on the branch are left detached; unrelated detached HEAD is untouched", async () => {
	const f = fixture();
	const log: string[][] = [];
	assert.equal(await reattach(calls(log), f.wt, "wt/s1"), null);
	assert.deepEqual(log, [["rev-parse", "--abbrev-ref", "HEAD"]]);
	commitHere(f.wt);
	run(f.wt, ["checkout", "--detach", "origin/main"]);
	const skipped = await reattach(git, f.wt, "wt/s1");
	assert.equal(skipped?.state, "skipped");
	assert.match(skipped?.text ?? "", /commits not in HEAD/);
	run(f.wt, ["checkout", "--detach", "wt/s1"]);
	const log2: string[][] = [];
	assert.equal(await reattach(calls(log2), f.wt, "wt/s1"), null);
	assert.ok(!log2.some((a) => a[0] === "switch"));
});

test("updateSet runs the repos in parallel and keeps the input order", async () => {
	const slow: Git = async () => {
		await new Promise((r) => setTimeout(r, 150));
		return { code: 1, stdout: "", stderr: "x" };
	};
	const t0 = Date.now();
	const res = await updateSet(slow, ["/a/one", "/a/two", "/a/three"], opts(false));
	assert.ok(Date.now() - t0 < 400, `took ${Date.now() - t0} ms`);
	assert.deepEqual(res.map((r) => r.wt), ["/a/one", "/a/two", "/a/three"]);
});

test("a detached HEAD with own commits is never rebased or reset", async () => {
	const f = fixture();
	commitHere(f.wt);
	f.pushUpstream();
	run(f.wt, ["checkout", "--detach"]);
	const before = run(f.wt, ["rev-parse", "HEAD"]);
	const log: string[][] = [];
	const gh: Gh = async () => ({ code: 0, stdout: JSON.stringify([{ number: 3, headRefOid: before }]), stderr: "" });
	const r = await updateRepo(calls(log), f.wt, opts(false, { rebase: true, branch: "wt/s1", gh }));
	assert.equal(r.state, "skipped", r.text);
	assert.match(r.text, /detached HEAD/);
	assert.ok(!log.some((a) => a[0] === "rebase" || a[0] === "switch"));
	assert.equal(run(f.wt, ["rev-parse", "HEAD"]), before);
});
