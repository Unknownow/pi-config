// node --test push-guard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { pushProblem } from "./push-guard.ts";

const feature = { branch: "feat", protectedBranches: ["main", "master"], pushAllowed: false, prAllowed: false, mergeAllowed: false };
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
];
for (const [cmd, ctx] of refused) test(`refuses: ${cmd}`, () => assert.notEqual(pushProblem(cmd, ctx), null));

const fine: [string, typeof feature][] = [
	["git push -u origin feat", allowed],
	["git push", allowed],
	["git commit -m x", feature],
	["git commit -am 'fix: thing'", feature],
	["git status", feature],
	["git log --oneline | head -3", feature],
	["echo git push", feature],
	["git commit -m 'set core.hooksPath on import'", feature],
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
];
for (const [cmd, ctx] of fine) test(`allows: ${cmd}`, () => assert.equal(pushProblem(cmd, ctx), null));
