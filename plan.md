<!-- pi-workflow plan v1 flow=20261103-0004-apply-the-rules-review-game-template-kno-270b -->
## Plan: Apply the rules review (game-template, knowledge, unity-packages, maze-flow, shiny-loop)

Stages: 1. **Knowledge and unity-packages**: retire A6–A8, change the agent texts for K1–K3/G1/G11/G12/U2/U5/S5/C3/D2/D3, drop the review-after-merge list from the daily jobs, stop pi's GD send-back. 2. **game-template**: remove the A6–A8 checks, change the hooks, narrow the test scope, update the tests and texts. 3. **Games**: bring the template into maze-flow and shiny-loop, then remove maze-flow's 112 `allow` comments.

### Goal and non-goals
- **Goal:** apply every decision recorded under "## Decisions (review started 2026-11-02)" in `D:\game-template-rules-and-tests.md` (A, B1–B6, C, D, E, F). Commit, push, open and merge every pull request in the 5 repos, then bring the changes into maze-flow and shiny-loop.
- **Non-goals:**
  - The follow-ups that were noted only: the daily job red since 10-28, the S8 build check, the C1 tag check.
  - Moving existing PlayerPrefs saves.
  - Moving shiny-loop's code into `_Project`.
  - Changing knowledge's own review process (`docs/workflow.md` "A second person reviews").
  - Changing GitHub repo variables or labels.

### User decisions
- **D1 (A):** remove A6 `short-functions`, A7 `no-circular-dependencies` and A8 `no-self-hosted-pull-request-builds` (check, rule entry, tests). Keep A8's advice as plain text in `AGENTS.md`. Keep A1–A5 and A9–A11.
- **D2 (K1):** keep searching knowledge; drop "cite the entry IDs".
- **D3 (K2):** keep `get_rule_pack` and the `required` rules; drop "say why in the PR" for `recommended` rules.
- **D4 (K3):** no automatic `propose_entry`/`update_entry`. Lessons go to the user as a chat note; the tools run only when the user asks.
- **D5 (G1):** keep "no push to `main`, use a PR"; drop "another person reviews". The agent merges its own PR when the checks pass (G3).
- **D6 (G11):** follow-ups are a chat note; open an issue only when the user says yes.
- **D7 (G12):** every tool needs a help line and a README row; an `iec.bat` flow only for tools that non-developers run.
- **D8 (U2):** new code goes in `_Project` with its asmdefs; imported or ported code may stay where it is.
- **D9 (U5):** agents may enter play mode without asking and must leave it afterwards. They still ask before deleting assets, clearing baked data, removing packages and builds.
- **D10 (S5):** new saves use `ISecureStore` and handle `Damaged`; existing PlayerPrefs saves in ported games may stay.
- **D11 (C3):** "run `check-build-config.mjs` before a build" is no longer a rule. The script stays as an optional local check.
- **D12 (D2):** linking to a GD item is optional ("when an item matches"). The Stop hook warns and never blocks.
- **D13 (D3):** no review of every queued commit. `inbox` and `review` are used only when the user asks. Keep D1, D4, D5, D6.
- **D14 (C):**
  - pre-push skips script tests outside the template repo.
  - Remove the pre-push GD guard warning.
  - Remove the UserPromptSubmit and PostToolUse GD reminders.
  - Keep: refusing `main`, check-branch, rule checks, knowledge checks, `local-checks`, the post-commit queue, the token renewal, SessionStart, and pi's turn-end rule check.
- **D15 (D):** remove the daily job's review-after-merge list and keep the rest.
- **D16 (E):**
  - E1: keep all tests on the template's pre-push.
  - E2: a change to `.github/**`, `.claude/settings.json` or `scripts/rule-checks.json` runs only the tests that read that file.
  - E3: delete the tests for removed things.
  - E4: give `gd-store-e2e` a longer timeout.
- **D17 (F):**
  - Keep the test files.
  - Edit Mode tests run only for changes to the code they cover, and only the matching tests.
  - Play Mode tests only when the user asks.
  - No hook or workflow runs them.
- **D18:** the agent delivers everything itself: commit, push, PR and merge, including maze-flow and shiny-loop.

### Facts the executor needs
- **The drift check only fails one way.** `game-template/scripts/check-rule-drift.mjs:30-48` fails when a rule exists in knowledge but not in `rule-checks.json`. A rule only in `rule-checks.json` is ignored (`ifPublished`). So **knowledge must retire A6–A8 first** (Stage 1). Only then may the template drop them (Stage 2). The drift check reads every file in `entries/eng/rule/` whatever its status (`:107-111`), so the files must be deleted, not just marked removed.
- **How knowledge retires an entry:** delete the file and add its ID to `schema/retired-ids.txt` in the same normal PR (`knowledge/docs/entry-format.md:92-96`). Changed entries are stamped by the daily job after the merge (`docs/workflow.md:44-63`), so entry edits go in the same normal PR.
- **Where the three retired rules are named in knowledge:**
  - `entries/eng/rule/{short-functions,no-circular-dependencies,no-self-hosted-pull-request-builds}.md`
  - `entries/eng/playbook/setup-build-machine.md:16` (`related:`)
  - `entries/eng/playbook/daily-maintenance-jobs.md:69`
  - `tools/server/tools.mjs:125` (an example ID)
  - `tools/lib/rule-checks-hook.test.mjs:29` (a sample report)
- **Knowledge agent texts:**
  - `tools/server/server.mjs:13-20` (`INSTRUCTIONS`: line 14 "cite", line 16 "propose_entry").
  - `tools/server/tools.mjs:82` (`get_rule_pack`: "'recommended': … note deviations in the PR").
  - `skills/iec-engineering/SKILL.md:17-18` (Cite), `:27` (recommended), `:39-42` (lessons), `:44-54` (follow-ups and review-after-merge).
  - `skills/iec-knowledge-contribute/SKILL.md`.
  - Game repos get gitignored copies of these skills from knowledge `main` through the launcher (`tools/launcher/run.mjs:18`, `.iec-knowledge-skill`). **Never edit `game-template/.agents/skills/iec-*`.**
- **pi GD send-back:** `knowledge/extensions/knowledge.js:56-61` sends the agent back with `continue: true`. `tools/lib/gd-guard-hook.mjs` is used only there.
- **Daily review list:**
  - knowledge: `tools/ci/daily.mjs:28,35,314-336,453`, with its tests in `tools/ci/daily.test.mjs`. `.github/workflows/daily.yml:5,57`.
  - unity-packages: `scripts/daily.mjs:10,12,31,35,173-199,256`; `scripts/daily.test.mjs:~160-170`; `.github/workflows/daily.yml:3,52`; `README.md:56`.
  - game-template: `.github/workflows/daily.yml:6,80`.
  - Keep the stamps: `chooseReviewer` and `stampFiles` in knowledge `daily.mjs:60,218-262`.
  - No repo has an open `review-after-merge` issue.
- **Texts that name the review list or follow-up issues:**
  - knowledge: `AGENTS.md:28-38`, `entries/eng/guideline/agent-unity-and-merge-safety.md:30,37`, `entries/eng/playbook/{daily-maintenance-jobs.md:30,51, knowledge-menu.md:40,57, game-iec-menu.md:43, new-game.md:42}`.
  - unity-packages: `AGENTS.md:15` (menu flow for every tool), `:63-66` (review-after-merge), `:72-73` (issues), `:74-75` (lessons).
  - Also check `docs/plans/knowledge-system-decisions.md`, which takes new decisions (knowledge `AGENTS.md:15`).
- **Other knowledge entries the decisions touch** (find them with `git grep`):
  - `eng.rule.project-code-layout` (U2)
  - `eng.guideline.game-saves-use-isecurestore` (S5)
  - `eng.guideline.person-facing-tools-have-menu-and-playbook` (G12)
  - `eng.playbook.gd-checklist` (D2/D3)
  - `eng.playbook.ci-build` (C3, only if it says to run `check-build-config` by hand)
  - `eng.guideline.agent-unity-and-merge-safety` (U5 play mode, G1, G11)
- **game-template rule checks:**
  - `scripts/rule-checks.json:164-171` (short-functions), `:172-185` (self-hosted), `:198-206` (circular).
  - `scripts/check-rules.mjs`: header `:13-15`, import `:44`, `checkFunctionLength :345`, `checkCycles :356-406`, `checkSelfHostedPullRequests :408-419`, the `CHECKS` map `:434-443`.
  - `csharp-structure.mjs` is used only by `check-rules.mjs`, `csharp-structure.test.mjs` and `help.test.mjs:12` (`LIBRARIES`).
  - The drift calls for the three rules are at `check-rule-drift.mjs:42-46,52-56`.
  - Their tests are `check-rules.test.mjs:356-399`, plus any other test that names them (`git grep`), and `check-rule-drift.test.mjs`.
- **Pre-push and test scope (game-template):**
  - `.githooks/pre-push:16` (comment) and `:94-96` (GD guard call).
  - `scripts/iec.mjs:43-57` (`isTemplateRepo`), `:201-235` (`checkFlow`), `:242-262` (`prePushFlow`).
  - `scripts/lib/check-scope.mjs:55-90` (`testsFor`: any non-`.mjs` change returns `"all"` at `:62`).
  - Tests that read the trigger files:
    - `.github`: `check-rules.test`, `knowledge-mcp.test`
    - `.claude/settings.json`: `check-rules.test`, `check-scope.test`, `knowledge-mcp.test`
    - `rule-checks.json`: `check-rules.test`, `check-rule-drift.test`
  - The current scope tests are `scripts/check-scope.test.mjs:61-70` (expects `"all"` for `.github/daily.json` and `.claude/settings.json`) and `:115-130` (`prePushFlow`).
- **GD hooks (game-template):**
  - `scripts/lib/gd-guard.mjs:84-123` (`bump`, `MAX_BLOCKS`, `formatOutput`: `decision: "block"`).
  - `scripts/lib/gd-hooks.mjs`: `reviewLines :72-82` (the "Unreviewed commits … Review them" line), `promptHook :111-123`, `postToolHook :126-132`, `runHook :151-160` (**an unknown hook name falls through to `guardHook`**).
  - `scripts/gd-checklist.mjs:21,45`.
  - `.claude/settings.json` and `.codex/hooks.json` (UserPromptSubmit, PostToolUse, Stop).
  - `.pi/extensions/gd/index.js:32-62` (prompt hook in `before_agent_start`, `tool_result` handler).
  - Tests: `scripts/gd-hooks.test.mjs:57,101,122,167,180,200,219`, `scripts/gd-guard.test.mjs:56`, `scripts/gd-pi-extension.test.mjs:17`.
  - `scripts/gd-store-e2e.test.mjs:22` (`timeout: 60000`).
- **game-template texts:**
  - `AGENTS.md` lines:
    - `:8` and `:49-50` (U2)
    - `:30-37` (K1–K3)
    - `:81` (U5)
    - `:108` (C3)
    - `:144` (S5)
    - `:198-199` (A8 advice)
    - `:227-229` and `:240-243` (D2/D3)
    - `:252-255` (rule list)
    - `:266-269` (G1)
    - `:272` (G12, menu)
    - `:278` (tests on push)
    - `:298-301` (review list)
    - `:306` (G11)
    - `:308-309` (K3)
  - The "Working with the Editor" section (F2/F3) and `README.md:136-137`.
  - The gd skills in `.agents/skills/gd-review/SKILL.md` (description: "when … a hook says there are unreviewed GD commits, after you commit") and `.agents/skills/gd-task/SKILL.md`. These are tracked in the template.
- **Repo state:**
  - All clean.
  - maze-flow's main checkout is on `release/android` (the user's). It has 112 `rule-check: allow` comments, all for A6/A7; issue maze-flow#5 is open for them.
  - shiny-loop has a leftover `origin/chore/update-from-template` that is already merged into `main`, so a new update branch from `origin/main` fast-forwards it.
  - `update-from-template.mjs` needs a clean tree; its PR must be merged with a merge commit (G4).
  - shiny-loop's `AGENTS.md` (57 KB) has its own additions, so expect merge conflicts there.

### Design
- **Test scope (E2), in `testsFor`:**
  - These "trigger" files no longer return `"all"`: anything under `.github/`, `.claude/settings.json` and `scripts/rule-checks.json`.
  - A trigger file selects the test files whose source contains its repo path or its basename. A `.github/workflows/*.yml` also selects tests whose source contains `.github/workflows`. If no test matches, it selects none.
  - Other non-`.mjs` files under `scripts/` (fixtures, other data) and unreached modules still return `"all"`. The rule "a script named in a data file runs all" stays.
  - The result is the union with the `.mjs` selection. When only trigger files changed, the `broad` tests (`help.test`) are not added.
- **Skipping tests in game repos (C):**
  - `prePushFlow` gets an injectable option `template` (default `isTemplateRepo(root)`). When it's false, the pre-push runs rule and knowledge checks with `tests: []` and prints `no script tests (game repo: the template runs them; iec.bat check runs them here)`.
  - This also applies to the unreadable-range path: pass `tests: "all"` only in the template.
  - `checkFlow` and `iec.bat check` by hand don't change.
- **GD Stop hook (D12):**
  - `runGuard` never blocks: `formatOutput` returns `systemMessage` for Claude and Codex every time.
  - Remove `bump`, `MAX_BLOCKS` and the counter files.
  - `runHook` treats `prompt` and `post-tool` as no-ops (empty output, exit 0), so stale agent configs stay harmless, and only routes `stop` and `guard` to the guard.
- **pi:**
  - The knowledge extension drops the GD guard send-back entirely, because pi has no "warn without continuing". The rule-check send-back stays.
  - The template's `.pi/extensions/gd` keeps only `session_start` and the first-run session text.
- **Delivery mechanism:** knowledge entry edits are direct file edits in one normal PR, not `update_entry` (that would open one PR per entry). The retire steps are documented as normal PRs, and the daily job stamps the edited entries after the merge.
- **No rejected alternatives worth listing:** moving tests to the daily job was already rejected in E1.

### Stage 1: Knowledge and unity-packages

**S1.** knowledge: on a branch from `origin/main` (worktree `D:/projects/wt/rules-review/knowledge`), retire the three rules.
- Delete the three entry files and add their IDs to `schema/retired-ids.txt`.
- Remove A8 from `related:` in `setup-build-machine.md`.
- In `daily-maintenance-jobs.md:69`, keep the advice ("never trigger self-hosted workflows on `pull_request`") without the rule ID.
- Change the example ID in `tools.mjs:125` to `eng.rule.use-sdk-wrappers`, and the sample report in `rule-checks-hook.test.mjs:29` to a `use-sdk-wrappers` finding.
- `git grep` must find no other reference outside `docs/plans/` history.

**S2.** knowledge texts K1–K3, G11:
- `server.mjs` `INSTRUCTIONS`:
  - Line 14: search before designing; drop "cite".
  - Line 16: when the agent learns something reusable, it tells the user in a short chat note. It calls `propose_entry`, `update_entry` or `propose_category` only when the user asks; the `next_steps` sentence applies then.
- `tools.mjs:82`: `recommended` means "follow by default", with no PR note.
- `skills/iec-engineering/SKILL.md`:
  - Remove step 3 "Cite" and the recommended-PR sentence.
  - "When you learn something reusable" becomes a chat note, with the tools only on request.
  - In Follow-ups, remove the review-after-merge bullet.
  - "Left to verify…" becomes: a chat note; open an issue only when the user says yes (keep the `device-check` sentence).
- `skills/iec-knowledge-contribute/SKILL.md`: its description and opening say it is used when the user asks to save knowledge, not on its own initiative.

**S3.** knowledge entries for the other decisions (edit only what each entry actually says; leave unrelated text alone):
- `agent-unity-and-merge-safety` (D5 no second reviewer; remove item 2, the review list; item 6 becomes a chat note and issue on yes; D9 play mode without asking, leave it afterwards)
- `person-facing-tools-have-menu-and-playbook` (D7)
- `project-code-layout` (D8)
- `game-saves-use-isecurestore` (D10)
- `ci-build` (D11, only if it says to run the script by hand)
- `gd-checklist` (D12/D13)
- `daily-maintenance-jobs`, `knowledge-menu`, `game-iec-menu`, `new-game` (remove the review list, the `review-after-merge` label and the `REVIEW_AFTER_MERGE` variable)

Also add a short "Rules review (2026-11)" decision to `docs/plans/knowledge-system-decisions.md` that lists D1–D17 in one line each.

**S4.** knowledge daily job (D15):
- In `tools/ci/daily.mjs`, remove `reviewListStep`, its `step(...)` call, `REVIEW_TITLE`, the `review-after-merge` label row and the `REVIEW_AFTER_MERGE` header and env mentions. Keep `chooseReviewer` and the stamps.
- Update `tools/ci/daily.test.mjs`: delete the review-list tests; tests of stamping stay green.
- `.github/workflows/daily.yml`: remove the env line and the comment.
- `AGENTS.md:28-38`:
  - Remove the "Merged without a second reviewer" bullet.
  - Follow-ups become chat notes, with an issue only on yes.
  - "Standing issues" keeps only `device-check`.
  - "Lessons" becomes a chat note, with `propose_entry` only when the user asks. Rule 2 stays: changing entries still goes through those tools or a normal PR.

**S5.** knowledge pi extension (D12):
- In `extensions/knowledge.js`, remove the GD guard block (`:56-61`) and the header mention (`:2`), and delete `tools/lib/gd-guard-hook.mjs`.
- The rule-check send-back stays unchanged.

**S6.** unity-packages (D6, D7, D15), on a branch in worktree `D:/projects/wt/rules-review/unity-packages`:
- `scripts/daily.mjs`: the same removal as S4. Delete its review-list test in `scripts/daily.test.mjs`.
- `.github/workflows/daily.yml`: remove the env line and the comment.
- `README.md:56`: remove the review-list mention.
- `AGENTS.md`:
  - `:15`: every tool needs a help line and a README section; a menu flow only for tools that non-developers run.
  - `:63-66`: removed.
  - `:72-73`: follow-ups as a chat note, issue on yes.
  - `:74-75`: lessons as a chat note, `propose_entry` only on request.
  - Keep the `device-check` bullet; the publish tool opens those.

**S7.** Deliver: merge — the knowledge PR (S1–S5) and the unity-packages PR (S6), each after its pre-push checks pass (`npm run check` in knowledge, `node scripts/package.mjs check` in unity-packages) and the judge passes. Then pull `D:/projects/knowledge` to the new `main`.

### Stage 2: game-template
Work on a branch in worktree `D:/projects/wt/rules-review/game-template`. Run pushes with `IEC_KNOWLEDGE_DIR=D:/projects/knowledge`, which is now updated, so the drift check sees the retired rules.

**S8.** Remove A6–A8 (D1):
- In `scripts/rule-checks.json`, delete the three blocks.
- In `check-rules.mjs`, delete `checkFunctionLength`, `checkCycles` and `checkSelfHostedPullRequests`, their `CHECKS` entries, the `csharp-structure` import and the header lines. Keep `checkNoShellTracing` (A9 `never-log-secrets-in-ci`).
- Delete `scripts/csharp-structure.mjs` and `csharp-structure.test.mjs`, and remove it from `help.test.mjs:12`.
- In `check-rule-drift.mjs`, remove the three comparisons.
- Delete their tests in `check-rules.test.mjs` (`:356-399`, plus any other test or probe case naming them) and in `check-rule-drift.test.mjs`.
- The `new_code_only` test (`:386`) must keep covering `--base` with a rule that remains, if one has `new_code_only`; otherwise delete it.

**S9.** Test scope (D16 E2):
- Change `testsFor` in `scripts/lib/check-scope.mjs` as in Design, and update its doc comment (`:55-57`).
- Update `check-scope.test.mjs:61-70`:
  - `.github/daily.json` and `.claude/settings.json` select only tests mentioning them.
  - A trigger file that no test mentions selects `[]`.
  - `scripts/data.json` and an unreached script still return `"all"`.
  - A trigger file plus a changed script gives the union.

**S10.** Skip script tests in game repos (D14): the `template` option of `prePushFlow` (`scripts/iec.mjs:242`), as in Design, including the unreadable-range path. Update the comment at `iec.mjs:17` and in `.githooks/pre-push:5`. In `check-scope.test.mjs:115`, existing scope assertions pass `template: true`. Add a case where `template: false` makes `check` receive `tests: []` and the message is printed.

**S11.** GD hooks (D12–D14):
- `gd-guard.mjs`: warn only, as in Design.
- `gd-hooks.mjs`:
  - Delete `promptHook` and `postToolHook`.
  - `runHook` makes `prompt` and `post-tool` no-ops.
  - `reviewLines` drops the "Unreviewed commits … Review them with the gd-review skill" line. It keeps "Waiting for confirmation" and the pending tasks.
  - The session text keeps "Update progress yourself with gd-task".
- `gd-checklist.mjs:21,45`: the comments say the guard only warns.
- `.githooks/pre-push`: delete the guard call (`:94-96`) and its comment (`:16`).
- `.claude/settings.json` and `.codex/hooks.json`: delete the UserPromptSubmit and PostToolUse entries, and keep SessionStart and Stop.
- `.pi/extensions/gd/index.js`: drop the prompt hook from `before_agent_start` (keep the first-run session text) and delete the `tool_result` handler.

**S12.** GD and E4 tests (D16 E3/E4):
- `gd-hooks.test.mjs`:
  - Delete `:57`, `:180` and `:200`.
  - Rewrite `:101` (the 20,000-event cache) to use `session-start`, and `:219` (stdin left open) to use `stop`.
  - `:122` "…then blocks once it is complete" becomes "…then warns".
  - `:167`: the session text no longer lists unreviewed commits and still lists waiting parts.
  - Add: `prompt` and `post-tool` print nothing and exit 0.
- `gd-guard.test.mjs:56`: Claude and Codex always get a `systemMessage` and never `decision: "block"`, the third time included; prepush exits 0.
- `gd-pi-extension.test.mjs:17`: it registers `before_agent_start` and `session_start` only.
- `gd-store-e2e.test.mjs:22`: raise the command timeout to 180 s, and the test's own timeout if it has one.

**S13.** Texts:
- `AGENTS.md` at the anchors in Facts:
  - D1: the rule list without A6–A8; the self-hosted advice as text, with only `set -x` checked.
  - D2–D4: Knowledge section items 1–3 and "Lessons".
  - D5: "push a branch, open a PR, merge it yourself once every check passes, `local-checks` included".
  - D6: follow-ups as a chat note, issue on yes.
  - D7: the `iec.bat` menu sentence.
  - D8: `:8`, `:49-50`.
  - D9: `:81`.
  - D10: `:144`.
  - D11: `:108`, describing the script as optional because CI runs it first.
  - D12/D13: `:227-229`, `:240-243`. Link with `gd/<key>` or `GD: <key>` when an item matches; no `GD: none` needed. The Stop hook only warns; `inbox`/`review` when the user asks.
  - D14: `:278`, saying script tests run on push only in the template repo.
  - D15: delete `:298-301`.
  - D17: add 2–3 lines to "Working with the Editor": run Edit Mode tests only for changes to A/B, ads/analytics, purchases, cheats, build/keys, privacy or the SDK test panel, with `unity test --filter <Fixture>` or `--affected`, never for gameplay, levels, art, UI or content; Play Mode tests only when the user asks.
- `README.md:136-137`: the rule list without A6/A7.
- `.github/workflows/daily.yml:6,80`: remove the review list and `REVIEW_AFTER_MERGE`.
- `.agents/skills/gd-review/SKILL.md` description: only when the user asks to review commits; remove the session-start/hook/after-commit triggers.
- `.agents/skills/gd-task/SKILL.md`: linking is optional (D12).
- Check that the other `gd-*` skills don't still say "review every queued commit" or "the guard blocks".

**S14.** Deliver: merge — the game-template PR (merge commit), after its pre-push passes and the judge passes.

### Stage 3: Games
**S15.** maze-flow:
- In a new worktree from `origin/main` (`D:/projects/wt/rules-review/maze-flow`; never touch the user's `release/android` checkout), run `node scripts/update-from-template.mjs`.
- Resolve any conflicts: keep the game's own lines, and take the template's changes for the edited rules, hooks and scripts.
- The pre-push must print `no script tests (game repo…)`.

**S16.** Deliver: merge — maze-flow's update-from-template PR, **with a merge commit** (G4).

**S17.** maze-flow: on a new branch from the updated `origin/main`, remove all 112 `rule-check: allow eng.rule.short-functions|no-circular-dependencies …` comments in `unity/`.
- Delete the whole line when the comment is alone on it. Remove only the comment (and the space before it) when it follows code.
- The diff may contain nothing else: check that every removed line or part contains `rule-check: allow` and that no code changes.
- `node scripts/check-rules.mjs --base origin/main` must pass.
- The PR text says `Closes #5`.

**S18.** Deliver: merge — maze-flow's allow-comment PR.

**S19.** shiny-loop: the same as S15, in worktree `D:/projects/wt/rules-review/shiny-loop`. Its `AGENTS.md` has its own additions: keep them when resolving conflicts.

**S20.** Deliver: merge — shiny-loop's update-from-template PR, **with a merge commit**.

**S21.** In `D:\game-template-rules-and-tests.md` (not a git repo), add a line under "## Decisions" saying "Applied 2026-11-03" with the merged PR links. Turn each "To change … (not done yet)" into "done in <PR>".

**S22.** Verify:
- In a Claude Code session in maze-flow, on a branch with an unlinked `unity/Assets` commit, finish a turn. Look for a warning and no forced extra turn.
- In pi, look for no GD send-back, while rule-check findings still send the agent back once.

### Tests
- **knowledge:**
  - `npm run check`: all tests and validation pass.
  - `git grep -n "short-functions\|no-circular-dependencies\|no-self-hosted-pull-request-builds\|REVIEW_AFTER_MERGE\|reviewListStep"` outside `docs/plans/` and `schema/retired-ids.txt`: no hits.
- **unity-packages:** `node scripts/package.mjs check` passes, and `git grep REVIEW_AFTER_MERGE` finds nothing.
- **game-template:**
  - Fast, while fixing: `node --test scripts/check-rules.test.mjs scripts/check-rule-drift.test.mjs scripts/check-scope.test.mjs scripts/help.test.mjs scripts/gd-hooks.test.mjs scripts/gd-guard.test.mjs scripts/gd-pi-extension.test.mjs`
  - Slow, run once before the push (about 2–5 min): `node --test "scripts/*.test.mjs" "scripts/lib/*.test.mjs"`. 0 fail, with fewer tests than 618.
  - `node scripts/check-rules.mjs --base origin/main` passes.
  - `node scripts/check-rule-drift.mjs --knowledge D:/projects/knowledge` prints "rule-checks.json matches the knowledge rules."
  - `echo '{}' | node scripts/gd-checklist.mjs hook prompt --agent claude` prints nothing and exits 0.
- **maze-flow:**
  - `git grep -c "rule-check: allow eng.rule.\(short-functions\|no-circular-dependencies\)" origin/main -- unity` finds nothing.
  - `node scripts/check-rules.mjs --base origin/main` passes.
  - The update push log shows "no script tests".
- **shiny-loop:** the update push log shows "no script tests", and `local-checks` passes on the PR.

### Done when
- Every PR is merged with a passing `local-checks` and judge: knowledge, unity-packages, game-template, maze-flow update, maze-flow allow-comment cleanup (closes #5), shiny-loop update. The template updates use merge commits.
- A6–A8 exist nowhere: not in the knowledge entries, `rule-checks.json`, `check-rules.mjs` or the tests. The drift check passes in the template and both games.
- Agent texts in game-template, knowledge (server, skills, entries) and unity-packages match D2–D13, D15 and D17.
- **Hooks:**
  - The game pre-push runs no script tests.
  - No GD guard on pre-push.
  - No UserPromptSubmit or PostToolUse GD hooks.
  - The Stop hook never blocks.
  - pi has no GD send-back.
- In the template, a push that changes only a workflow file, `.claude/settings.json` or `rule-checks.json` runs only the tests that mention it.
- The daily jobs no longer build a review list; stamps still work.
- The report file marks every decision as applied.

### Risks, rollback, what not to touch
- **Order:** the template must not merge before knowledge (drift). If the template pre-push fails on drift, the local knowledge copy is old: point `IEC_KNOWLEDGE_DIR` at the pulled clone.
- **Removed hook names:** clones whose agent config still calls `hook prompt` or `post-tool` get no-ops (S11), never the guard.
- **Losing pre-push test protection in games:** accepted (D14). The daily job still runs them on `main`.
- **Conflicts in the update merges** (`AGENTS.md`, hooks): keep each game's own additions. Never squash.
- **Rollback:** revert the merge commit in each repo, in reverse order (games, then the template, then knowledge and unity-packages).
- **Don't touch:**
  - The user's maze-flow `release/android` checkout and the existing worktrees.
  - `.agents/skills/iec-*` copies and vendored Unity skills.
  - A9 (`set -x`) and the other kept rules.
  - The post-commit queue, `inbox`/`review` commands, `local-checks` and the build workflows.
  - GitHub variables and labels.
  - The open PRs (#110, #109, #108, #100, shiny-loop #91).

### Commits
- knowledge:
  - `Retire the short-functions, circular-dependency and self-hosted-PR rules`: S1 files.
  - `Agents note lessons and follow-ups in the chat; no citing or PR notes`: `server.mjs`, `tools.mjs`, skills, `AGENTS.md`.
  - `Update entries for the 2026-11 rules review`: S3 entries and the decisions doc.
  - `Drop the review-after-merge list from the daily job`: `daily.mjs`, `daily.test.mjs`, `daily.yml`.
  - `pi package: no GD send-back at the end of a turn`: `knowledge.js`, `gd-guard-hook.mjs`.
- unity-packages:
  - `Drop the review-after-merge list from the daily job`: `daily.mjs`, test, `daily.yml`, `README`.
  - `Follow-ups and lessons as chat notes; menu flows only for people-run tools`: `AGENTS.md`.
- game-template:
  - `Remove the short-functions, circular-dependency and self-hosted-PR checks`: S8 files.
  - `Pre-push: tests only for what a data change reads; none in game repos`: `check-scope.mjs`, `iec.mjs`, `pre-push` comments, `check-scope.test.mjs`.
  - `GD hooks: the Stop hook only warns; no prompt, command or pre-push reminders`: S11 files and S12 GD tests.
  - `Longer timeout for gd-store-e2e`: `gd-store-e2e.test.mjs`.
  - `Agent rules after the 2026-11 review`: `AGENTS.md`, `README.md`, `daily.yml`, gd skills.
- maze-flow: the tool's merge commit `Update from game-template …`; then `Remove the rule-check exceptions of the retired A6/A7 rules (closes #5)`.
- shiny-loop: the tool's merge commit `Update from game-template …`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 knowledge: on a branch from `origin/main` (worktree `D:/projects/wt/rules-review/knowledge`), retire the three rules.
- [x] S2 knowledge texts K1–K3, G11:
- [x] S3 knowledge entries for the other decisions (edit only what each entry actually says; leave unrelated text alone):
- [x] S4 knowledge daily job (D15):
- [x] S5 knowledge pi extension (D12):
- [x] S6 unity-packages (D6, D7, D15), on a branch in worktree `D:/projects/wt/rules-review/unity-packages`:
- [x] S7 Deliver: merge — the knowledge PR (S1–S5) and the unity-packages PR (S6), each after its pre-push checks pass (`npm run 
- [ ] S8 Remove A6–A8 (D1):
- [ ] S9 Test scope (D16 E2):
- [ ] S10 Skip script tests in game repos (D14): the `template` option of `prePushFlow` (`scripts/iec.mjs:242`), as in Design, inc
- [ ] S11 GD hooks (D12–D14):
- [ ] S12 GD and E4 tests (D16 E3/E4):
- [ ] S13 Texts:
- [ ] S14 Deliver: merge — the game-template PR (merge commit), after its pre-push passes and the judge passes.
- [ ] S15 maze-flow:
- [ ] S16 Deliver: merge — maze-flow's update-from-template PR, with a merge commit (G4).
- [ ] S17 maze-flow: on a new branch from the updated `origin/main`, remove all 112 `rule-check: allow eng.rule.short-functions|no
- [ ] S18 Deliver: merge — maze-flow's allow-comment PR.
- [ ] S19 shiny-loop: the same as S15, in worktree `D:/projects/wt/rules-review/shiny-loop`. Its `AGENTS.md` has its own additions
- [ ] S20 Deliver: merge — shiny-loop's update-from-template PR, with a merge commit.
- [ ] S21 In `D:\game-template-rules-and-tests.md` (not a git repo), add a line under "## Decisions" saying "Applied 2026-11-03" w
## For you after the flow
- S22 Verify:
