// node --experimental-strip-types --test snapshot.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { run } from "./sh.ts";
import { applySnapshot, revertSnapshotted, snapshotBranch, snapshotEdits } from "./snapshot.ts";
import { cleanup, git, makeRepo, tmpDir } from "./test/helpers.ts";

const w = (dir: string, f: string, c: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
	fs.writeFileSync(path.join(dir, f), c);
};

test("modified, deleted, new untracked and staged files are in the snapshot; the checkout is clean after the revert", async () => {
	const { dir } = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "c.txt": "c\n" });
	w(dir, "a.txt", "a changed\n");
	fs.rmSync(path.join(dir, "b.txt"));
	w(dir, "new/n.txt", "new\n");
	w(dir, "staged.txt", "s\n");
	git(dir, "add", "staged.txt");
	const before = git(dir, "status", "--porcelain");
	const snap = await snapshotEdits(run, dir, "r1");
	assert.ok(snap);
	assert.equal(git(dir, "status", "--porcelain"), before, "the snapshot leaves index and work tree alone");
	assert.deepEqual(snap.paths.map((p) => `${p.status}:${p.path}`).sort(), ["A:new/n.txt", "A:staged.txt", "D:b.txt", "M:a.txt"]);
	assert.equal(git(dir, "rev-parse", snapshotBranch("r1")), snap.sha);
	assert.equal(git(dir, "rev-parse", `${snap.sha}^`), git(dir, "rev-parse", "HEAD"));
	const r = await revertSnapshotted(run, dir, snap);
	assert.equal(r.skipped.length, 0, JSON.stringify(r.skipped));
	assert.equal(git(dir, "status", "--porcelain"), "");
	assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "a\n");
	assert.ok(fs.existsSync(path.join(dir, "b.txt")));
	cleanup(dir);
});

test("nothing to move gives null", async () => {
	const { dir } = makeRepo();
	assert.equal(await snapshotEdits(run, dir, "r1"), null);
	cleanup(dir);
});

test("a file changed between snapshot and revert is skipped and noted", async () => {
	const { dir } = makeRepo({ "a.txt": "a\n", "b.txt": "b\n" });
	w(dir, "a.txt", "one\n");
	w(dir, "b.txt", "two\n");
	const snap = await snapshotEdits(run, dir, "r1");
	assert.ok(snap);
	w(dir, "a.txt", "edited again\n");
	const r = await revertSnapshotted(run, dir, snap);
	assert.deepEqual(r.reverted, ["b.txt"]);
	assert.equal(r.skipped[0].path, "a.txt");
	assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "edited again\n");
	cleanup(dir);
});

test("an unpushed lead commit plus edits: the job branch is base plus exactly one lead-edits commit", async () => {
	const { dir, bare } = makeRepo({ "a.txt": "a\n", "b.txt": "b\n" }, true);
	const base = git(dir, "rev-parse", "origin/main");
	w(dir, "b.txt", "unpushed commit\n");
	git(dir, "commit", "-q", "-am", "lead local commit");
	w(dir, "a.txt", "uncommitted edit\n");
	w(dir, "fresh.txt", "fresh\n");
	const snap = await snapshotEdits(run, dir, "r1");
	assert.ok(snap);
	const sets = tmpDir();
	const wt = path.join(sets, "r1");
	git(dir, "worktree", "add", "-q", "-b", "wt/r1", wt, "origin/main");
	const ap = await applySnapshot(run, wt, snap.sha);
	assert.equal(ap.ok, true);
	assert.equal(git(wt, "rev-list", "--count", `${base}..HEAD`), "1");
	assert.match(git(wt, "log", "-1", "--format=%s"), /relay: lead edits/);
	assert.equal(fs.readFileSync(path.join(wt, "a.txt"), "utf8"), "uncommitted edit\n");
	assert.equal(fs.readFileSync(path.join(wt, "fresh.txt"), "utf8"), "fresh\n");
	assert.equal(fs.readFileSync(path.join(wt, "b.txt"), "utf8"), "b\n", "the lead's unpushed commit stays out");
	git(dir, "worktree", "remove", "--force", wt);
	cleanup(dir, bare, sets);
});

test("a conflicting cherry-pick fails, is aborted, and the lead's edits are untouched", async () => {
	const { dir, bare } = makeRepo({ "a.txt": "a\n" }, true);
	w(dir, "a.txt", "lead edit\n");
	const snap = await snapshotEdits(run, dir, "r1");
	assert.ok(snap);
	const sets = tmpDir();
	const wt = path.join(sets, "r1");
	git(dir, "worktree", "add", "-q", "-b", "wt/r1", wt, "origin/main");
	w(wt, "a.txt", "conflicting\n");
	git(wt, "commit", "-q", "-am", "other");
	const ap = await applySnapshot(run, wt, snap.sha);
	assert.equal(ap.ok, false);
	if (!ap.ok) assert.deepEqual(ap.conflicts, ["a.txt"]);
	assert.equal(git(wt, "status", "--porcelain"), "", "no cherry-pick in progress");
	assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "lead edit\n");
	git(dir, "worktree", "remove", "--force", wt);
	cleanup(dir, bare, sets);
});
