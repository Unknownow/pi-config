<!-- pi-workflow plan v1 flow=20261022-1638-slow-suite-rule-without-finalize-and-an-3356 -->
## Plan: Slow-suite rule without finalize, and an unambiguous final test run

### 1. Goal and non-goals
- **Goal:** close the two minor gaps the judge found in commit `32a8401`:
  - **Gap 1:** the planner gets the slow-suite marking rule even when `finalizePlan` is off.
  - **Gap 2:** the execute prompt's "When done, run the plan's tests" no longer reads as "rerun every suite, slow ones included, before each judge call".
- **Non-goals:**
  - No other wording changes in `prompts.ts`.
  - No change to `FIX_ROUND`, `finalize()`, the workflow code, `workflow.json`, or any other repo.
  - No new test; the existing test is extended.

### 2. User decisions
- D1: The user asked to handle all remaining items. The pi-config push, `delivery.default: "merge"` and PRs #153/#155 turned out to be already done, so only these two prompt gaps remain.
- D2: Gap 1 is fixed by appending the slow-suite sentence to `planPhase()`'s non-finalize `ending`.
- D3: Gap 2 is fixed by changing "When done, run the plan's tests," to "When done, run the plan's tests as above,".
- D4: There is one commit, `fix(workflow): slow-suite rule without finalize and unambiguous final test run`, delivered by push.

### 3. Facts the executor needs
- `pi/agent/extensions/workflow/prompts.ts:39-41`: `const ending = finalize ? "…" : '…';`. The non-finalize branch (`:41`) is a single-quoted string ending in `without guessing at behaviour or design.'`.
- `prompts.ts:97`: the execute bullet in `EXECUTE_PHASE`, a template literal in which backticks are escaped as `` \` ``. It contains the exact text `When done, run the plan's tests, then call \`judge\``. That text appears only once.
- The planner sentence already lives in `finalize()` (item 6, `prompts.ts:75`) and must not change: `Mark each suite slower than about 2 minutes as slow and give its fast command for fixing and its full command, run once.`
- `prompts.test.ts:93-99` holds the test `slow suites run once and rerun only when touched`:
  - It checks the substring "then call `judge`" (`:95`). That still matches after the change.
  - It already imports `planPhase` and `EXECUTE_PHASE` (`:4`).
- `docs/workflow-improvements.md:53` is row A23 and `:54` is row A24. Both have a "**Done:** …" text in their second column.
- Test command: `cd pi/agent/extensions/workflow && node --test *.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`. The current result is pass 602, fail 0.
- In this repo, `AGENTS.md` requires backlog doc updates in the same commit.

### 5. Steps
**S1.** In `D:/projects/pi-config`, run `git status -sb`. It must be clean on `master` and level with `origin/master`. If it is not, stop.

**S2.** In `prompts.ts:41` (the non-finalize `ending`), append one space and then the exact sentence from Facts (`Mark each suite slower than about 2 minutes as slow and give its fast command for fixing and its full command, run once.`) before the closing `'`. The finalize branch (`:40`) stays unchanged.

**S3.** In `prompts.ts:97`, replace `When done, run the plan's tests, then call` with `When done, run the plan's tests as above, then call`. Leave the rest of the bullet byte-identical.

**S4.** In `prompts.test.ts`, inside the test at `:93`, add two assertions after `:97`. Their content is given in section 6.

**S5.** In `docs/workflow-improvements.md`, append one sentence to the end of the **Done:** text in each row:
- Row A23 (`:53`): "The planner gets the marking rule with and without finalizePlan."
- Row A24 (`:54`): "The execute prompt says to run the plan's tests "as above", so the final run follows the rerun rule."

Keep the column count. Don't touch the Status line or the Effect rows; both items are already marked implemented.

**S6.** Run the tests (section 6). Check that `git diff --stat` lists exactly `prompts.ts`, `prompts.test.ts` and `docs/workflow-improvements.md`. Then call `judge`.

### 6. Tests
- **File:** `pi/agent/extensions/workflow/prompts.test.ts`. **Test:** `slow suites run once and rerun only when touched`. Add these assertions:
  - `planPhase(false, "onRequest", "always")` includes `"Mark each suite slower than about 2 minutes as slow"`.
  - `EXECUTE_PHASE` includes `"When done, run the plan's tests as above"`.
- **Run:** `cd D:/projects/pi-config/pi/agent/extensions/workflow && node --test *.test.ts 2>&1 | grep -E "^ℹ (pass|fail)"`. Expect `ℹ pass 602` and `ℹ fail 0`; the count is unchanged because no test is added.

### 7. Done when
- The output of `planPhase(false, …)` contains the slow-suite marking sentence.
- `EXECUTE_PHASE` contains "When done, run the plan's tests as above, then call `judge`".
- The A23 and A24 Done notes mention these fixes.
- The tests pass with `fail 0`.
- One commit is pushed to `origin/master`.

### 8. Risks, rollback, what not to touch
- **Risk:** tests that compare whole prompt strings could break. If any test other than the extended one fails, compare its expected text with the new text and report it; don't weaken other tests.
- **Rollback:** revert the commit.
- **Don't touch:**
  - `finalize()`, `FIX_ROUND`, and the finalize branch of `ending`.
  - Other workflow files, `workflow.json`, and other repos.
  - The doc's Status line and Effect rows.

### 9. Commits
- `fix(workflow): slow-suite rule without finalize and unambiguous final test run`: `pi/agent/extensions/workflow/prompts.ts`, `pi/agent/extensions/workflow/prompts.test.ts`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 In `D:/projects/pi-config`, run `git status -sb`. It must be clean on `master` and level with `origin/master`. If it is 
- [ ] S2 In `prompts.ts:41` (the non-finalize `ending`), append one space and then the exact sentence from Facts (`Mark each suit
- [ ] S3 In `prompts.ts:97`, replace `When done, run the plan's tests, then call` with `When done, run the plan's tests as above,
- [ ] S4 In `prompts.test.ts`, inside the test at `:93`, add two assertions after `:97`. Their content is given in section 6.
- [ ] S5 In `docs/workflow-improvements.md`, append one sentence to the end of the Done: text in each row:
- [ ] S6 Run the tests (section 6). Check that `git diff --stat` lists exactly `prompts.ts`, `prompts.test.ts` and `docs/workflow
