// node --experimental-strip-types --test repo-diff.test.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { citeNames, collectRepoDiff, type RepoDiff, type RunGit, needsFinalFullReview, shouldSkipRepeatFullReview, uncitedFiles } from "./repo-diff.ts";

const NUL = String.fromCharCode(0);

const git: RunGit = (cwd, ...args) =>
	new Promise((resolve) => {
		execFile("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
			resolve({ code, stdout: String(stdout ?? "") });
		});
	});

/** The algorithm before the parallel rewrite (index.ts, collectRepoDiff). */
async function legacyCollectRepoDiff(cwd: string, base = "HEAD"): Promise<RepoDiff | null> {
	if ((await git(cwd, "rev-parse", "--is-inside-work-tree")).code !== 0) return null;
	let tracked = await git(cwd, "diff", "--no-color", base);
	if (tracked.code !== 0) tracked = await git(cwd, "diff", "--no-color");
	const parts = [tracked.stdout];
	let files = (tracked.stdout.match(/^diff --git /gm) ?? []).length;
	const untracked = (await git(cwd, "ls-files", "--others", "--exclude-standard", "-z")).stdout.split(NUL).filter(Boolean);
	for (const rel of untracked) {
		files++;
		try {
			const buf = fs.readFileSync(path.join(cwd, rel));
			if (buf.length > 200_000 || buf.includes(0)) {
				parts.push(`\n=== new file: ${rel} (${buf.length} bytes, binary or too large, not shown) ===\n`);
				continue;
			}
			const numbered = buf
				.toString("utf8")
				.split("\n")
				.map((l, i) => `+${i + 1}: ${l}`)
				.join("\n");
			parts.push(`\n=== new file: ${rel} ===\n${numbered}\n`);
		} catch {
			parts.push(`\n=== new file: ${rel} (unreadable) ===\n`);
		}
	}
	const full = parts.join("").trim();
	const names = [...[...tracked.stdout.matchAll(/^diff --git a\/(.+?) b\//gm)].map((m) => m[1]), ...untracked];
	let current = await git(cwd, "diff", "--name-only", "-z", "--diff-filter=d", base);
	if (current.code !== 0) current = await git(cwd, "diff", "--name-only", "-z", "--diff-filter=d");
	const checkNames = [...current.stdout.split(NUL).filter(Boolean), ...untracked];
	const trackedNames = names.slice(0, names.length - untracked.length);
	const rootUntracked = untracked.length ? (await git(cwd, "ls-files", "--others", "--exclude-standard", "--full-name", "-z")).stdout.split(NUL).filter(Boolean) : [];
	return { full, files, names, checkNames, rootNames: [...trackedNames, ...rootUntracked] };
}

async function fixture(commit = true): Promise<string> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-diff-"));
	await git(dir, "init", "-q");
	await git(dir, "config", "user.name", "t");
	await git(dir, "config", "user.email", "t@example.com");
	await git(dir, "config", "core.autocrlf", "false");
	if (commit) {
		fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
		fs.writeFileSync(path.join(dir, "b.txt"), "bee\n");
		fs.mkdirSync(path.join(dir, "sub"));
		fs.writeFileSync(path.join(dir, "sub", "s.txt"), "sub\n");
		await git(dir, "add", "-A");
		await git(dir, "commit", "-q", "-m", "init");
	}
	return dir;
}

async function same(cwd: string): Promise<RepoDiff | null> {
	const a = await collectRepoDiff(git, cwd);
	const b = await legacyCollectRepoDiff(cwd);
	assert.deepEqual(a, b);
	return a;
}

test("repo root: modified, deleted and untracked files", async () => {
	const d = await fixture();
	fs.writeFileSync(path.join(d, "a.txt"), "one\nchanged\n");
	fs.rmSync(path.join(d, "b.txt"));
	fs.writeFileSync(path.join(d, "c.txt"), "new\n");
	const r = await same(d);
	assert.equal(r?.files, 3);
});

test("subfolder cwd lists only its untracked files with cwd-relative names", async () => {
	const d = await fixture();
	fs.writeFileSync(path.join(d, "sub", "u.txt"), "u\n");
	fs.writeFileSync(path.join(d, "top.txt"), "t\n");
	const r = await same(path.join(d, "sub"));
	assert.ok(r?.names.includes("u.txt"));
	assert.ok(!r?.names.includes("top.txt"));
	assert.ok(r?.rootNames.includes("sub/u.txt"));
});

test("renamed file", async () => {
	const d = await fixture();
	await git(d, "mv", "a.txt", "y.txt");
	fs.appendFileSync(path.join(d, "y.txt"), "more\n");
	await same(d);
});

test("binary and oversized untracked files are not shown", async () => {
	const d = await fixture();
	fs.writeFileSync(path.join(d, "bin.dat"), Buffer.from([1, 0, 2]));
	fs.writeFileSync(path.join(d, "big.txt"), "x".repeat(200_001));
	const r = await same(d);
	assert.match(r?.full ?? "", /binary or too large/);
});

test("repo with no commits yet", async () => {
	const d = await fixture(false);
	fs.writeFileSync(path.join(d, "staged.txt"), "s\n");
	await git(d, "add", "staged.txt");
	fs.writeFileSync(path.join(d, "loose.txt"), "l\n");
	await same(d);
});

test("not a git work tree returns null", async () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "repo-diff-none-"));
	assert.equal(await collectRepoDiff(git, d), null);
	assert.equal(await legacyCollectRepoDiff(d), null);
});

test("untracked file names with spaces and unicode", async () => {
	const d = await fixture();
	fs.writeFileSync(path.join(d, "new file ü.txt"), "ü\n");
	const r = await same(d);
	assert.ok(r?.names.includes("new file ü.txt"));
});

test("subfolder with spaces and unicode, tracked and untracked changes", async () => {
	const d = await fixture();
	const sub = path.join(d, "dir ü");
	fs.mkdirSync(sub);
	fs.writeFileSync(path.join(sub, "t.txt"), "t\n");
	await git(d, "add", "-A");
	await git(d, "commit", "-q", "-m", "sub");
	fs.writeFileSync(path.join(sub, "t.txt"), "t\nchanged\n");
	fs.writeFileSync(path.join(sub, "n.txt"), "n\n");
	const r = await same(sub);
	assert.ok(r?.names.includes("n.txt"));
	assert.ok(r?.rootNames.includes("dir ü/n.txt"));
});

test("uncitedFiles keeps files no finding cites", () => {
	assert.deepEqual(uncitedFiles("a/b.ts:12 - major - x", ["a/b.ts", "c.ts"]), ["c.ts"]);
	assert.deepEqual(uncitedFiles("D:\\x\\repo\\a\\b.ts:3 - minor", ["a/b.ts"]), []);
	assert.deepEqual(uncitedFiles("only a/b.ts was changed", ["a/b.ts"]), ["a/b.ts"]);
	assert.deepEqual(uncitedFiles("", ["a.ts"]), ["a.ts"]);
	assert.deepEqual(uncitedFiles("x.ts:1", []), []);
	assert.deepEqual(uncitedFiles("ab.ts:4", ["b.ts"]), []);
});

test("needsFinalFullReview follows the switch and the citations", () => {
	assert.equal(needsFinalFullReview(false, "a.ts:1", ["a.ts"]), true);
	assert.equal(needsFinalFullReview(true, "a.ts:1", ["a.ts"]), false);
	assert.equal(needsFinalFullReview(true, "a.ts:1", ["a.ts", "b.ts"]), true);
	assert.equal(needsFinalFullReview(true, "repoA/r.md:3", ["repoB/r.md"]), true);
	assert.equal(needsFinalFullReview(true, "repoA/r.md:3", ["repoA/r.md"]), false);
});

test("citeNames keeps a path bare unless several repos changed it", () => {
	const parts = [
		{ root: "/w/repoA", names: ["src/a.ts", "README.md"] },
		{ root: "/w/repoB", names: ["README.md"] },
	];
	assert.deepEqual(citeNames(parts, false), ["src/a.ts", "README.md", "README.md"]);
	const names = citeNames(parts, true);
	assert.deepEqual(names, ["src/a.ts", "repoA/README.md", "repoB/README.md"]);
	assert.deepEqual(uncitedFiles("src/a.ts:3 - minor - x", names), ["repoA/README.md", "repoB/README.md"]);
	assert.deepEqual(uncitedFiles("repoA/README.md:3 - minor - x", names), ["src/a.ts", "repoB/README.md"]);
	assert.deepEqual(citeNames([], true), []);
});

test("shouldSkipRepeatFullReview follows the share", () => {
	assert.equal(shouldSkipRepeatFullReview(100, 1000, 0), false);
	assert.equal(shouldSkipRepeatFullReview(100, 1000, 0.1), true);
	assert.equal(shouldSkipRepeatFullReview(101, 1000, 0.1), false);
	assert.equal(shouldSkipRepeatFullReview(0, 1000, 0.1), true);
});
