<!-- pi-workflow plan v1 flow=20261103-2314-re-judge-the-maze-flow-template-update-o-efd3 -->
## Plan: Re-judge the maze-flow template update on `main`, then return to `release/android`

### Goal
- The judge reviews the change maze-flow actually merged (PR #113, `1cc70654..a40722c9` on `main`) and passes.
- The maze-flow checkout ends on `release/android` at `c49b255e`, clean.

### Not part of this plan
- **No code or doc changes.** The update is already merged.
- **No change to `release/android`:** no commit, merge, pull or push.
- **The pre-push `ab-tests.mjs check` question stays open** until you choose: either add the step (`iec.mjs` `checkFlow` and `check-scope.mjs`, a new template PR, then a game update), or reword the "pre-push check" lines in game-template `AGENTS.md` and the playbook.
- **The Edit tests window still needs your manual check** in a live Editor (amendment 2).

### Facts
- **`main`:** maze-flow's local `main` and `origin/main` are both at `a40722c9`, which is the merge of PR #113. The update commit is `08cd2935` ("Update from game-template 308d082..5ea712f"), and the base before it is `1cc70654`.
- **Checkout:** `release/android` at `c49b255e`, clean (`git status -sb`).
- **Why the judge failed:** it only reviews the checked-out files, and with `release/android` checked out it compared the wrong tree in both rounds (round 2 said so: `.git/HEAD:1`). It doesn't review other worktrees.
- **Already checked on an export of `a40722c9`:**
  - the A/B files are present;
  - `ab-tests.mjs check` passes;
  - `check-build-config --platform android` reports no A/B problems;
  - `generate` leaves the generated file unchanged;
  - the update reported "Conflicts: none".

### Steps
**S1. Check out `main`.**
- In `D:/projects/maze-flow`, run `git status -sb`. If anything is uncommitted, stop and ask.
- `git switch main`, then confirm `git rev-parse --short HEAD` is `a40722c9`. Don't pull.

**S2. Checks and judge on `main`.**
- In the checkout:
  - `node scripts/ab-tests.mjs check` exits 0;
  - `node scripts/check-build-config.mjs --platform android` shows no A/B problems;
  - `node scripts/ab-tests.mjs generate`, then `git status --short` is empty.
- Run `judge` with `base: 1cc70654`, describing the change as PR #113, already merged.
  - **Blocker or major:** stop and report. A fix would need a new branch and PR from `main`, which is not part of this plan.
  - **Minors:** list them in the report.

**S3. Return to `release/android`.**
- `git switch release/android`.
- Confirm HEAD is `c49b255e` and `git status -sb` is clean.

### Tests
- The S2 commands and the judge verdict.

### Done when
- The judge returns PASS on `1cc70654..a40722c9`.
- maze-flow is back on `release/android` at `c49b255e`, clean.

### Risks and what not to touch
- **Leaving the checkout on `main`:** S3 runs whatever S2 returns.
- **`generate` writing a change:** if it does, restore the file with `git checkout -- <file>` before switching, and report it.
- **Don't touch:**
  - `release/android`;
  - maze-flow's open PRs #110, #109, #108 and #100;
  - the existing worktrees.

### Commits
None.

**Publish:** none.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Check out `main`.
- [ ] S2 Checks and judge on `main`.
- [ ] S3 Return to `release/android`.
