<!-- pi-workflow plan v1 flow=20261022-1621-faster-unity-test-runs-workflow-prompts-03e6 -->
## Plan: Faster Unity test runs: workflow prompts and knowledge playbooks (remaining stages)

### 1. Goal and non-goals
- **Goal:** cut the Unity time per flow (about 60-100 min today). The harness part is already merged as unity-packages PR #264: `Library` reuse, skipping unchanged inputs, and running full and lite at the same time. This plan delivers what is left:
  - **Fixes 2-3 (workflow prompts):** executors iterate on narrow checks and run each slow suite in full once before the first judge call. After a judge round they rerun a slow suite only if the fix changed files it builds or reads. The planner marks slow suites with a fast and a full command.
  - **Playbooks:** the knowledge playbooks describe the new harness behaviour and the iterate-narrow guidance.
- **Non-goals:**
  - No further change to unity-packages. `test-packages.mjs` and `test-ads-set.mjs` stay as merged.
  - No result caching in the workflow extension, and no new workflow tool.
  - No workflow code change beyond `prompts.ts`, `prompts.test.ts` and the backlog doc.
  - No other knowledge entries.

### 2. User decisions
- **D1:** Fix 4 (skip a run when nothing changed) is included together with fixes 1-3. Done in PR #264.
- **D2:** Fix 4 lives in the harness, keyed by a hash of everything the run reads, not by the workflow's diff hash. Done.
- **D3:** Full and lite run at the same time by default (32 GB of RAM). `--serial` is the fallback. Done.
- **D4:** `test-ads-set.mjs` is not parallelized and does not reuse `Library`. It runs once at the end, and only when the ads packages changed.
- **D5:** The executor runs the Unity batch-mode runs itself, not a person's `Wait:` step. This plan needs no Unity runs.
- **D6:** Three stages: harness (done, merged), pi-config workflow prompts, knowledge playbooks. The playbooks stage runs only after the harness is merged, which it is.
- **D7:** Delivery: harness merged (done); pi-config push; knowledge merge.
- **D8:** In `docs/workflow-improvements.md`, fixes 2 and 3 become new rows A23 and A24, marked Done.

### 3. Facts the executor needs
- **unity-packages:** PR #264 is merged, and `origin/main:scripts/test-packages.mjs` contains `--serial`. The harness has these flags and behaviour:
  - `--fresh`: clean import and a run.
  - `--serial`: runs the variants one after the other.
  - `--variant both`: full and lite run at the same time.
  - Cache: a folder per template and variant under `<tmp>/iec-packages-test`, with `Library` reused.
  - Skip line: `== <variant>: unchanged since the pass at <at> (<hash8>), not run`.
  - Timings: a clean `--fresh` run took 2m57s, an unchanged rerun 0.4 s, and a run after one `.cs` change 29.6 s.
- **pi-config:** `D:/projects/pi-config`, branch `master`, clean and in sync with origin. Workflow folder: `pi/agent/extensions/workflow/`.
  - `prompts.ts:97`: the EXECUTE_PHASE bullet that starts "- When done, run the plan's tests, then call \`judge\` with \`focus\` set to the plan's title. …". It is inside a template literal, so backticks are escaped as `` \` ``.
  - `prompts.ts:75`: planner item "6. Tests: each new or changed test (file, name, input, expected result), plus the commands to run and the expected output."
  - `prompts.ts:192` `export const FIX_ROUND`. Line `:197` reads "- Run the step's Repro and the suites named under Facts before you call judge."
  - `prompts.ts:164`: FIX_ROUND is appended to the execute prompt when `opts.testFix` is set.
  - `prompts.test.ts:4` imports `ADVISOR, ARBITER, COMMIT, EXECUTE_PHASE, EXPLORE, JUDGE, JUDGE_KNOWLEDGE_ONLY, NO_SLEEP, PACE, phaseSection, planPhase, RUNNER, TEST_PHASE`. Existing tests call `planPhase(true)` and `planPhase(false, "onRequest", "always")` (`:9-12`). Indentation is tabs.
- **pi-config backlog doc** `docs/workflow-improvements.md`:
  - The Status line is `:5`. It contains "… A22 is implemented; A12 is implemented; A1 is rejected; …".
  - Row A22 is at `:52`, and B12 starts at `:69`. Rows have 6 columns: ID | Problem/Done | Benefit | Effort | Risk | Measure.
  - Effect measurement row A22 is at `:165`; columns are ID | Measure | How | Target. B12 follows at `:166`.
- **knowledge:** `D:/projects/knowledge` is on `main`, 2 commits behind origin.
  - `entries/eng/playbook/release-code-packages.md:29`: item "2. **Test before tagging:** `node scripts/test-packages.mjs --template <game-template> --variant both` … and `node scripts/test-ads-set.mjs …` (… 15-25 minutes). Optionally …".
  - `entries/eng/guideline/sdk-wrapper-packages.md:32`: item "7. **Verify** in `iecgames/unity-packages`: `node scripts/test-packages.mjs --template ../game-template` … `node scripts/test-ads-set.mjs …` …".
- **Config:** pi-config `AGENTS.md` requires backlog rows, the Status line and Effect measurement rows to change in the same commit as the workflow change. New IDs are A23 and A24; rows are never renumbered.

### 4. Design
Not needed: these are text changes to prompts and docs only.

### 5. Steps

### Stage 1: workflow prompts: slow suites once, reruns only when touched (delivery: push)

**S1.** In `D:/projects/pi-config`, check `git status -sb`: it must be clean on `master`.

Then rewrite the start of the bullet at `pi/agent/extensions/workflow/prompts.ts:97` so it contains these exact substrings, in this order, before the existing "When done, run the plan's tests, then call \`judge\`…":
- "While fixing, run the narrowest check that covers the change (one test file, one package, one compile)."
- "Run each slow suite in full once, before your first judge call; run the fast suites before every judge call."
- "After a judge round, rerun a slow suite only if the fix changed files it builds or reads; otherwise cite its last passing run."

Everything from "When done, run the plan's tests, then call \`judge\`" to the end of the bullet stays byte-identical. Keep the template-literal escaping: write no raw backticks.

**S2.** In `prompts.ts:75`, append one sentence to the end of planner item 6, after "…and the expected output.": " Mark each suite slower than about 2 minutes as slow and give its fast command for fixing and its full command, run once."

In `FIX_ROUND` (`:197`), append this to the same line after "…before you call judge.": " After a judge round, rerun a slow suite only if the fix changed files it builds or reads; otherwise cite its last passing run."

Change nothing else in `prompts.ts`.

**S3.** In `docs/workflow-improvements.md`:
- After row A22 (`:52`), add two rows in the same 6-column format:
  - `| A23 | Problem: executors reran slow suites (Unity batch mode, 10-20 min) before every judge call. **Done:** prompts.ts: narrow checks while fixing, each slow suite in full once before the first judge call; the planner marks slow suites with a fast and a full command. | High (T) | S | Medium. A narrow check can miss a failure the full suite catches; the full run before the first judge call covers it. | Unity harness runs and minutes per flow. |`
  - `| A24 | Problem: a judge round that only changed docs or comments triggered a full slow rerun. **Done:** prompts.ts (execute and fix round): rerun a slow suite only if the fix changed files it builds or reads. | Medium (T) | S | Medium. The executor decides what a suite reads; the judge still reviews. | Slow reruns after a judge round whose fix touched no code. |`
- After Effect measurement row A22 (`:165`), add:
  - `| A23 | Unity harness runs per flow and their minutes | Count test-packages.mjs runs and their times in session logs. Implemented, not measured yet. | One full run per stage |`
  - `| A24 | Slow reruns after a judge round whose fix touched no code | Compare fix-round diffs with harness runs in session logs. Implemented, not measured yet. | Zero |`
- In the Status line (`:5`), change "A22 is implemented;" to "A22 is implemented; A23 and A24 are implemented;".

**S4.** Add the test in section 6 to `prompts.test.ts` and add `FIX_ROUND` to the import at `:4`, keeping the import list alphabetical. Run the workflow tests (section 6) and confirm that `git diff --stat` touches only the three files. Then call `judge`.

### Stage 2: knowledge playbooks: faster test-packages runs and iterate-narrow guidance

**S5.** In `D:/projects/knowledge`, run `git fetch` and then `git merge --ff-only origin/main` on `main`. If the fast-forward fails or the tree is dirty, stop and report. Don't touch open PR #155.

**S6.** In `entries/eng/playbook/release-code-packages.md:29` (item 2, "Test before tagging"), keep the existing commands and add in prose:
- `--variant both` runs full and lite at the same time, reuses each variant's `Library` and skips variants whose inputs haven't changed since their last pass.
- Before tagging, use `--fresh` for a clean import. `--serial` runs the variants one after the other.
- While iterating, use `--variant lite --package <changed package>`.
- `test-ads-set.mjs` runs once at the end, and only when the ads packages changed.

In `entries/eng/guideline/sdk-wrapper-packages.md:32` (item 7, "Verify"), add one sentence: iterate with `--variant lite --package <changed package>`, run `--variant both` in full once, and use `--fresh` before tagging. Keep the existing wording otherwise.

If the repo's front-matter rules (enforced by `npm run check`) need an updated date or version field, update it.

**S7.** Run `npm ci` if `node_modules` is missing, then `npm run check`. It must pass. Then call `judge`.

### 6. Tests
- **`pi/agent/extensions/workflow/prompts.test.ts`**, new test `slow suites run once and rerun only when touched`:
  - `EXECUTE_PHASE` contains each of these strings:
    - "While fixing, run the narrowest check that covers the change"
    - "Run each slow suite in full once, before your first judge call"
    - "After a judge round, rerun a slow suite only if the fix changed files it builds or reads; otherwise cite its last passing run"
    - "then call `judge`" (the literal contains a backtick in the rendered string)
  - `planPhase(true)` and `planPhase(false, "onRequest", "always")` each contain "Mark each suite slower than about 2 minutes as slow".
  - `FIX_ROUND` contains "rerun a slow suite only if the fix changed files it builds or reads".
- **Command:**

  ```
  cd D:/projects/pi-config/pi/agent/extensions/workflow && node --test *.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"
  ```

  Expected: `fail 0`, and the pass count is one higher than before. The last known count was 601.
- **knowledge:** `npm run check` passes.

### 7. Done when
- The execute prompt contains the narrow, full-once and rerun-only-when-touched rules. The planner prompt contains the slow-suite marking sentence. `FIX_ROUND` contains the rerun-only-when-touched sentence.
- `docs/workflow-improvements.md` has A23 and A24 marked Done, with Status line and Effect measurement rows.
- The workflow tests pass with `fail 0`, including the new test.
- Both knowledge entries describe the parallel run, `Library` reuse, skipping unchanged inputs, `--fresh`, `--serial`, iterate-narrow, and running `test-ads-set.mjs` once and only when the ads packages changed. `npm run check` passes.
- The pi-config stage is pushed; the knowledge stage is merged.

### 8. Risks, rollback, and what not to touch
- **A narrow check misses a failure:** the full run before the first judge call covers it, and the judge still reviews. Rollback: revert the pi-config commit.
- **An executor misjudges what a suite reads (A24):** the judge reviews, and a fresh run with `--fresh` is always possible. Rollback: revert the commit.
- **Escaping:** a raw backtick in `prompts.ts` breaks the template literal. `node --test` catches that as a syntax error.
- **Don't touch:**
  - unity-packages, including `test-ads-set.mjs`, `copyProject`, `scratch-android-build.mjs`, `lib/package-dev.mjs`, `lib/test-flow.mjs` and the success line;
  - workflow code other than `prompts.ts` and `prompts.test.ts`;
  - other knowledge entries;
  - open PRs game-template #153 and knowledge #155.
- Don't start the Unity Editor. This plan needs no Unity runs.

### 9. Commits
- **Stage 1:** `feat(workflow): run slow suites once and rerun them only when a fix touches them`. Files: `pi/agent/extensions/workflow/prompts.ts`, `pi/agent/extensions/workflow/prompts.test.ts`, `docs/workflow-improvements.md`.
- **Stage 2:** `docs(playbooks): faster test-packages runs and iterate-narrow guidance`. Files: `entries/eng/playbook/release-code-packages.md`, `entries/eng/guideline/sdk-wrapper-packages.md`.

## Plan choices upheld at a pass
pi/agent/extensions/workflow/prompts.test.ts:97 - minor - [plan-flaw] The plan's test asserted the slow-suite sentence on `planPhase(true)` and `planPhase(false, "onRequest", "always")`, but neither of those outputs contains it.
pi/agent/extensions/workflow/prompts.ts:97 - minor - [plan-flaw] The new rerun rule conflicts with the old wording kept in the same bullet.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `D:/projects/pi-config`, check `git status -sb`: it must be clean on `master`.
- [x] S2 In `prompts.ts:75`, append one sentence to the end of planner item 6, after "…and the expected output.": " Mark each sui
- [x] S3 In `docs/workflow-improvements.md`:
- [x] S4 Add the test in section 6 to `prompts.test.ts` and add `FIX_ROUND` to the import at `:4`, keeping the import list alphab
- [x] S5 In `D:/projects/knowledge`, run `git fetch` and then `git merge --ff-only origin/main` on `main`. If the fast-forward fa
- [x] S6 In `entries/eng/playbook/release-code-packages.md:29` (item 2, "Test before tagging"), keep the existing commands and ad
- [x] S7 Run `npm ci` if `node_modules` is missing, then `npm run check`. It must pass. Then call `judge`.
## Outcome
2026-10-22T09:28:54.050Z — ok: stage 1: committed (1 commit), push skipped: master is protected; stage 2: knowledge: committed, PR #156 merged
