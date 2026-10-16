<!-- pi-workflow plan v1 flow=20261016-1230-commit-the-reviewed-wt-open-and-quit-rem-6953 -->
## Plan: Commit the reviewed `/wt open` and quit-reminder change

### 1. Goal and non-goals
**Goal**
- Commit the already-implemented and judge-passed `/wt open NAME` and quit-reminder change, so it no longer sits uncommitted in the working tree.

**Non-goals**
- No code, test or README changes. The diff is final as reviewed (judge: PASS).
- No split into two commits.
- No new branch, no pull request, no force-push, no skipping hooks.

### 2. User decisions
- D1: Commit the reviewed change ("now commit for me").
- D2: One commit. The planned two-commit split is dropped because both features touch the same seven files and partial staging is not allowed.
- D3 (earlier, unchanged): `/wt open NAME` reopens a set with `--continue` and `--add-dir`, there is a quit reminder, and quitting never auto-deletes worktrees. This is already implemented and stays as is.

### 3. Facts the executor needs
- Repo: `D:\projects\pi-config`. Branch: `master`. `HEAD` is `3fffd44` ("fix(workflow): deduplicate plan roots …").
- `git status --short` shows exactly these seven files, all already staged (`M ` in the index column) and with no further unstaged edits:
  - `README.md`
  - `pi/agent/extensions/worktree/README.md`
  - `pi/agent/extensions/worktree/index.ts`
  - `pi/agent/extensions/worktree/layout.ts`
  - `pi/agent/extensions/worktree/layout.test.ts`
  - `pi/agent/extensions/worktree/manage.ts`
  - `pi/agent/extensions/worktree/manage.test.ts`
- Tests were last run on this exact content:
  - worktree suite: 81 pass, 0 fail
  - `vscode/request.test.js`: 6 pass, 0 fail
- The judge returned PASS on this diff.
- The earlier commit attempt was refused because a push to `master` was chained onto it. The commit itself never ran.

### 4. Design
Not applicable. This change adds or reshapes no components.

### 5. Steps
**S1.** Run `git status --short` in `D:\projects\pi-config` to check the tree.
- Expect exactly the seven files from section 3, all staged, and nothing else.
- If any other file appears, or one of the seven also has unstaged changes, stop and report. Do not stage or discard anything else.

**S2.** Re-run the tests from section 6 on the staged content.
- If any test fails, stop and report. Do not edit code.

**S3.** Hand over to the workflow's delivery, which creates the commit with the subject from section 9 and pushes it. Do not run `git commit` or `git push` yourself.
- The commit must contain exactly the seven files.
- No `--no-verify`, no amend, no force-push.

### 6. Tests
There are no new or changed tests. Re-run the existing ones from `pi/agent/extensions/worktree`:

```
node --experimental-strip-types --test config.test.ts layout.test.ts files.test.ts git-ops.test.ts manage.test.ts unity-guard.test.ts vscode-bridge.test.ts
node --test vscode/request.test.js
```

Expected output: `ℹ tests 81`, `ℹ pass 81`, `ℹ fail 0`, then `ℹ pass 6`, `ℹ fail 0`.

### 7. Done when
- `git log -1` on `master` shows one new commit on top of `3fffd44`. Its subject is the one in section 9, and it contains exactly the seven files from section 3.
- `git status --short` is empty for those files afterwards.
- All tests in section 6 pass.
- No file content differs from the judge-passed diff.

### 8. Risks, rollback, what not to touch
- **Risk:** pushing to protected `master` may be refused again. The local commit still stands; report the refusal instead of creating a branch or force-pushing.
- **Rollback:** `git revert <commit>`, or `git reset --soft HEAD~1` if it has not been pushed.
- **Do not touch:**
  - any source, test or README content
  - other files in the repo, including `local/sync-state.json` and `.git/pi/plans/`
  - git config and hooks

### 9. Commits
1. `feat(worktree): /wt open NAME reopens a worktree set with pi --continue, and quitting reminds that the set is on disk`. Files:
   - `README.md`
   - `pi/agent/extensions/worktree/README.md`
   - `pi/agent/extensions/worktree/index.ts`
   - `pi/agent/extensions/worktree/layout.ts`
   - `pi/agent/extensions/worktree/layout.test.ts`
   - `pi/agent/extensions/worktree/manage.ts`
   - `pi/agent/extensions/worktree/manage.test.ts`

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Run `git status --short` in `D:\projects\pi-config` to check the tree.
- [ ] S2 Re-run the tests from section 6 on the staged content.
- [ ] S3 Hand over to the workflow's delivery, which creates the commit with the subject from section 9 and pushes it. Do not run
