<!-- pi-workflow plan v1 flow=20261029-1428-revert-the-workflow-repo-merge-gate-work-b813 -->
## Plan: Revert the workflow `--repo` merge-gate work (pi-config PRs #13, #14, #15)

### 1. Goal and non-goals
**Goal:**
- Undo pi-config PRs #13, #14 and #15 on `Unknownow/pi-config` with one revert PR merged into `master`.
- After the revert, `pi/` must equal its state at `47f33d9`.
- In `docs/workflow-improvements.md`:
  - D23 is kept as **Rejected**.
  - D24 is kept as an idea.
  - A new idea, D25, is added.
- The local checkout ends on `master`, clean.

**Non-goals:**
- Changing any other workflow code, or fixing the missing judge-pass record for a repo that joins a flow by edit. That is logged only, as D25.
- Touching any of these:
  - `pi-claude-bridge` or pi itself;
  - `~/.ssh`, `~/.gitconfig*` or the active gh account;
  - the port repos `D:/personal/game-studio-base` and `D:/personal/game-studio-unity`.
- Deleting `/tmp/ghcfg-unknownow`, which the port session still needs.
- Deleting local branches.

### 2. User decisions
- D1: Revert all three PRs (#13, #14, #15) on `Unknownow/pi-config`.
- D2: Do it with one revert PR on a branch, merged into `master` with a merge commit and delete-branch.
- D3: The docs follow `AGENTS.md`:
  - D23 is kept as **Rejected** (reverted).
  - D24 is kept as an idea.
  - The new D25 idea is added.
  - The Status line and the Effect measurement rows are updated in the same commit.
- D4: gh calls against Unknownow repos use only `GH_CONFIG_DIR=/tmp/ghcfg-unknownow`. Never run `gh auth switch`, and never print the token or `hosts.yml`.
- D5: The local checkout ends on `master`, fast-forwarded to `origin/master`.
- D6: The user restarts pi, ends this flow, and continues the port in a new session with the handoff.
- D7: `/tmp/ghcfg-unknownow` stays.

### 3. Facts the executor needs
- **Repo:** `D:/projects/pi-config`. The remote `origin` is `Unknownow/pi-config` and the default branch is `master`. The checkout is clean, on `flow/gate-push-wording-test` at `6b651c5`.
- **History:** `origin/master` = `98f4c57`. Its first-parent chain has no other commits:

  | Commit | What it is | First parent |
  |---|---|---|
  | `98f4c57` | PR #15 merge | `2164d75` |
  | `2164d75` | PR #14 merge | `e1490fa` |
  | `e1490fa` | PR #13 merge | `47f33d9` |
- **Files touched by the revert:** `git diff --stat 47f33d9 98f4c57` lists 8 files, +125 −9:
  - `docs/workflow-improvements.md`
  - `pi/agent/extensions/workflow/README.md`
  - `pi/agent/extensions/workflow/git-guard.ts`
  - `pi/agent/extensions/workflow/index.ts`
  - `pi/agent/extensions/workflow/merge-gate.ts`
  - `pi/agent/extensions/workflow/merge-gate.test.ts`
  - `pi/agent/extensions/workflow/push-guard.ts`
  - `pi/agent/extensions/workflow/push-guard.test.ts`
- **`docs/workflow-improvements.md` as it is at `47f33d9`, i.e. after the revert:**
  - Status line `:5`;
  - "Keeping this file current" rules `:7-9`;
  - backlog row D22 `:122`, then a blank line and `## Effect measurement` at `:124`;
  - Effect row D22 `:182`, followed by row A10 at `:183`.
- **Source text for the rows to put back** (at `98f4c57`): backlog rows D23 `:123` and D24 `:124`, Effect rows D23 `:185` and D24 `:186`. Read them with `git show 98f4c57:docs/workflow-improvements.md`.
- **Status line wording:**
  - At `98f4c57`: "…D21, D22 and D23 are implemented;…".
  - At `47f33d9`: "…D21 and D22 are implemented;…".
  - Both versions also contain "A1 is rejected;".
- **Rule source:** `AGENTS.md`, under "Workflow extension backlog", plus the rules section at `docs/workflow-improvements.md:7-9`. A rejected item gets a **Rejected:** note with the commit or file names, and a new finding gets the next free ID as an idea only.
- **Test command:** at `pi/agent/extensions/workflow/README.md:211` ("- Tests: `node --experimental-strip-types --test …`"). Run it from `pi/agent/extensions/workflow`. The Node summary lines start with `ℹ pass` and `ℹ fail`.
- **D25 evidence:** `D:/projects/pi-config/.git/pi/plans/20261029-1408-test-the-gate-s-protected-push-wording-m-e17f/status.json` lists only `d:/projects/pi-config` under `passedTrees`, `reviewBase` and `repos`. This was after the base repo joined the flow by an edit of `docs/studio/code-root-resolution.md`. Two judge passes on base, with `base: origin/main`, were followed by `Refused: merging pull request 3 is not judged: run judge, then retry.` The join path is `index.ts` `tool_result` → `touchedRepos`/`joinReviewBase`. The pass record is `recordPassedTrees`, which uses `state.lastJudge.repos`.

### 4. Design
None. This is a revert plus a doc edit.

### 5. Steps
**S1.** In `D:/projects/pi-config`:
1. Confirm `git status --short` is empty and note the branch.
2. Run `git fetch origin`, then `git checkout master` and `git merge --ff-only origin/master`. `git rev-parse --short HEAD` must print `98f4c57`. If it prints anything else, stop and report.
3. Create the branch `revert/workflow-gate-repo`.

**S2.** Run `git revert --no-commit -m 1 98f4c57 2164d75 e1490fa`, in that order, newest first.
- Then `git diff --cached --stat 47f33d9` must print nothing.
- If the revert conflicts, or if that diff is not empty, stop and report. Don't resolve it by hand.

**S3.** Edit `docs/workflow-improvements.md` with the `edit` tool. Don't use a heredoc.
1. **Backlog row D23:** insert it after row D22 (`:122`). Use the text of `98f4c57`'s row D23 (`:123`), with two changes:
   - Replace the **Done:** sentence with a **Rejected:** note: reverted in `revert(workflow): drop the --repo merge-gate mapping (PRs #13, #14, #15)` (files `push-guard.ts`, `merge-gate.ts`, `index.ts`, `git-guard.ts` and their tests). The reason: the gate still refused base PR #3, because a repo that joined the flow by an edit never got its judge pass recorded (D25).
   - Keep the other columns.
2. **Backlog row D24:** insert it after D23, with `98f4c57`'s text from `:124` unchanged.
3. **Backlog row D25:** insert it after D24, in the same column layout, starting with "Idea only:". It must say:
   - A repo that joins a flow by an `edit`/`write` (`index.ts` `tool_result` → `touchedRepos`, `joinReviewBase`) gets no judge pass in `passedTrees`.
   - Evidence: the flow `20261029-1408-…` `status.json` listed only pi-config after two passing judges of `game-studio-base`, and `gh pr merge 3 --repo Unknownow/game-studio-base` was refused as "not judged".
   - Candidate cause: `recordPassedTrees` takes `state.lastJudge.repos`, which may not include touched repos.
   - Value: Medium (R). Effort: S. Risk: Low.
4. **Status line (`:5`):**
   - Leave "D21 and D22 are implemented" as it is after the revert.
   - Change "A1 is rejected;" to "A1 and D23 are rejected;".
   - Don't list D24 or D25 by name; "the rest are ideas only" covers them.
5. **Effect measurement table:** after row D22 (`:182`), insert three rows:
   - D23: `98f4c57`'s `:185`, with the last column replaced by "Rejected (reverted); not measured".
   - D24: `98f4c57`'s `:186`, unchanged.
   - D25: "| D25 | judge pass for an edit-joined repo (idea) | Count 'not judged' refusals of merges in repos that joined a flow by edit, after a passing judge. | Zero; not measured |".
6. Run `git add docs/workflow-improvements.md`.
7. Then `git diff --cached --stat 47f33d9` must list only `docs/workflow-improvements.md`.

**S4.** Run the tests:
1. From `pi/agent/extensions/workflow`, run the full command at `README.md:211`. It must show `ℹ fail 0`.
2. From the repo root, `grep -rn "repoMatches\|REPO_UNKNOWN" pi/agent/extensions/workflow` must print nothing.
3. Call `judge` with focus: "Revert of PRs #13–#15: pi/ equals 47f33d9; docs keep D23 as Rejected, D24 idea, new D25 idea, per AGENTS.md."

**S5.** Deliver: merge — PR `revert/workflow-gate-repo` → `master` on `Unknownow/pi-config`.
- One commit, with the subject from §9.
- PR title: same as the commit subject. PR body: "Reverts e1490fa (#13), 2164d75 (#14), 98f4c57 (#15). Keeps D23 as Rejected and D24 as an idea, adds D25 in docs/workflow-improvements.md."
- Merge commit, delete-branch.
- All gh calls use the D4 `GH_CONFIG_DIR`. The merge is its own bash command.
- Afterwards, confirm the PR state is `MERGED`.

**S6.** Return to `master` and check the result:
1. `git checkout master`, then `git fetch origin` and `git merge --ff-only origin/master`.
2. `git status --short` must be empty.
3. `git diff --stat 47f33d9 HEAD -- pi/` must print nothing.
4. `git diff --stat 47f33d9 HEAD` must list only `docs/workflow-improvements.md`.

**S7.** Verify: restart pi so the reverted workflow extension loads — look for: no error on startup, and a `gh pr merge` refusal from another folder asks for a `cd` again (it no longer maps `--repo`).

**S8.** Verify: run `/flow end` in this session, then open a new session in `D:/personal/game-studio-base` and `D:/personal/game-studio-unity` and paste the port handoff — look for: the new session merges base PR #3 and continues the fork from the handoff.

### 6. Tests
No test is added or changed by hand. The revert removes the tests that PRs #13–#15 added to `merge-gate.test.ts` and `push-guard.test.ts`.

| Check | Command | Expected |
|---|---|---|
| Full suite (fast, well under 2 min) | The command at `pi/agent/extensions/workflow/README.md:211`, run from that folder | `ℹ fail 0` |
| Revert is clean | `git diff --cached --stat 47f33d9` after S2 | Empty |
| Revert is clean, after the doc edit | `git diff --cached --stat 47f33d9` after S3 | Only `docs/workflow-improvements.md` |
| No leftover code | `grep -rn "repoMatches\|REPO_UNKNOWN" pi/agent/extensions/workflow` | Empty |
| Merged result | `git diff --stat 47f33d9 HEAD -- pi/` on `master` after S6 | Empty |

### 7. Done when
- One revert PR on `Unknownow/pi-config` is `MERGED` into `master`, as a merge commit, with its branch deleted.
- On `master`, `pi/` is identical to `47f33d9`.
- `docs/workflow-improvements.md`:
  - D23 has a **Rejected:** note;
  - D24 is an idea;
  - D25 is a new idea row;
  - the Status line says "A1 and D23 are rejected";
  - the Effect measurement table has rows D23, D24 and D25.
- The workflow test suite reports `ℹ fail 0`.
- The local checkout is on `master`, at `origin/master`, and clean.
- `/tmp/ghcfg-unknownow`, `~/.ssh`, `~/.gitconfig*` and the active gh account are unchanged.

### 8. Risks, rollback, and what not to touch
**Risks:**
- **The live gate:** it is still PR #13's code until pi restarts. The S5 merge is in the working folder's own repo, so the gate applies normally after the judge pass. If it refuses after a pass, stop and report the exact message; don't use `cd` tricks or `git_task` to get around it.
- **Revert conflict:** if S2 conflicts, stop. Run `git revert --abort` and report.

**Rollback:**
- Before the merge: delete the local branch and check out `master`.
- After the merge: open a revert PR of the revert's merge commit.

**Don't touch:**
- Any other file in pi-config.
- The old flow folders under `.git/pi/plans/`; the port handoff reads the paused plan there.
- `pi-claude-bridge` and pi itself.
- `~/.ssh`, `~/.gitconfig*` and the active gh account.
- `/tmp/ghcfg-unknownow`.
- The port repos.
- The other local branches.

### 9. Commits
- `revert(workflow): drop the --repo merge-gate mapping (PRs #13, #14, #15)`. Files:
  - `pi/agent/extensions/workflow/{README.md,git-guard.ts,index.ts,merge-gate.ts,merge-gate.test.ts,push-guard.ts,push-guard.test.ts}`
  - `docs/workflow-improvements.md`

## Amendment 1 (executor: verify)
Restart pi to load the reverted extension; run /flow end; then start the port session in the two game-studio folders with the handoff.


<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `D:/projects/pi-config`:
- [x] S2 Run `git revert --no-commit -m 1 98f4c57 2164d75 e1490fa`, in that order, newest first.
- [x] S3 Edit `docs/workflow-improvements.md` with the `edit` tool. Don't use a heredoc.
- [x] S4 Run the tests:
- [x] S5 Deliver: merge — PR `revert/workflow-gate-repo` → `master` on `Unknownow/pi-config`.
- [x] S6 Return to `master` and check the result:
## For you after the flow
- S7 Verify: restart pi so the reverted workflow extension loads — look for: no error on startup, and a `gh pr merge` refusal
- S8 Verify: run `/flow end` in this session, then open a new session in `D:/personal/game-studio-base` and `D:/personal/game
