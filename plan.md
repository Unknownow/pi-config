<!-- pi-workflow plan v1 flow=20261104-0943-fix-the-last-three-a-b-tooling-minors-in-874e -->
## Plan: Fix the last three A/B tooling minors in game-template, then update both games

### Goal
Fix the three minor findings the judges left open after PRs #222, #120 and #114. Fix them in game-template, then bring them to shiny-loop `main` and maze-flow `main` with a template update.

### Not part of this plan
- **The pre-push `ab-tests.mjs check` question:** still waiting on your choice.
- **The manual check of the Edit tests window** in a live Unity Editor.
- **Changes on the Unity side:** none. All three findings are Node or docs only.

### Facts
- **game-template** `main` is at `962ab12` and clean.
- **Finding A (string blanking):** `handMembers` (`scripts/lib/ab-settings.mjs:172-178`) runs `stripComments`, then its own `.replace(/[@$]*"(?:[^"\\]|\\.)*"/g, '""')`.
  - That replace doesn't know char literals or verbatim strings.
  - `stripComments` (`:123-150`) already walks normal, verbatim and char literals.
- **Finding B (double report):** a key whose handle is in `RESERVED_HANDLES` (`:17`, which includes `Declare` and `DeclareGenerated`) is reported once by `entryErrors` and again by `handleErrors`, because `GameSettings.cs` declares those members too.
- **Finding C (docs):** the usage comment of `scripts/ab-tests.mjs` (lines 7-13 and 21-22) and `AGENTS.md:159-160` don't mention the `--` separator or the collision error.

### Design
1. **Blank literals in `stripComments`.**
   - `stripComments(text, { blankLiterals = false } = {})`. With the flag on, it writes each literal it skips as empty: `""` for a normal string, `@""` for a verbatim one (its prefix chars are already in `out`, so only the quotes are written), and `''` for a char.
   - `handMembers` calls `stripComments(text, { blankLiterals: true })`, and the extra `.replace` is deleted.
   - `handDeclaredKeys` keeps the default (literals kept), because it reads the key out of the string.
2. **No double report.** `handleErrors` skips a handle that is in `RESERVED_HANDLES`.
3. **Docs.**
   - In the `ab-tests.mjs` usage, `value`, `setting add` and `setting default` show `[--] <value>`, with a one-line note: "`--` ends the options: put it before a value that starts with `--`."
   - The `check` description adds "a setting whose C# name GameSettings.cs already declares".
   - `AGENTS.md:159` notes the `--` separator. `AGENTS.md:160` adds the handle collision to the list of mismatches.

### Steps
Stage 1: game-template, in `D:/projects/game-template`. Run `git pull --ff-only`, then branch `flow/ab-settings-literal-blanking`.

**S1. Code and tests.**
- Make the `ab-settings.mjs` changes from Design 1 and 2.
- Tests in `scripts/ab-settings.test.mjs`:
  - `handMembers("var q = '\"'; public static int Bonus; var v = @\"C:\\\"; public static int Other; var s = \"public static int Hidden;\";")` includes `Bonus` and `Other`, and not `Hidden`.
  - `validateSettings` with the key `declare`, where the temp `GameSettings.cs` declares `Declare()`, gives exactly one problem.

**S2. Docs.** The usage comment in `scripts/ab-tests.mjs` and `AGENTS.md:159-160`, as in Design 3.

**S3. Tests.**
- `node --test "scripts/ab-settings.test.mjs" "scripts/ab-tests.test.mjs" "scripts/check-build-config.test.mjs"`: 0 fail. Then the full `node --test "scripts/*.test.mjs"` once: 0 fail.
- `node scripts/ab-tests.mjs check` exits 0.
- `node scripts/check-rules.mjs --base origin/main` passes.
- No Unity run: no C# changes.

**S4. Deliver game-template.**
- Commit `A/B tools: blank literals in the member scan, no double report of reserved handles, document -- and the collision error`.
- Push with `IEC_KNOWLEDGE_DIR=D:/projects/knowledge` and open the PR.
- Confirm `local-checks` passed; if it wasn't posted, post it with `node scripts/local-checks.mjs after-push …`.
- Run `judge`; it must pass.
- `cd D:/projects/game-template && gh pr merge <n> --merge --delete-branch`, as its own command.
- Switch to `main` and pull.

Stage 2: the games.

**S5. shiny-loop.** Same steps as last time:
- `git pull --ff-only` on `main`.
- `node scripts/update-from-template.mjs`.
- Checks: `ab-tests.mjs check` exits 0, `check-build-config.mjs --platform android` shows no A/B lines, and `generate` leaves the tree clean.
- Confirm `local-checks` passed (post it if it wasn't), then run `judge`.
- `cd D:/projects/shiny-loop && gh pr merge <n> --merge --delete-branch`, as its own command.

**S6. maze-flow.**
- Confirm the checkout is on `release/android` at `c49b255e` and clean. If anything is uncommitted, stop and ask.
- `git switch main && git pull --ff-only`, then the same update, checks, judge and merge as S5. The judge runs while the update branch is checked out.
- `git switch release/android` and confirm HEAD is `c49b255e` and the tree is clean.

### Done when
- All three PRs are merged, each with a judge pass.
- maze-flow is back on `release/android` at `c49b255e`, clean.

### Risks and what not to touch
- **Literal blanking applies only to `handMembers`.** `handDeclaredKeys` keeps the literals it reads keys from, and a test pins this.
- **Don't touch:**
  - `release/android`;
  - the open PRs maze-flow #110, #109, #108 and #100 and shiny-loop #91;
  - the existing worktrees;
  - `.agents/skills/iec-*`;
  - packages and workflows.
- **Rollback:** revert each merge commit.

### Commits
- **game-template:** the S4 message.
- **Games:** the merge commits made by `update-from-template.mjs`.

**Publish:** none.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Code and tests.
- [x] S2 Docs. The usage comment in `scripts/ab-tests.mjs` and `AGENTS.md:159-160`, as in Design 3.
- [x] S3 Tests.
- [x] S4 Deliver game-template.
- [x] S5 shiny-loop. Same steps as last time:
- [x] S6 maze-flow.
## Outcome
2026-11-04T02:55:38.922Z — ok: pi-config: master, 0 commits since the review base; knowledge: main, 0 commits since the review base; game-template: main, 2 commits since the review base, PR #223 MERGED https://github.com/iecgames/game-template/pull/223; unity-packages: main, 0 commits since the review base; shiny-loop: main, 4 commits since the review base, PR #121 MERGED https://github.com/iecgames/shiny-loop/pull/121; maze-flow: release/android, 0 commits since the review base, PR #115 MERGED https://github.com/iecgames/maze-flow/pull/115
