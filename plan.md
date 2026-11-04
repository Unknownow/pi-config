<!-- pi-workflow plan v1 flow=20261104-0910-fix-the-four-minor-a-b-tooling-findings-8e5a -->
## Plan: Fix the four minor A/B tooling findings in game-template, then update both games

### Goal
Fix the four minor findings from the PR #113 review. Fix them in game-template, then bring the fixes to shiny-loop `main` and maze-flow `main` with a template update.

### Not part of this plan
- **The pre-push `ab-tests.mjs check` question:** still waiting on your choice.
- **The manual check of the Edit tests window** in a live Unity Editor.
- **Packages, workflows and `.agents/skills/iec-*`:** not changed.
- **`release/android` in maze-flow:** not changed.

### Facts
- **game-template** `main` is at `5ea712f` and clean.
- **Finding 1 (`--` values):** `scripts/ab-tests.mjs:86` throws `unknown argument` for any argument that starts with `--`.
  - The window builds its arguments in `AbTestsWindowModel.ValueArgs`, `AddSettingArgs` and `DefaultArgs` (`AbTestsWindowModel.cs:255-293`), with the value before `--json`.
  - `AbTestsWindowModelTests.Arguments_MatchTheScriptsCommands` (`:106-119`) checks those arguments.
- **Finding 2 (C# literals):** `stripComments` (`scripts/lib/ab-settings.mjs:124`) and `AbSettingsCheck.StripComments` (`AbSettingsCheck.cs:60`) only know `"..."` strings with `\` escapes.
  - `handDeclaredKeys` and `AbSettingsCheck` use them.
  - They are tested by `handDeclaredKeys ignores comments…` (`ab-settings.test.mjs:234`) and `AbSettingsCheckTests`.
- **Finding 3 (`test.` keys):** the window hides every key that starts with `TestKeyPrefix = "test."` (`AbTestsWindowModel.cs:49,93`).
  - The only test keys defined in the Editor session are `test.cheat.{on,int,float,text}` (`GameCheatsAbTests`).
  - The core package tests use other keys.
- **Finding 4 (handle collisions):** the handle checks only look at `RESERVED_HANDLES` and at clashes between generated handles (`ab-settings.mjs:17,178-181`).
  - The CLI writes from `runChange` (`ab-tests.mjs`, after `operate`).
  - `validateSettings` (`:222`) is the check used by `ab-tests.mjs check` and by `check-build-config.mjs`.

### Design
1. **`--` values.**
   - `parseArgs` treats `--` as the end of options: every argument after it goes into `rest`.
   - The window's argument builders put the flags first and then `"--", value`, for example `value AB_1 11 a.n --json -- 5`.
   - Values that don't start with `--` behave as before.
2. **C# literals.** Both strippers also skip over:
   - char literals `'…'`, including escaped ones like `'\''` and `'\\'`;
   - verbatim strings `@"…"` and `$@"…"` / `@$"…"`, which end at a `"` that is not doubled.

   The Node and C# copies stay in step.
3. **`test.` keys.** `TestKeyPrefix` becomes `"test.cheat."`, so only the cheat tests' own keys are hidden. There is no new key rule.
4. **Handle collisions.**
   - New `handMembers(text)` and `readHandMembers(root)` in `ab-settings.mjs`. They return the member names that `GameSettings.cs` declares, outside comments: an identifier after an access or `static` modifier, followed by `{`, `;`, `(` or `=`.
   - New `handleErrors(settings, members)` reports `Setting <key>: the C# name <Handle> is already declared in GameSettings.cs.`
   - `validateSettings` adds these as `SETTINGS_PATH` problems.
   - `runChange` checks `result.settings` the same way before writing, so `setting add` and `rename` are refused and nothing is written.
   - The pure operations keep their signatures.
   - Unity needs nothing new: the compiler already reports such a duplicate.

### Steps
Stage 1: game-template. Work in the main checkout `D:/projects/game-template`. Run `git pull --ff-only`, then branch `flow/ab-settings-minor-fixes` from `origin/main`.

**S1. Node fixes (findings 1, 2, 4).**
- `scripts/ab-tests.mjs`: `parseArgs` handles `--`, and `runChange` runs the collision check before writing.
- `scripts/lib/ab-settings.mjs`: the `stripComments` literals, plus `handMembers`, `readHandMembers`, `handleErrors` and the `validateSettings` call.
- Tests:
  - `scripts/ab-tests.test.mjs`: `value … -- --x` stores the string `--x`; `setting add` refuses a handle that `GameSettings.cs` already declares in a temp root, and every file stays unchanged.
  - `scripts/ab-settings.test.mjs`: `handDeclaredKeys` gets the `'"'`, `'\''` and `@"a\"` cases with a `Settings.Define` after them; `handMembers` and the `validateSettings` collision get their own cases; the committed `GameSettings.cs` has no collision.

**S2. Unity fixes (findings 1, 2, 3).**
- `AbTestsWindowModel.cs`: the `--` in `ValueArgs`, `AddSettingArgs` and `DefaultArgs`, and `TestKeyPrefix = "test.cheat."`.
- `AbSettingsCheck.cs`: the `StripComments` literals.
- Tests:
  - `AbTestsWindowModelTests`: update `Arguments_MatchTheScriptsCommands`; add a check that `Rows` shows `test.bonus` and hides `test.cheat.on`.
  - `AbSettingsCheckTests`: a `HandDeclaredKeys` case with a char literal and a verbatim string.

**S3. Tests.**
- `node --test "scripts/ab-tests.test.mjs" "scripts/ab-settings.test.mjs" "scripts/check-build-config.test.mjs"`: 0 fail. Then the full `node --test "scripts/*.test.mjs"` once: 0 fail.
- `node scripts/ab-tests.mjs check` exits 0.
- `node scripts/check-rules.mjs --base origin/main` passes.
- Unity Edit Mode tests in batch mode: `unity test --mode EditMode --filter "AbTestsWindowModelTests;AbSettingsCheckTests;AbTestsBuildConfigCheckTests;GameCheatsAbTests"`, all passing.
  - If an Editor for the project is open and blocks the run, kill only that Unity PID.

**S4. Deliver game-template.**
- Commit `A/B tools: "--" values, C# literals in the hand-key scan, only cheat test keys hidden, handle collisions with GameSettings.cs`.
- Push with `IEC_KNOWLEDGE_DIR=D:/projects/knowledge`.
- Open the PR. Confirm `local-checks` passed; if it wasn't posted, post it with `node scripts/local-checks.mjs after-push …`.
- Run `judge`; it must pass.
- `cd D:/projects/game-template && gh pr merge <n> --merge --delete-branch`, as its own command.
- Then switch to `main` and pull.

Stage 2: the games.

**S5. shiny-loop.**
- In `D:/projects/shiny-loop`, on `main` and clean, run `git pull --ff-only`.
- Run `node scripts/update-from-template.mjs`. If a stale `chore/update-from-template` branch exists, delete it first.
- Resolve any conflicts by keeping the game's lines and taking the template's edits.
- Check:
  - `ab-tests.mjs check` exits 0;
  - `check-build-config.mjs --platform android` reports no A/B problems;
  - `generate` leaves `git status` clean.
- Confirm `local-checks` passed, then run `judge`; it must pass.
- `cd D:/projects/shiny-loop && gh pr merge <n> --merge --delete-branch`, as its own command.
- The checkout ends on `main`, pulled.

**S6. maze-flow.**
- Run `git status -sb`. If anything is uncommitted, stop and ask.
- Record that HEAD is `release/android` at `c49b255e`.
- `git switch main && git pull --ff-only`, then the same update, checks, judge and merge as S5. The judge runs while `main` is checked out.
- `git switch release/android`, then confirm HEAD is `c49b255e` and the tree is clean.

### Tests
- The S3 commands.
- The per-game Node checks in S5 and S6.

### Done when
- The game-template, shiny-loop and maze-flow PRs are merged and each judge passed.
- maze-flow is back on `release/android` at `c49b255e`, clean.

### Risks and what not to touch
- **Window arguments:** the window and the script must change together. Both are in the same PR, and the arguments test pins them.
- **The member scan could flag a false collision**, for example a field that happens to share a name. That only blocks adding the setting, and the error names the clashing member.
- **Rollback:** revert each merge commit.
- **Don't touch:**
  - `release/android`;
  - the open PRs maze-flow #110, #109, #108 and #100 and shiny-loop #91;
  - the existing worktrees;
  - `.agents/skills/iec-*`.

### Commits
- **game-template:** the S4 message.
- **Games:** `Update from game-template 5ea712f..<new>`, as merge commits made by `update-from-template.mjs`.

**Publish:** none.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Node fixes (findings 1, 2, 4).
- [x] S2 Unity fixes (findings 1, 2, 3).
- [x] S3 Tests.
- [x] S4 Deliver game-template.
- [x] S5 shiny-loop.
- [x] S6 maze-flow.
## Outcome
2026-11-04T02:33:26.687Z — ok: pi-config: master, 0 commits since the review base; knowledge: main, 0 commits since the review base; game-template: main, 3 commits since the review base, PR #222 MERGED https://github.com/iecgames/game-template/pull/222; unity-packages: main, 0 commits since the review base; shiny-loop: main, 5 commits since the review base, PR #120 MERGED https://github.com/iecgames/shiny-loop/pull/120; maze-flow: release/android, 0 commits since the review base, PR #114 MERGED https://github.com/iecgames/maze-flow/pull/114
