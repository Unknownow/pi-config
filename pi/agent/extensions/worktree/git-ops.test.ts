// node --experimental-strip-types --test git-ops.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { defaults } from "./config.ts";
import { createAll, excludeLinks, preflight, removeChecks, repoInfo, repoStatus, rollback, type Git, type Planned } from "./git-ops.ts";

interface Call {
	cwd: string;
	args: string[];
}

/** A fake git: `answers` maps "arg arg arg" prefixes to results; anything else succeeds with no output. */
function fake(answers: Record<string, { code?: number; stdout?: string }> = {}) {
	const calls: Call[] = [];
	const git: Git = async (cwd, args) => {
		calls.push({ cwd, args });
		const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
		const a = key ? answers[key] : {};
		return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: "" };
	};
	return { git, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wtgit-")).replace(/\\/g, "/");
const cfgIn = (root: string) => ({ ...defaults("D:/projects"), root });

test("baseRef falls back to origin/master", async () => {
	const { git } = fake({
		"rev-parse --show-toplevel": { stdout: "D:/r/pi-config\n" },
		remote: { stdout: "origin\n" },
		"rev-parse --abbrev-ref": { code: 128 },
		"rev-parse --verify --quiet origin/main": { code: 1 },
		"rev-parse --path-format": { stdout: "D:/r/pi-config/.git\n" },
	});
	const info = await repoInfo(git, "D:/r/pi-config");
	assert.ok(!("error" in info));
	if (!("error" in info)) {
		assert.equal(info.baseRef, "origin/master");
		assert.equal(info.mainRepo, "D:/r/pi-config");
	}
});

test("preflight collects all errors", async () => {
	const root = tmp();
	const target = `${root}/x/a`;
	fs.mkdirSync(target, { recursive: true });
	const { git } = fake({
		"rev-parse --show-toplevel": { stdout: "D:/r/a\n" },
		remote: { stdout: "origin\n" },
		"rev-parse --abbrev-ref": { stdout: "origin/main\n" },
		"rev-parse --path-format": { stdout: "D:/r/a/.git\n" },
	});
	const r = await preflight(git, ["D:/r/a"], cfgIn(root), "x");
	assert.equal(r.errors.length, 2);
	assert.ok(r.errors.some((e) => /already exists/.test(e) && e.includes(target)));
	assert.ok(r.errors.some((e) => /branch wt\/x already exists/.test(e)));
});

test("worktree add argv uses --no-track", async () => {
	const { git, calls } = fake();
	const plan: Planned = { info: { top: "D:/r/a", remote: "origin", baseRef: "origin/main", mainRepo: "D:/r/a" }, target: "D:/wt/x/a" };
	const seen: string[] = [];
	await createAll(git, [plan], "wt/x", (p) => seen.push(p.target));
	assert.deepEqual(calls[0].args, ["worktree", "add", "--no-track", "-b", "wt/x", "D:/wt/x/a", "origin/main"]);
	assert.equal(calls[0].cwd, "D:/r/a");
	assert.deepEqual(seen, ["D:/wt/x/a"]);
});

test("createAll throws when git fails", async () => {
	const { git } = fake({ worktree: { code: 128 } });
	const plan: Planned = { info: { top: "D:/r/a", remote: "origin", baseRef: "origin/main", mainRepo: "D:/r/a" }, target: "D:/wt/x/a" };
	await assert.rejects(createAll(git, [plan], "wt/x", () => {}), /worktree add failed/);
});

test("rollback removes only created worktrees, links first", async () => {
	const root = tmp();
	const cfg = cfgIn(root);
	const real = `${root}/orig/.pi/git`;
	fs.mkdirSync(real, { recursive: true });
	fs.writeFileSync(`${real}/keep.txt`, "k");
	const target = `${root}/x/a`;
	fs.mkdirSync(`${target}/.pi`, { recursive: true });
	fs.symlinkSync(path.resolve(real), `${target}/.pi/git`, process.platform === "win32" ? "junction" : "dir");
	const order: string[] = [];
	const git: Git = async (cwd, args) => {
		if (args[0] === "worktree") order.push(fs.existsSync(`${target}/.pi/git`) ? "link-still-there" : "link-gone");
		return { code: 0, stdout: "", stderr: "" };
	};
	const plan: Planned = { info: { top: "D:/r/a", remote: "origin", baseRef: "origin/main", mainRepo: "D:/r/a" }, target };
	const problems = await rollback(git, [plan], cfg, "x");
	assert.deepEqual(problems, []);
	assert.deepEqual(order, ["link-gone"]);
	assert.ok(fs.existsSync(`${real}/keep.txt`));
});

test("createAll deletes the branch a failed worktree add left behind", async () => {
	const { git, calls } = fake({ "worktree add": { code: 128 } });
	const plan: Planned = { info: { top: "D:/r/a", remote: "origin", baseRef: "origin/main", mainRepo: "D:/r/a" }, target: "D:/wt/x/a" };
	await assert.rejects(createAll(git, [plan], "wt/x", () => {}), /worktree add failed/);
	assert.deepEqual(calls[calls.length - 1].args, ["branch", "-D", "wt/x"]);
});

test("createAll keeps going without branch -D when the branch does not exist", async () => {
	const { git, calls } = fake({ "worktree add": { code: 128 }, "show-ref": { code: 1 } });
	const plan: Planned = { info: { top: "D:/r/a", remote: "origin", baseRef: "origin/main", mainRepo: "D:/r/a" }, target: "D:/wt/x/a" };
	await assert.rejects(createAll(git, [plan], "wt/x", () => {}), /worktree add failed/);
	assert.ok(!calls.some((c) => c.args[0] === "branch"));
});

test("excludeLinks writes the exclude line once when git does not ignore the link", async () => {
	const common = tmp();
	const { git } = fake({ "check-ignore": { code: 1 }, "rev-parse --path-format": { stdout: common } });
	assert.deepEqual(await excludeLinks(git, "D:/wt/x/a", [".pi/git"]), [".pi/git"]);
	assert.deepEqual(await excludeLinks(git, "D:/wt/x/a", [".pi/git"]), []);
	assert.equal(fs.readFileSync(`${common}/info/exclude`, "utf8"), "/.pi/git" + String.fromCharCode(10));
});

test("excludeLinks leaves already ignored links alone", async () => {
	const { git, calls } = fake({ "check-ignore": { code: 0 } });
	assert.deepEqual(await excludeLinks(git, "D:/wt/x/a", [".pi/git"]), []);
	assert.equal(calls.length, 1);
});

test("removeChecks dirty", async () => {
	const { git } = fake({ "status --porcelain": { stdout: " M a\n?? b\n" }, "rev-parse --abbrev-ref @{u}": { code: 128 } });
	const r = await removeChecks(git, ["D:/wt/x/a"]);
	assert.match(r.problems.join("\n"), /2 uncommitted/);
});

test("removeChecks ahead of upstream", async () => {
	const { git } = fake({ "rev-parse --abbrev-ref @{u}": { stdout: "origin/wt/x\n" }, "rev-list --left-right": { stdout: "0\t3\n" } });
	const r = await removeChecks(git, ["D:/wt/x/a"]);
	assert.match(r.problems.join("\n"), /3 commit\(s\) not pushed to upstream origin\/wt\/x/);
});

test("removeChecks no upstream with commits", async () => {
	const { git } = fake({
		remote: { stdout: "origin\n" },
		"rev-parse --abbrev-ref origin/HEAD": { stdout: "origin/main\n" },
		"rev-parse --abbrev-ref @{u}": { code: 128 },
		"rev-list --count origin/main..HEAD": { stdout: "2\n" },
	});
	const r = await removeChecks(git, ["D:/wt/x/a"]);
	assert.match(r.problems.join("\n"), /2 commit\(s\) not pushed to the base branch/);
});

test("removeChecks upstream gone falls back to the base check", async () => {
	const { git, calls } = fake({
		remote: { stdout: "origin\n" },
		"rev-parse --abbrev-ref origin/HEAD": { stdout: "origin/main\n" },
		"rev-parse --abbrev-ref @{u}": { code: 128 },
		"rev-list --count origin/main..HEAD": { stdout: "0\n" },
	});
	const r = await removeChecks(git, ["D:/wt/x/a"]);
	assert.deepEqual(r.problems, []);
	assert.ok(calls.some((c) => c.args.join(" ") === "rev-list --count origin/main..HEAD"));
});

test("removeChecks clean passes and a failed fetch only warns", async () => {
	const { git } = fake({ fetch: { code: 1 }, "rev-parse --abbrev-ref @{u}": { stdout: "origin/wt/x\n" }, "rev-list --left-right": { stdout: "1\t0\n" } });
	const r = await removeChecks(git, ["D:/wt/x/a"]);
	assert.deepEqual(r.problems, []);
	assert.equal(r.warnings.length, 1);
});

test("repoStatus reports behind and ahead", async () => {
	const { git } = fake({ "rev-parse --abbrev-ref HEAD": { stdout: "wt/x\n" }, "rev-parse --abbrev-ref @{u}": { stdout: "origin/wt/x\n" }, "rev-list --left-right": { stdout: "4\t2\n" } });
	const s = await repoStatus(git, "D:/wt/x/a", null);
	assert.deepEqual([s.branch, s.behind, s.ahead, s.unpushed], ["wt/x", 4, 2, 2]);
});

test("removeChecks refuses when git cannot tell", async () => {
	const { git } = fake({ "rev-parse --abbrev-ref @{u}": { stdout: "origin/wt/x\n" }, "rev-list --left-right": { code: 128 } });
	const r = await removeChecks(git, ["D:/wt/x/a"]);
	assert.match(r.problems.join("\n"), /rev-list failed/);
});
