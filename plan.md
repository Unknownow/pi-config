<!-- pi-workflow plan v1 flow=20261103-0925-fix-the-stale-base-comment-in-game-templ-bad4 -->
## Plan: Fix the stale `--base` comment in game-template's `check-rules.mjs`

This fixes finding no. 1 from the rules review. It changes comments only, so nothing behaves differently.

### Goal and non-goals
- **Goal:** the comments in `scripts/check-rules.mjs` describe what `--base` does now. The `new_code_only` mention left over from the retired A6/A7 rules goes away.
- **Non-goals:**
  - No code changes. This includes the unused `changedLines` call at `:681`.
  - No edits in shiny-loop or maze-flow. They get the change with their next template update.
  - Your maze-flow `release/android` checkout stays as it is.

### Facts
- game-template is on `main` at `308d082`, the same as `origin/main`, and its tree is clean.
- `scripts/check-rules.mjs:22-23` says `--base` makes rules marked `new_code_only` report only changed code. No rule has that key any more, and `git grep new_code_only` finds only this line.
- **Where `--base` is still used:**
  - `pinsBelowBase` for `eng.rule.no-package-downgrades` (`:588`).
  - The hook's changed-file filter (`:227`, `:655-656`).
  - Without `--hook`, every rule checks the whole tree. The changed lines computed at `:681` are not used by any check.
- `:217` says `changed` is "or null to check all code". That suggests it filters code, but only `scanChangedOnly` (the hook) uses it.

### Steps
**S1.** On a new branch `flow/check-rules-base-comment` from `origin/main` in `D:/projects/game-template`, edit `scripts/check-rules.mjs`:
- Replace `:22-23` with:
  ```
  // --base <ref>: the base for eng.rule.no-package-downgrades (a pin below the one at <ref> fails) and, with
  //   --hook, the changes the report is limited to. Every other rule checks the whole tree.
  ```
- Replace `:217` with:
  `// changed: Map<file, Set<line> | "all"> from changedLines(), or null; only the agent hook (scanChangedOnly) uses it to filter.`
- Commit as `check-rules: describe what --base does now`.

**S2.** Tests:
- `node --test scripts/check-rules.test.mjs` passes with 0 failures.
- `node scripts/check-rules.mjs --base origin/main` passes.
- `git grep -n new_code_only` finds nothing.

**S3.** Deliver: merge:
- Push with `IEC_KNOWLEDGE_DIR=D:/projects/knowledge git push -u origin flow/check-rules-base-comment`. The pre-push hook must pass.
- Open the PR with `gh pr create --base main`.
- Call `judge`. Once it passes and `local-checks` shows pass, run `cd D:/projects/game-template && gh pr merge <n> --merge --delete-branch` as its own command.
- Afterwards the checkout is back on `main`, in line with `origin/main`.

### Tests
The S2 commands. No full script suite is needed, because only comments change.

### Done when
The game-template PR is merged, `git grep new_code_only` finds nothing on `main`, and the header describes `--base` as above.

### Risks and what not to touch
- The risk is low: comments only. To roll back, revert the merge commit.
- Don't touch shiny-loop, maze-flow (including its `release/android` checkout), `.agents/skills/iec-*`, or any code in `check-rules.mjs`.

### Commits
- game-template: `check-rules: describe what --base does now` (`scripts/check-rules.mjs`).

<!-- pi-workflow:status -->
## Checklist
- [x] S1 On a new branch `flow/check-rules-base-comment` from `origin/main` in `D:/projects/game-template`, edit `scripts/check-r
- [x] S2 Tests:
- [x] S3 Deliver: merge:
## Outcome
2026-11-03T02:30:52.524Z — ok: pi-config: master, 0 commits since the review base; knowledge: main, 0 commits since the review base; game-template: main, 2 commits since the review base, PR #220 MERGED https://github.com/iecgames/game-template/pull/220; unity-packages: main, 0 commits since the review base; shiny-loop: main, 0 commits since the review base; maze-flow: release/android, 0 commits since the review base
