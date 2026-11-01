// node --test repos.test.ts
// Checks shared/repos.ts together with the push guard that relies on it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { followFolders, parseWorktreeList, combineRepoTexts, parseAddDir, repoKey, fallbackTexts, repoTexts, shellText, uniqueRoots } from "../shared/repos.ts";
import { pushProblem as checkPush, type GateRequest } from "./push-guard.ts";

/** A command counts as blocked when the pure check refuses it or hands it to the gate. */
const pushProblem = (cmd: string, o: { branch?: string; protectedBranches: string[] }) => {
	const gates: GateRequest[] = [];
	return checkPush(cmd, { branch: "", ...o, gates }) ?? (gates.length ? "gated" : null);
};

test("repoKey normalizes", () => {
	assert.equal(repoKey("D:\\a\\b\\", "win32"), "d:/a/b");
	assert.equal(repoKey("/d/a/b", "win32"), "d:/a/b");
	assert.equal(repoKey("/home/x/", "linux"), "/home/x");
	assert.equal(repoKey("D:/", "win32"), "d:/");
});

test("uniqueRoots keeps first", () => {
	assert.deepEqual(uniqueRoots(["D:/a", "d:\\a", "D:/b"], "win32"), ["D:/a", "D:/b"]);
});

test("uniqueRoots collapses repeated roots", () => {
	assert.deepEqual(uniqueRoots(["D:/projects/x", "D:/projects/x", "d:/projects/x/", "/d/projects/x"], "win32"), ["D:/projects/x"]);
});

test("combineRepoTexts", () => {
	assert.equal(
		combineRepoTexts([
			{ root: "D:/a", text: "x" },
			{ root: "D:/b", text: "  " },
			{ root: "D:/c", text: "y" },
		]),
		"=== repo: D:/a ===\nx\n\n=== repo: D:/c ===\ny",
	);
});

test("repoTexts", () => {
	const roots = ["D:/projects/a", "D:/projects/b"];
	const t = (s: string) => repoTexts(s, roots, "D:/projects/a", "win32");
	const A = "D:/projects/a";
	const B = "D:/projects/b";
	assert.deepEqual(t("git -C D:/projects/b commit -m x && git push"), [
		{ root: B, text: "git -C D:/projects/b commit -m x" },
		{ root: undefined, text: "git push" },
	]);
	assert.deepEqual(t('cd "D:\\projects\\b\\sub" && gh pr create').map((g) => g.root), [B]);
	assert.deepEqual(t("cd /d/projects/b && git commit -m x && git push"), [{ root: B, text: "cd /d/projects/b; git commit -m x; git push" }]);
	assert.deepEqual(t("git -C ../b push").map((g) => g.root), [B]);
	assert.deepEqual(t("git push"), [{ root: undefined, text: "git push" }]);
	assert.deepEqual(t("git -C D:/other push").map((g) => g.root), [undefined]);
	assert.deepEqual(t("cd D:/projects/b && git push; cd D:/projects/a && git push").map((g) => g.root), [B, undefined]);
	assert.equal(A, "D:/projects/a");
	const bash = t("bash -c 'git push'");
	assert.equal(bash[0].text, "bash -c 'git push'");
	assert.ok(pushProblem(bash[0].text, { branch: "main", protectedBranches: ["main"] }));
	assert.equal(t("git commit -m 'a; b'").length, 1);
	assert.equal(t("git commit -m 'a; b'")[0].text, "git commit -m 'a; b'");
});

test("repoTexts keeps backslash paths and subshells guarded", () => {
	const roots = ["D:/projects/a", "D:/projects/b"];
	const guard = { branch: "main", protectedBranches: ["main"] };
	for (const text of ["cd 'D:\\projects\\b\\' && git push", "git -C 'D:\\b\\' push"]) {
		const groups = repoTexts(text, roots, "D:/projects/a", "win32");
		assert.ok(groups.some((g) => pushProblem(g.text, guard)), text);
	}
	const sub = repoTexts("(cd D:/projects/b && git commit -m x); git push", roots, "D:/projects/a", "win32");
	assert.deepEqual(sub.map((g) => g.root), ["D:/projects/b", undefined]);
	assert.ok(pushProblem(sub[1].text, guard));
	assert.deepEqual(repoTexts("cd D:/projects/b && git push", roots, "D:/projects/a", "win32").map((g) => g.root), ["D:/projects/b"]);
	const at = (t: string) => repoTexts(t, roots, "D:/projects/a", "win32");
	assert.deepEqual(at('cd D:/projects/b && git commit -m "fix (x)" && git push').map((g) => g.root), ["D:/projects/b"]);
	assert.deepEqual(at("cd D:/projects/b && git commit -m 'a (b)' && git push").map((g) => g.root), ["D:/projects/b"]);
	assert.deepEqual(at('cd D:/projects/b && git commit -m "$(date)" && git push').map((g) => g.root), ["D:/projects/b", undefined]);
	assert.deepEqual(at('cd D:/projects/b && git commit -m "a `b`" && git push').map((g) => g.root), ["D:/projects/b", undefined]);
	assert.ok(!at('echo \\" ; (cd D:/projects/b; true) ; echo " x"; git push').some((g) => g.root === "D:/projects/b" && g.text.includes("push")));
	assert.ok(!at('cd D:/projects/b && git commit -m "fix (x && git push').some((g) => g.root === "D:/projects/b" && g.text.includes("push")));
});

test("repoTexts reads PowerShell backslash paths", () => {
	const roots = ["D:/projects/a", "D:/projects/b"];
	const ps = repoTexts("cd D:\\projects\\b; git push", roots, "D:/projects/a", "win32", { powershell: true });
	assert.deepEqual(ps.map((g) => g.root), ["D:/projects/b"]);
	assert.ok(ps[0].text.includes("git push"));
	assert.deepEqual(repoTexts("cd D:\\projects\\b; git push", roots, "D:/projects/a", "win32").map((g) => g.root), [undefined]);
	const tick = repoTexts("cd D:\\projects\\b; git commit -m `\"x`\"; git push", roots, "D:/projects/a", "win32", { powershell: true });
	assert.ok(!tick.some((g) => g.root === "D:/projects/b" && g.text.includes("push")));
	assert.ok(pushProblem(ps[0].text, { branch: "main", protectedBranches: ["main"] }));
});

test("repoTexts guards each command against its own repo", () => {
	const groups = repoTexts("git -C D:/projects/b commit -m x && git push", ["D:/projects/a", "D:/projects/b"], "D:/projects/a", "win32");
	const ctx = { protectedBranches: ["main"] };
	assert.ok(pushProblem(groups[1].text, { ...ctx, branch: "main" }));
	assert.equal(pushProblem(groups[0].text, { ...ctx, branch: "feat" }), null);
});

test("parseAddDir", () => {
	assert.deepEqual(parseAddDir("D:/a;D:/b; ", "win32"), ["D:/a", "D:/b"]);
	assert.deepEqual(parseAddDir(undefined), []);
	assert.deepEqual(parseAddDir(true), []);
	assert.deepEqual(parseAddDir("/a:/b", "linux"), ["/a", "/b"]);
});

test("shellText reads PowerShell backslashes as separators", () => {
	const opts = { branch: "main", protectedBranches: ["main"] };
	assert.equal(shellText("cd D:\\b\\; git push", true), "cd D:/b/; git push");
	assert.equal(shellText("cd D:\\b\\; git push", false), "cd D:\\b\\; git push");
	assert.ok(pushProblem(shellText("cd D:\\b\\; git push", true), opts));
	assert.equal(pushProblem("cd D:\\b\\; git push", opts), null);
	assert.ok(pushProblem("bash -c 'git pu\\sh'", opts));
	assert.equal(pushProblem(shellText("bash -c 'git pu\\sh'", true), opts), null);
});

test("fallbackTexts checks PowerShell text converted and as written", () => {
	const opts = { branch: "main", protectedBranches: ["main"] };
	const both = fallbackTexts("bash -c 'git pu\\sh'", true);
	assert.equal(both.length, 2);
	assert.ok(both.some((t) => pushProblem(t, opts)));
	assert.deepEqual(fallbackTexts("git push", false), ["git push"]);
	assert.deepEqual(both, ["bash -c 'git pu/sh'", "bash -c 'git pu\\sh'"]);
	assert.ok(fallbackTexts("cd D:\\b\\; git push", true).some((t) => pushProblem(t, opts)));
	assert.deepEqual(fallbackTexts("git push", true), ["git push"]);
});

test("followFolders moves added folders to the sibling worktrees", () => {
	const lookup = (wts: string[]) => (f: string) => (f.startsWith("D:/p/knowledge") ? { top: "D:/p/knowledge", worktrees: wts } : null);
	const both = ["D:/p/knowledge", "D:/p/wt/w1/knowledge"];
	const fwd = followFolders(["D:/p/knowledge/docs", "D:/p/plain"], "D:/p/wt/w1/game", "D:/p/wt/w1/game", (f) => (f === "D:/p/plain" ? null : lookup(both)(f)), () => true, "win32");
	assert.deepEqual(fwd.folders, ["D:/p/wt/w1/knowledge/docs", "D:/p/plain"]);
	assert.deepEqual(fwd.changes, [{ from: "D:/p/knowledge/docs", to: "D:/p/wt/w1/knowledge/docs" }]);
	const slash = followFolders(["D:/p/knowledge/docs/"], "D:/p/wt/w1/game", "D:/p/wt/w1/game", (f) => lookup(both)(f), () => true, "win32");
	assert.deepEqual(slash.folders, ["D:/p/wt/w1/knowledge/docs"]);
	const back = followFolders(["D:/p/wt/w1/knowledge/docs"], "D:/p", "D:/p/game", (f) => ({ top: "D:/p/wt/w1/knowledge", worktrees: both }), () => true, "win32");
	assert.deepEqual(back.folders, ["D:/p/knowledge/docs"]);
});

test("followFolders leaves folders alone without exactly one candidate", () => {
	const none = followFolders(["D:/p/knowledge"], "D:/q/game", "D:/q/game", () => ({ top: "D:/p/knowledge", worktrees: ["D:/p/knowledge"] }), () => true, "win32");
	assert.deepEqual(none.changes, []);
	const two = followFolders(["D:/p/knowledge"], "D:/p/wt/w1/game", "D:/p/wt/w1/game", () => ({ top: "D:/p/knowledge", worktrees: ["D:/p/wt/w1/a", "D:/p/wt/w1/b"] }), () => true, "win32");
	assert.deepEqual(two.changes, []);
	const missing = followFolders(["D:/p/knowledge"], "D:/p/wt/w1/game", "D:/p/wt/w1/game", () => ({ top: "D:/p/knowledge", worktrees: ["D:/p/wt/w1/knowledge"] }), () => false, "win32");
	assert.deepEqual(missing.folders, ["D:/p/knowledge"]);
});

test("followFolders drops the working folder and repeats; parseWorktreeList reads porcelain", () => {
	const r = followFolders(["D:/p/knowledge", "D:/p/wt/w1/knowledge"], "D:/p/wt/w1/knowledge", "D:/p/wt/w1/game", () => ({ top: "D:/p/knowledge", worktrees: ["D:/p/knowledge", "D:/p/wt/w1/knowledge"] }), () => true, "win32");
	assert.deepEqual(r.folders, []);
	assert.deepEqual(parseWorktreeList("worktree D:/a\nHEAD x\n\nworktree D:/b\r\nbranch y\n"), ["D:/a", "D:/b"]);
});
