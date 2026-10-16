// node --test repos.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { combineRepoTexts, parseAddDir, repoKey, fallbackTexts, repoTexts, shellText, uniqueRoots } from "./repos.ts";
import { pushProblem } from "./push-guard.ts";

test("repoKey normalizes", () => {
	assert.equal(repoKey("D:\\a\\b\\", "win32"), "d:/a/b");
	assert.equal(repoKey("/d/a/b", "win32"), "d:/a/b");
	assert.equal(repoKey("/home/x/", "linux"), "/home/x");
	assert.equal(repoKey("D:/", "win32"), "d:/");
});

test("uniqueRoots keeps first", () => {
	assert.deepEqual(uniqueRoots(["D:/a", "d:\\a", "D:/b"], "win32"), ["D:/a", "D:/b"]);
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
	assert.ok(pushProblem(bash[0].text, { branch: "feat", protectedBranches: ["main"], pushAllowed: false, prAllowed: false, mergeAllowed: false, commitAllowed: false }));
	assert.equal(t("git commit -m 'a; b'").length, 1);
	assert.equal(t("git commit -m 'a; b'")[0].text, "git commit -m 'a; b'");
});

test("repoTexts keeps backslash paths and subshells guarded", () => {
	const roots = ["D:/projects/a", "D:/projects/b"];
	const guard = { branch: "main", protectedBranches: ["main"], pushAllowed: true, prAllowed: false, mergeAllowed: false, commitAllowed: false };
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
	assert.ok(pushProblem(ps[0].text, { branch: "main", protectedBranches: ["main"], pushAllowed: true, prAllowed: false, mergeAllowed: false, commitAllowed: false }));
});

test("repoTexts guards each command against its own repo", () => {
	const groups = repoTexts("git -C D:/projects/b commit -m x && git push", ["D:/projects/a", "D:/projects/b"], "D:/projects/a", "win32");
	const ctx = { protectedBranches: ["main"], pushAllowed: true, prAllowed: false, mergeAllowed: false, commitAllowed: true };
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
	const opts = { branch: "feat", protectedBranches: ["main"], pushAllowed: false, prAllowed: false, mergeAllowed: false, commitAllowed: false };
	assert.equal(shellText("cd D:\\b\\; git push", true), "cd D:/b/; git push");
	assert.equal(shellText("cd D:\\b\\; git push", false), "cd D:\\b\\; git push");
	assert.ok(pushProblem(shellText("cd D:\\b\\; git push", true), opts));
	assert.equal(pushProblem("cd D:\\b\\; git push", opts), null);
	assert.ok(pushProblem("bash -c 'git pu\\sh'", opts));
	assert.equal(pushProblem(shellText("bash -c 'git pu\\sh'", true), opts), null);
});

test("fallbackTexts checks PowerShell text converted and as written", () => {
	const opts = { branch: "feat", protectedBranches: ["main"], pushAllowed: false, prAllowed: false, mergeAllowed: false, commitAllowed: false };
	const both = fallbackTexts("bash -c 'git pu\\sh'", true);
	assert.equal(both.length, 2);
	assert.ok(both.some((t) => pushProblem(t, opts)));
	assert.deepEqual(fallbackTexts("git push", false), ["git push"]);
	assert.deepEqual(both, ["bash -c 'git pu/sh'", "bash -c 'git pu\\sh'"]);
	assert.ok(fallbackTexts("cd D:\\b\\; git push", true).some((t) => pushProblem(t, opts)));
	assert.deepEqual(fallbackTexts("git push", true), ["git push"]);
});
