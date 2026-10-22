<!-- pi-workflow plan v1 flow=20261022-1230-fast-forward-master-to-the-flow-branch-c8ac -->
## Plan: Fast-forward `master` to the flow branch

### 1. Goal and non-goals
**Goal**
- `origin/master` of pi-config gets every commit on `flow/runnergate-test-covers-a-newcomer-arrivi`, which ends at `b0a92e8`. That includes the stage 1 wait-check fix (`ca46f8d`), autopilot (`a4cc6f5`) and the config switch (`b0a92e8`), plus the 18 earlier commits on the branch.

**Non-goals**
- No file changes and no new commits in the repo.
- No force push, no rewriting history, no deleting the flow branch.
- No change to the deployed `~/.pi/agent` files. They already match the repo.
- No `/reload` of any session.

### 2. User decisions
- **D1:** Turn autopilot on. It is already `"autopilot": true` in `pi/agent/workflow.json:53` and `~/.pi/agent/workflow.json:53`.
- **D2:** Push it to pi-config.
- **D3:** Merge straight into `master` (option 2), including the 18 earlier commits on the branch, instead of opening a PR for review.

### 3. Facts the executor needs
- Repo: `D:/projects/pi-config`. The current branch is `flow/runnergate-test-covers-a-newcomer-arrivi` and the working tree is clean (`git status --short` prints nothing).
- `origin/flow/runnergate-test-covers-a-newcomer-arrivi` is at `b0a92e8 chore(config): turn on workflow autopilot`.
- `git rev-list --count origin/master..HEAD` = 21 and `git rev-list --count HEAD..origin/master` = 0. The merge is therefore a pure fast-forward.
- No PR exists for the branch (`gh pr list --head flow/runnergate-test-covers-a-newcomer-arrivi` returned `[]`).
- The remote's default branch is `master`.
- Pushing from your own shell is refused. Publish with the `deliver` tool.

### 4. Design
Not needed: nothing in the code changes.

### 5. Steps
**S1.** Check before merging:
- Run `git fetch origin`, then confirm `git status --short` is empty.
- Confirm `git rev-list --count HEAD..origin/master` is `0`.
- Confirm `git rev-parse HEAD` equals `git rev-parse origin/flow/runnergate-test-covers-a-newcomer-arrivi`.

If any of these fails, stop and report. Do not rebase, merge `master` into the branch, or force anything.

**S2.** Deliver: fast-forward merge of `flow/runnergate-test-covers-a-newcomer-arrivi` into `master` on `origin`.
- Use `deliver` with `mode: "merge"` and `step: "S2"`.
- If it opens a PR on the way, the PR must merge without a squash so that `master` ends at the branch's commits.
- If a fast-forward is impossible, stop and report. Do not create a merge commit by hand.

**S3.** Check the result, read-only:
- Run `git fetch origin`.
- `git rev-list --count origin/master..b0a92e8` must be `0`, which means `master` contains `b0a92e8`.
- `git show origin/master:pi/agent/workflow.json | grep -n '"autopilot": true'` must print one line.

### 6. Tests
No code changes, so no new tests. Optionally, sanity-run the README test command in `pi/agent/extensions/workflow`: `node --experimental-strip-types --test *.test.ts`. The expected output is `ℹ pass 588` and `ℹ fail 0`.

### 7. Done when
- `origin/master` contains `b0a92e8` and all 21 branch commits (D2, D3).
- `pi/agent/workflow.json` on `origin/master` has `"autopilot": true` (D1).
- No new commit holds file changes, and nothing was force-pushed.

### 8. Risks, rollback, and what not to touch
- **Risk:** the 18 earlier commits go onto `master` without a separate review. The user accepted this (D3). The last three commits each passed the judge.
- **Risk:** `master` may move before the merge. S1 catches that, and the executor stops.
- **Rollback:** reset `master` to its tip from before the merge with a force push. Do this only if the user asks.
- **Don't touch:** any files, the deployed `~/.pi/agent`, unity-packages, amazon-sdk worktrees, running sessions, or the flow branch itself.

### 9. Commits
None. The merge publishes the existing commits `ca46f8d`, `a4cc6f5`, `b0a92e8` and the 18 earlier branch commits unchanged.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Check before merging:
- [ ] S2 Deliver: fast-forward merge of `flow/runnergate-test-covers-a-newcomer-arrivi` into `master` on `origin`.
- [ ] S3 Check the result, read-only:
