// node --experimental-strip-types --test worker-guard.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { reviewerRefusal } from "./reviewer.ts";
import { append, inboxPath } from "./mailbox.ts";
import { DEFAULT_SENSITIVE_PATHS } from "./config.ts";
import { loadFacts, waitReply, workerCommandProblem, workerPathProblem, type GuardFacts } from "./worker-guard.ts";
import { cleanup, tmpDir } from "./test/helpers.ts";

const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({ branches: ["wt/r1"], bases: ["abcdef1234567890"], sensitivePaths: DEFAULT_SENSITIVE_PATHS, authority: {}, approvals: [], ...over });
const bad = (c: string, f = facts()) => workerCommandProblem(c, f);

test("always refused: git push, gh writes, publish, branch deletion, moving to another ref", () => {
	assert.match(bad("git push origin HEAD") ?? "", /ask_lead/);
	assert.match(bad("git push --force-with-lease origin HEAD:x") ?? "", /git push/);
	assert.match(bad("gh pr create --title x") ?? "", /gh pr/);
	assert.match(bad("gh pr merge 3") ?? "", /gh pr/);
	assert.match(bad("gh api -X POST repos/a/b/issues/1/comments -f body=x") ?? "", /gh writes/);
	assert.match(bad("gh release create v1") ?? "", /not allowed/);
	assert.match(bad("npm publish") ?? "", /publish/);
	assert.match(bad("git branch -D old") ?? "", /deleting a branch/);
	assert.match(bad("git checkout main") ?? "", /stay on the job's branch/);
	assert.match(bad("git switch other") ?? "", /stay on/);
	assert.match(bad("git reset --hard origin/main") ?? "", /stay on/);
	assert.match(bad("git checkout -b new") ?? "", /creating a branch/);
});

test("a shell -c is checked by its inner text", () => {
	assert.match(bad('bash -c "git push origin HEAD:x"') ?? "", /git push/);
	assert.match(bad("sh -c 'gh pr create --title x'") ?? "", /gh pr/);
	assert.match(bad('pwsh -Command "git push origin x"') ?? "", /git push/);
	assert.match(bad("bash -c") ?? "", /without a command text/);
	assert.match(bad('bash -lc "npm install left-pad"') ?? "", /needs the lead's approval/);
	assert.equal(bad('bash -c "git status && npm test"'), undefined);
});

test("in a multi-repo set a sensitive glob is matched inside the repo that holds the file", () => {
	const set = path.resolve("/w/set");
	const f = facts({ worktrees: [path.join(set, "repoA"), path.join(set, "repoB")] });
	assert.match(workerPathProblem("repoB/.github/workflows/ci.yml", set, f) ?? "", /\.github\/workflows\/ci\.yml is a sensitive path \(formats\)/);
	assert.match(workerPathProblem(path.join(set, "repoA", "package.json"), set, f) ?? "", /package\.json is a sensitive path \(deps\)/);
	assert.equal(workerPathProblem("repoA/src/a.ts", set, f), undefined);
});

test("allowed: reads, commits, the job branch and base, file restores", () => {
	for (const c of ["git status", "git commit -am x", "git log --oneline", "gh pr view 3", "gh pr checks", "gh api repos/a/b/pulls/1", "git checkout wt/r1", "git checkout abcdef12", "git reset --hard HEAD~1", "git reset", "git checkout -- a.txt", "git checkout HEAD -- a.txt", "npm test", "node build.js", "rm -rf build"]) assert.equal(bad(c), undefined, c);
});

test("dependency installs need approval; an approval or Authority lets them through", () => {
	assert.match(bad("npm install left-pad") ?? "", /needs the lead's approval/);
	assert.equal(bad("npm install"), undefined);
	assert.equal(bad("npm install left-pad", facts({ authority: { deps: { value: "yes" } } })), undefined);
	const item = "npm install left-pad";
	assert.equal(bad(item, facts({ approvals: [{ at: "", item, category: "deps", by: "lead", reason: "" }] })), undefined);
});

test("edits to sensitive paths are refused until approved", () => {
	const cwd = path.resolve("/w/set");
	assert.match(workerPathProblem("package.json", cwd, facts()) ?? "", /ask_lead with approval \{category: "deps", item: "package\.json"/);
	assert.match(workerPathProblem(path.join(cwd, ".github/workflows/ci.yml"), cwd, facts()) ?? "", /formats/);
	assert.equal(workerPathProblem("src/a.ts", cwd, facts()), undefined);
	assert.equal(workerPathProblem("package.json", cwd, facts({ approvals: [{ at: "", item: "package.json", category: "deps", by: "lead", reason: "" }] })), undefined);
	assert.equal(workerPathProblem("package.json", cwd, facts({ authority: { deps: { value: "yes" } } })), undefined);
	assert.equal(workerPathProblem(path.resolve("/elsewhere/package.json"), cwd, facts()), undefined, "outside the worker's folder is not its guard's business");
});

test("loadFacts reads job.json, brief.md authority and guard.json fresh", () => {
	const d = tmpDir();
	fs.writeFileSync(path.join(d, "job.json"), JSON.stringify({ v: 1, id: "r1", repos: [{ branch: "wt/r1", base: "abc1234" }], approvals: [{ category: "deps", item: "x" }] }));
	fs.writeFileSync(path.join(d, "guard.json"), JSON.stringify({ sensitivePaths: ["**/x"] }));
	fs.writeFileSync(path.join(d, "brief.md"), "## Authority\n- deps: yes\n- merge: no\n");
	const f = loadFacts(d);
	assert.deepEqual([f.branches, f.bases, f.sensitivePaths, f.authority.deps?.value, f.approvals.length], [["wt/r1"], ["abc1234"], ["**/x"], "yes", 1]);
	assert.deepEqual(loadFacts(path.join(d, "none")).branches, []);
	cleanup(d);
});

test("waitReply returns the reply, and undefined when aborted", async () => {
	const d = tmpDir();
	setTimeout(() => append(inboxPath(d), { type: "answer", replyTo: "q1", text: "yes" }), 60);
	const r = await waitReply(d, "q1", undefined, 20);
	assert.equal(r?.type === "answer" && r.text, "yes");
	const ac = new AbortController();
	setTimeout(() => ac.abort(), 40);
	assert.equal(await waitReply(d, "nope", ac.signal, 20), undefined);
	cleanup(d);
});

test("reviewer: only reading tools and the listed knowledge tools", () => {
	for (const t of ["read", "grep", "find", "ls"]) assert.equal(reviewerRefusal(t), undefined);
	for (const t of ["bash", "edit", "write", "run_code"]) assert.match(reviewerRefusal(t) ?? "", /not available to a reviewer/);
	assert.equal(reviewerRefusal("mcp__knowledge__search", ["mcp__knowledge__search"]), undefined);
	assert.match(reviewerRefusal("mcp__knowledge__propose_entry", ["mcp__knowledge__search"]) ?? "", /not available/);
});
