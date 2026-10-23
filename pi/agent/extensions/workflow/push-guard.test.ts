// node --test push-guard.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { codePublishProblem, mergeTarget, pushProblem, pushSource, shellProblem, type GateRequest } from "./push-guard.ts";
import { repoKey } from "./repos.ts";

const feature = { branch: "feat", protectedBranches: ["main", "master"] };
const onMain = { ...feature, branch: "main" };

const refused: [string, typeof feature][] = [
	["git push -f", feature],
	["git push --force-with-lease", feature],
	["git push --force-if-includes origin feat", feature],
	["git push origin +feat", feature],
	["git push origin :feat", feature],
	["git push origin feat --delete", feature],
	["git push --all", feature],
	["git push --no-verify", feature],
	["bash -c 'git push -f'", feature],
	["bash -lc 'git push -f'", feature],
	["git commit -nm x", feature],
	["git commit --no-verify -m x", feature],
	["git commit -n -m x", feature],
	["git -c core.hooksPath=/dev/null commit -m x", feature],
	["git config core.hooksPath /dev/null && git commit -m x", feature],
	["git config --unset core.hooksPath", feature],
	["GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", feature],
	["export GIT_CONFIG_PARAMETERS=x; git commit -m x", feature],
	["env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x", feature],
	["$env:GIT_CONFIG_COUNT=1; git commit -m x", feature],
	["git config --global include.path /tmp/x", feature],
	["$env:git_config_count=1; git commit -m x", feature],
	["git $c -m x", feature],
	["git com''mit -nm x", feature],
	["git @a", feature],
	["gh pr merge 12 --merge --admin", feature],
	["gh pr review 12 --approve", feature],
	["gh pr review 12 -a", feature],
	["gh api -X PUT repos/o/r/pulls/12/merge", feature],
	["gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'", feature],
	["gh pr merge 1 --auto --merge", feature],
	["git merge --no-verify x", feature],
	["git pull --no-verify", feature],
	["git push from_detached", { ...feature, branch: "HEAD" }],
	["gh alias set m 'pr merge --admin'", feature],
	["git commit -am x && git push origin HEAD:main", feature],
	["git push && gh pr merge 12 --merge", feature],
	["echo x >> a.ts && gh pr merge 12 --merge", feature],
	["git pull && git push origin HEAD:main", feature],
	["git switch main && git merge flow/x && git push", feature],
	["git checkout main && git push origin HEAD", feature],
	["bash -c \"git checkout main && git push\"", feature],
	["gh pr merge 12 --delete-branch && git push", feature],
	["bash -c \"git switch main\" && git push", feature],
	["bash -c \"git commit -am x && git push\" && gh pr merge 12 --merge", feature],
	["bash -c \"git commit -am x\" && git push origin HEAD:main", feature],
	["git symbolic-ref HEAD refs/heads/unjudged && git push origin HEAD:main", feature],
	["git branch -f feature abc123 && git push origin feature:main", feature],
	["git branch newone && git push origin HEAD:main", feature],
	["git fetch origin x:refs/heads/feature && git push origin feature:main", feature],
	["git remote add o2 /tmp/x && git push origin HEAD:main", feature],
	["bash -c \"git commit -am x && git push origin HEAD:main\"", feature],
	["git push --tags", feature],
	["git push --follow-tags", feature],
	["git push origin refs/tags/a:refs/tags/a", feature],
	["git config push.default upstream", feature],
	["git config alias.p push", feature],
	["git -c alias.p=push p origin HEAD:main", feature],
	["git branch -u origin/main", feature],
	["git branch --set-upstream-to=origin/main", feature],
	["git config branch.feat.merge refs/heads/main", feature],
	["git config remote.origin.push HEAD:refs/heads/main", feature],
	["git -c push.default=upstream push", feature],
	["git -c remote.origin.push=HEAD:main push", feature],
	["git push origin tag v1", feature],
];
for (const [cmd, ctx] of refused) test(`refuses: ${cmd}`, () => assert.notEqual(pushProblem(cmd, ctx), null));

const fine: [string, typeof feature][] = [
	["git push -u origin feat", feature],
	["git push -u origin flow/add-the-thing", feature],
	["git push -u origin release/v2", feature],
	["git config --get push.default", feature],
	["git config --get alias.p", feature],
	["git branch -a", feature],
	["git push", feature],
	["git commit -m x", feature],
	["git commit -am 'fix: thing'", feature],
	["git status", feature],
	["git log --oneline | head -3", feature],
	["echo git push", feature],
	["git commit -m 'set core.hooksPath on import'", feature],
	["git config user.name x", feature],
	["gh pr create --head flow/x --title t --body b", feature],
	["gh pr create --fill", feature],
	["gh pr view feat --json number,state", feature],
	["gh pr checks 12 --watch --fail-fast", feature],
	["gh api repos/o/r/pulls/12/merge", feature],
	["gh api repos/o/r/pulls -f title=x -f head=b -f base=main", feature],
	["gh pr review 12 --comment -b ok", feature],
	["gh pr -R o/r view 1 --json state", feature],
	["git merge origin/main", feature],
	["git pull", feature],
	["git pull --rebase", feature],
	["git rebase main", feature],
	["git cherry-pick abc", feature],
	["git revert abc", feature],
	["git am p.patch", feature],
	["git merge --continue", feature],
	["git commit -m \"merge main\"", feature],
];
for (const [cmd, ctx] of fine) test(`allows: ${cmd}`, () => assert.equal(pushProblem(cmd, ctx), null));

const gated = (cmd: string, ctx: { branch: string; protectedBranches: string[] }): GateRequest[] => {
	const gates: GateRequest[] = [];
	assert.equal(pushProblem(cmd, { ...ctx, gates }), null, cmd);
	return gates.filter((g) => g.kind !== "tag-check" && g.kind !== "head-push");
};

test("gate requests: merges and protected pushes", () => {
	assert.deepEqual(gated("gh pr merge 12 --merge", feature), [{ kind: "merge", target: "12" }]);
	assert.deepEqual(gated("gh pr merge --merge", feature), [{ kind: "merge", target: undefined }]);
	assert.deepEqual(gated("gh pr merge 12 --merge --delete-branch -R o/r", feature), [{ kind: "merge", target: "12", repo: "o/r" }]);
	assert.deepEqual(gated("gh pr -R o/r merge 1", feature), [{ kind: "merge", target: "1", repo: "o/r" }]);
	assert.deepEqual(gated("git push origin HEAD:main", feature), [{ kind: "protected-push", target: "HEAD" }]);
	assert.deepEqual(gated("git push", onMain), [{ kind: "protected-push", target: "HEAD" }]);
	assert.deepEqual(gated("git push origin feature:master", feature), [{ kind: "protected-push", target: "feature" }]);
	assert.deepEqual(gated("git push origin main", feature), [{ kind: "protected-push", target: "main" }]);
	assert.deepEqual(gated("git push origin HEAD", onMain), [{ kind: "protected-push", target: "HEAD" }]);
	assert.deepEqual(gated("git push -u origin feat", feature), []);
	assert.deepEqual(gated("bash -c 'gh pr merge 3'", feature), [{ kind: "merge", target: "3" }]);
});

test("a merge or protected push may share a command line only with commands that change nothing", () => {
	for (const cmd of ["cd /r && gh pr merge 12 --merge", "gh pr checks 12 --watch --fail-fast && gh pr merge 12 --merge --delete-branch", "git status && git push origin HEAD:main", "git fetch && gh pr view 12 && gh pr merge 12", "git branch --show-current && git symbolic-ref HEAD && git remote -v && gh pr merge 12", "bash -c \"git status\" && gh pr merge 12"]) {
		const gates: GateRequest[] = [];
		assert.equal(pushProblem(cmd, { ...feature, gates }), null, cmd);
		assert.ok(gates.some((g) => g.kind !== "tag-check"), cmd);
	}
	assert.match(pushProblem("git commit -am x && git push origin HEAD:main", { ...feature, gates: [] }) ?? "", /its own command/);
});

test("a push to the current branch may follow commits, pulls and reads, but not a branch switch", () => {
	for (const cmd of ["git status && git push", "git add -A && git commit -m x && git push", "git commit -m x && git push origin HEAD", "git pull && git push -u origin feat", "git merge origin/main && git push"]) assert.equal(pushProblem(cmd, { ...feature, gates: [] }), null, cmd);
	assert.match(pushProblem("git switch other && git push", { ...feature, gates: [] }) ?? "", /own command/);
});

test("mergeTarget and pushSource", () => {
	assert.equal(mergeTarget(["12", "--merge"]), "12");
	assert.equal(mergeTarget(["--merge"]), undefined);
	assert.equal(mergeTarget(["-R", "o/r", "feat"]), "feat");
	assert.equal(pushSource("a:main"), "a");
	assert.equal(pushSource("main"), "main");
});

const branchOf = async () => "feat";
const single = (gate: (kind: string, root: string | undefined, target: string | undefined) => Promise<string | null> = async () => null) => ({ cwd: path.resolve("ra"), protectedBranches: ["main"], branchOf, gate });

test("shellProblem: the gate decides merges and protected pushes", async () => {
	const calls: string[] = [];
	const deny = async (kind: string, _root: string | undefined, target: string | undefined) => {
		calls.push(`${kind}:${target}`);
		return "no";
	};
	assert.equal(await shellProblem("gh pr merge 12 --merge", false, single(deny)), "no");
	assert.equal(await shellProblem("gh pr merge --merge", false, single(deny)), "no");
	assert.equal(await shellProblem("git push origin HEAD:main", false, single(deny)), "no");
	assert.deepEqual(calls, ["merge:12", "merge:undefined", "protected-push:HEAD"]);
	assert.equal(await shellProblem("gh pr merge 12 --merge", false, single()), null);
	assert.equal(await shellProblem("git push -u origin feat", false, single(deny)), null);
	assert.equal(await shellProblem("git commit -m x", false, single(deny)), null);
	assert.notEqual(await shellProblem("git push --force", false, single()), null);
});

test("shellProblem: several repos pass each repo's root to the gate", async () => {
	const A = path.resolve("ra").replace(/\\/g, "/");
	const B = path.resolve("rb").replace(/\\/g, "/");
	const seen: (string | undefined)[] = [];
	const g = { roots: [A, B], cwd: A, protectedBranches: ["main"], branchOf, gate: async (_k: string, root: string | undefined) => (seen.push(root), root && repoKey(root) === repoKey(B) ? null : "no") };
	assert.equal(await shellProblem(`git -C ${B} push origin HEAD:main`, false, g), null);
	assert.equal(await shellProblem(`git -C ${A} push origin HEAD:main`, false, g), "no");
	assert.equal(seen.length, 2);
});

test("shellProblem: config env is refused", async () => {
	assert.notEqual(await shellProblem("GIT_CONFIG_COUNT=1 git commit", false, single()), null);
});

test("codePublishProblem", () => {
	assert.match(codePublishProblem('execSync("git push origin main")') ?? "", /git push/);
	assert.match(codePublishProblem('execSync("gh pr merge 3")') ?? "", /merges a pull request/);
	assert.equal(codePublishProblem('execSync("git merge main")'), null);
	assert.equal(codePublishProblem('execSync("git commit -m x")'), null);
	assert.equal(codePublishProblem('execSync("gh pr create")'), null);
	assert.equal(codePublishProblem("console.log(1)"), null);
});

test("registryPublishProblem is wired into the guard module", async () => {
	const { registryPublishProblem, registryPublishCodeProblem } = await import("./push-guard.ts");
	assert.ok(registryPublishProblem("npm publish"));
	assert.ok(registryPublishCodeProblem("spawn('npm', ['publish'])"));
	assert.equal(registryPublishCodeProblem("console.log(1)"), null);
});

test("a gated command pointing at another folder is refused when its root is unknown", async () => {
	const g = single();
	assert.match((await shellProblem("cd ../x && git push origin HEAD:main", false, g)) ?? "", /working folder/);
	assert.match((await shellProblem("git -C ../x push origin HEAD:main", false, g)) ?? "", /working folder/);
	assert.match((await shellProblem("cd ../x && gh pr merge 12", false, g)) ?? "", /working folder/);
	assert.equal(await shellProblem("gh pr merge 12 --merge", false, g), null);
	assert.equal(await shellProblem("cd ../x && git push -u origin feat", false, g), null);
	assert.equal(await shellProblem("cd . && gh pr merge 12", false, g), null);
	assert.equal(await shellProblem(`git -C ${path.resolve("ra")} push origin HEAD:main`, false, g), null);
});

test("a push to a name that is a tag is refused through isTag", async () => {
	const asked: string[] = [];
	const g = { ...single(), isTag: async (_root: string | undefined, name: string) => (asked.push(name), name === "unity-build/v1.0.9") };
	assert.match((await shellProblem("git push origin unity-build/v1.0.9", false, g)) ?? "", /tags are created or moved with deliver/);
	assert.equal(await shellProblem("git push origin release/v2", false, g), null);
	assert.equal(await shellProblem("git push -u origin feat", false, g), null);
	assert.deepEqual(asked, ["unity-build/v1.0.9", "release/v2", "feat"]);
});
