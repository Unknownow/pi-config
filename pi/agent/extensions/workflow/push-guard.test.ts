// node --test push-guard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { codeCommitProblem, codePublishProblem, pushProblem, shellProblem } from "./push-guard.ts";
import { repoKey } from "./repos.ts";

const feature = { branch: "feat", protectedBranches: ["main", "master"], pushAllowed: false, prAllowed: false, mergeAllowed: false, commitAllowed: false };
const committing = { ...feature, commitAllowed: true };
const allowed = { ...feature, pushAllowed: true };
const onMain = { ...allowed, branch: "main" };
const prOk = { ...allowed, prAllowed: true };
const mergeOk = { ...prOk, mergeAllowed: true };

const refused: [string, typeof feature][] = [
	["git push -f", allowed],
	["git push --force-with-lease", allowed],
	["git push --force-if-includes origin feat", allowed],
	["git push origin +feat", allowed],
	["git push origin :feat", allowed],
	["git push origin feat --delete", allowed],
	["git push --all", allowed],
	["git push origin HEAD:main", allowed],
	["git push origin feat:refs/heads/main", allowed],
	["git push origin main", allowed],
	["git -C . push origin main", allowed],
	["git push", onMain],
	["git push origin HEAD", onMain],
	["git push --no-verify", allowed],
	["git push -u origin feat", feature],
	["bash -c 'git push'", feature],
	["env A=1 git push", feature],
	["timeout 20 git push origin feat", feature],
	["git commit -nm x", feature],
	["git commit -nm x", committing],
	["git commit -m x", feature],
	["git commit -am 'fix: thing'", feature],
	["git commit -m 'set core.hooksPath on import'", feature],
	["git commit --no-verify -m x", feature],
	["git -c core.hooksPath=/dev/null commit -m x", feature],
	["git status && git push", feature],
	["git config core.hooksPath /dev/null && git commit -m x", feature],
	["git config --unset core.hooksPath", feature],
	["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", feature],
	["export GIT_CONFIG_PARAMETERS=x; git commit -m x", feature],
	["bash -lc 'git push -f'", allowed],
	["zsh -c 'git push'", feature],
	["git push origin @", onMain],
	["env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", feature],
	["$env:GIT_CONFIG_COUNT=1; git commit -m x", feature],
	["git config --global include.path /tmp/x", feature],
	["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git com''mit -m x", feature],
	["$env:git_config_count=1; git commit -m x", feature],
	["git $c -m x", feature],
	["git com''mit -nm x", feature],
	["git @a", feature],
	["gh pr merge 12 --merge", prOk],
	["gh pr merge 12 --merge --admin", mergeOk],
	["gh pr create --fill", allowed],
	["gh pr review 12 --approve", mergeOk],
	["gh pr review 12 -a", mergeOk],
	["gh api -X PUT repos/o/r/pulls/12/merge", prOk],
	["gh api repos/o/r/pulls -f title=x -f head=b -f base=main", allowed],
	["gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", prOk],
	["bash -c 'gh pr merge 1'", allowed],
	["git status && gh pr create", feature],
	["gh pr -R o/r merge 1", prOk],
	["gh pr --repo o/r create --fill", allowed],
	["gh pr merge 1 --auto --merge", mergeOk],
	["git merge origin/main", feature],
	["git -C ../x merge main", feature],
	["git cherry-pick abc", feature],
	["git revert abc", feature],
	["git pull", feature],
	["git pull --rebase", feature],
	["git rebase main", feature],
	["git am p.patch", feature],
	["git merge --continue", feature],
	["bash -c \"git merge main\"", feature],
	["git merge --no-verify x", committing],
];
for (const [cmd, ctx] of refused) test(`refuses: ${cmd}`, () => assert.notEqual(pushProblem(cmd, ctx), null));

const fine: [string, typeof feature][] = [
	["git push -u origin feat", allowed],
	["git push", allowed],
	["git commit -m x", committing],
	["git commit -am 'fix: thing'", committing],
	["git status", feature],
	["git log --oneline | head -3", feature],
	["echo git push", feature],
	["git commit -m 'set core.hooksPath on import'", committing],
	["git config user.name x", feature],
	["gh pr create --head flow/x --title t --body b", prOk],
	["gh pr merge 12 --merge --delete-branch", mergeOk],
	["gh pr view feat --json number,state", feature],
	["gh pr checks 12 --watch --fail-fast", feature],
	["gh api repos/o/r/pulls/12/merge", feature],
	["gh api repos/o/r/pulls", feature],
	["gh pr review 12 --comment -b ok", feature],
	["gh pr -R o/r view 1 --json state", feature],
	["gh pr merge 12 --merge --delete-branch -R o/r", mergeOk],
	["git merge --no-commit origin/main", feature],
	["git merge --squash x", feature],
	["git merge --abort", feature],
	["git cherry-pick -n abc", feature],
	["git revert --no-commit abc", feature],
	["git pull --ff-only", feature],
	["git pull --no-commit --no-rebase", feature],
	["git rebase --abort", feature],
	["git commit -m \"merge main\"", committing],
	["git merge --continue", committing],
	["git rebase main", committing],
];
for (const [cmd, ctx] of fine) test(`allows: ${cmd}`, () => assert.equal(pushProblem(cmd, ctx), null));

const branchOf = async () => "feat";
const single = (mode?: string) => ({ cwd: path.resolve("ra"), protectedBranches: ["main"], branchOf, modeOf: () => mode });

test("shellProblem: single repo push needs a delivery mode", async () => {
	assert.match((await shellProblem("git push", false, single())) ?? "", /workflow's job/);
	assert.equal(await shellProblem("git push", false, single("push")), null);
	assert.notEqual(await shellProblem("git push --force", false, single("push")), null);
});

test("shellProblem: several repos use each repo's own mode", async () => {
	const A = path.resolve("ra").replace(/\\/g, "/");
	const B = path.resolve("rb").replace(/\\/g, "/");
	const g = { roots: [A, B], cwd: A, protectedBranches: ["main"], branchOf, modeOf: (root?: string) => (root && repoKey(root) === repoKey(B) ? "push" : "commit") };
	assert.equal(await shellProblem(`git -C ${B} push`, false, g), null);
	assert.notEqual(await shellProblem(`git -C ${A} push`, false, g), null);
	assert.notEqual(await shellProblem("git push", false, g), null);
});

test("shellProblem: config env is refused", async () => {
	assert.notEqual(await shellProblem("GIT_CONFIG_COUNT=1 git commit", false, single("push")), null);
});

test("shellProblem: commit needs the commit step", async () => {
	assert.match((await shellProblem("git commit -m x", false, single())) ?? "", /workflow's job; it commits/);
	assert.equal(await shellProblem("git commit -m x", false, single("commit")), null);
	assert.equal(await shellProblem("git commit -m x", false, single("push")), null);
});

test("commit-creating refusal text", () => {
	const p = pushProblem("git merge main", feature) ?? "";
	assert.match(p, /creates a commit no judge has seen/);
	assert.match(p, /--no-commit/);
});

test("codeCommitProblem", () => {
	for (const code of ['execFileSync("git", ["merge", "main"])', 'spawnSync("git", ["cherry-pick", sha])', "run('git -c a=b merge x')", 'sh("git -C ../x pull")', "git rebase main"]) assert.match(codeCommitProblem(code) ?? "", /creates a commit no judge has seen/, code);
	for (const code of ['execFileSync("git", ["merge", "--no-commit", "x"])', 'run("git pull --ff-only")', 'const logs = run("git log --oneline"); logs.filter((l) => /merge/.test(l))', 'run("git merge-base a b")']) assert.equal(codeCommitProblem(code), null, code);
});

test("codeCommitProblem: a later safe call does not clear an earlier merge", () => {
	assert.notEqual(codeCommitProblem('execFileSync("git", ["merge", "main"]); execFileSync("git", ["merge", "--abort"])'), null);
});

test("codePublishProblem", () => {
	assert.match(codePublishProblem('execSync("git push origin main")') ?? "", /git push/);
	assert.match(codePublishProblem('execSync("gh pr create")') ?? "", /gh pr/);
	assert.match(codePublishProblem('execSync("git merge main")') ?? "", /commit/);
	assert.equal(codePublishProblem("console.log(1)"), null);
});

test("codeCommitProblem: chained and listed calls", () => {
	assert.notEqual(codeCommitProblem('run("git merge main && git merge --abort")'), null);
	assert.notEqual(codeCommitProblem('["git merge main", "git merge --abort"].forEach(run)'), null);
});

test("registryPublishProblem is wired into the guard module", async () => {
	const { registryPublishProblem, registryPublishCodeProblem } = await import("./push-guard.ts");
	assert.ok(registryPublishProblem("npm publish"));
	assert.ok(registryPublishCodeProblem("spawn('npm', ['publish'])"));
	assert.equal(registryPublishCodeProblem("console.log(1)"), null);
});
