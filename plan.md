<!-- pi-workflow plan v1 flow=20261023-1205-record-a-protected-push-made-by-git-task-4049 -->
## Plan: Record a protected push made by `git_task` when the commit already existed locally

### 1. Goal and non-goals
**Goal:**
- A `git_task` run that pushes a judged HEAD to a protected branch records `{ commit, tree }` in `judgedMerges`, even when that HEAD was already committed locally before the task started. After that, `publish_packages` works.
- This fixes the judge's last finding (`merge-gate.ts:149`).

**Non-goals:**
- No other changes in behaviour.
- The stage 1 head race (`--match-head-commit`) is not fixed. It stays recorded as a risk in backlog row A35.
- No delivery: no commit, push, pull request or merge.
- No README or backlog edits.

### 2. User decisions
- **D1:** Fix only this bug (the protected push that `headBefore` drops).
- **D2:** Skip delivery for now. The branch `flow/judge-gated-self-delivery-replaces-the-c` keeps its last push, `27e3222`, and the fix stays uncommitted.
- **D3:** Use the fix the judge suggested: read a `remoteBefore` flag before the task and allow the fallback when `head !== headBefore || !remoteBefore`.

### 3. Facts the executor needs
- The working tree is clean (`git status --short` is empty). Code lives in `D:/projects/pi-config/pi/agent/extensions/workflow` (bash: `/d/projects/pi-config/pi/agent/extensions/workflow`).
- `merge-gate.ts:123`: `export async function recordJudged(run, dir, opts)`.
  - `merge-gate.ts:126`: the opts type is `{ startBranch: string; headBefore?: string; report: string; passed: string[]; protectedBranches: string[] }`.
  - `merge-gate.ts:146-149`: the protected-branch fallback. Line 149 is `if (head && head !== opts.headBefore && tree && opts.passed.includes(tree) && (await out("branch", "-r", "--contains", "HEAD"))) return { entry: { commit: head, tree }, pr };`.
- `index.ts:2673`: `const headBefore = new Map<string, string>();`.
  - `index.ts:2676`: inside the loop that runs before the task, `headBefore.set(r.root, (await git(r.dir, "rev-parse", "HEAD")).stdout.trim());`.
  - `index.ts:2704`: the `recordJudged(defaultRunner, r.dir, { startBranch: …, headBefore: headBefore.get(r.root), report: text, … })` call.
- `merge-gate.test.ts:181`: the `stub({ branch, pr?, trees, remote? })` Runner. The stub answers `git branch -r --contains` with `remote ?? ""`.
  - `merge-gate.test.ts:211`: the test "recordJudged: an unchanged HEAD on a protected branch records nothing".
  - `merge-gate.test.ts:216`: the test "recordJudged: a protected push of a passed tree that is on the remote is recorded".
- Files may use CRLF line endings. Keep each file's existing line endings.
- Typecheck: `/tmp/tsc/check.sh | grep -v TS2307`. It currently shows exactly 3 type errors that were there before this work: `index.ts` lines 1985, 1986 and 2264. The line numbers may move by a few lines after the edit.

### 4. Design
This adds one optional field to an existing interface:
- **Contract:** the opts type of `recordJudged` gains `remoteBefore?: boolean`, which means "a remote branch already contained HEAD before the task".
- **Fallback condition:** `head && (head !== opts.headBefore || !opts.remoteBefore) && tree && opts.passed.includes(tree) && <remote contains HEAD now>`.
- **Callers that omit `remoteBefore`:** it is falsy, so the fallback is allowed whenever the tree passed and the remote contains HEAD. That is the same as the behaviour before `headBefore` existed.
- **Rejected alternative:** recording in the subagent's `git-guard.ts`. That would need a channel from the subagent back to the main session's state, and none exists.

### 5. Steps
**S1.** `merge-gate.ts:123-149`, `recordJudged`:
- Add `remoteBefore?: boolean` to the opts type, after `headBefore`.
- Change the condition at line 149 to the one in section 4. Leave the rest of the line unchanged.
- Update the doc comment above the function (line ~122) to say that the protected-branch fallback needs HEAD to have moved, or to have reached the remote during the task.

**S2.** `index.ts:2673-2676` and `:2704`, the `git_task` `execute`:
- After `headBefore`, add `const remoteBefore = new Map<string, boolean>();`.
- In the same loop that runs before the task, after the `headBefore.set(...)` line, set `remoteBefore` for `r.root` to `!!(await git(r.dir, "branch", "-r", "--contains", "HEAD")).stdout.trim()`. Model it on line 2676.
- In the call at line 2704, pass `remoteBefore: remoteBefore.get(r.root)` after `headBefore: …`.

**S3.** `merge-gate.test.ts`:
- In the test at line 211, add `remoteBefore: true` to the opts. It must still expect `entry` to be `undefined`.
- After that test, add the new test from section 6.

**S4.** Run the tests and the typecheck from section 6. Then call `judge` with the focus "Record a protected push made by git_task when the commit already existed locally". End the turn after a PASS. Don't call `deliver` (D2).

### 6. Tests
**Changed test:** "recordJudged: an unchanged HEAD on a protected branch records nothing".
- Input: `stub({ branch: "main", trees: { HEAD: "c1", "HEAD^{tree}": "T" }, remote: "origin/main" })` with opts `{ startBranch: "main", headBefore: "c1", remoteBefore: true, report: "", passed: ["T"], protectedBranches: ["main"] }`.
- Expected: `.entry` is `undefined`.

**New test:** "recordJudged: an unchanged HEAD that only reached the remote during the task is recorded".
- Input: the same stub, with opts `{ startBranch: "main", headBefore: "c1", remoteBefore: false, report: "", passed: ["T"], protectedBranches: ["main"] }`.
- Expected: `.entry` deep-equals `{ commit: "c1", tree: "T" }`.

**Commands** (fast, under a minute):
- `cd /d/projects/pi-config/pi/agent/extensions/workflow && node --test *.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖"`. Expect `tests 636`, `pass 636` and `fail 0`. That is 635 tests plus the new one.
- `/tmp/tsc/check.sh | grep -v TS2307`. Expect only the 3 type errors that were already there.

### 7. Done when
- A `git_task` that only pushes an already-committed, judged HEAD to a protected branch records `{ commit, tree }` in `judgedMerges`.
- An unchanged HEAD that was already on a remote before the task still records nothing.
- `node --test *.test.ts` passes with 0 failures, and the judge passes.
- Nothing is committed or pushed.

### 8. Risks, rollback, and what not to touch
**Risk:** a HEAD already on a remote branch other than the protected one counts as `remoteBefore = true`, so a push of it to `main` during the task would not be recorded.
- `git branch -r --contains` matches any remote branch.
- This is accepted: it is rare, and the executor can recover by running `git push` itself, which the main session's gate records.

**Rollback:** `git checkout -- merge-gate.ts merge-gate.test.ts index.ts`.

**Do not touch:**
- `git-guard.ts` and `push-guard.ts`.
- The rest of the `recordJudged` candidate logic and the same-stage `pr` protection at `index.ts:~2706`.
- The README and `docs/workflow-improvements.md`.

### 9. Commits
- One commit, written only when delivery is asked for later: `fix(workflow): git_task records a protected push of an already-committed judged HEAD`. Files: `merge-gate.ts`, `merge-gate.test.ts`, `index.ts`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `merge-gate.ts:123-149`, `recordJudged`:
- [x] S2 `index.ts:2673-2676` and `:2704`, the `git_task` `execute`:
- [x] S3 `merge-gate.test.ts`:
- [x] S4 Run the tests and the typecheck from section 6. Then call `judge` with the focus "Record a protected push made by git_ta
## Outcome
2026-10-23T05:07:23.152Z — failed: committed (1 commit), pushed, no open pull request
