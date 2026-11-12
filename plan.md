<!-- pi-workflow plan v1 flow=20261112-1946-make-new-tests-optional-and-ask-the-user-a728 -->
## Plan: Make new tests optional and ask the user each time (workflow, knowledge, game-template, city-bus-flow)

Stages: 1. Workflow extension and pi-config sync; 2. Knowledge rule and decision; 3. game-template rule (ends in its merge); 4. city-bus-flow takes the template change.

### 1. Goal and non-goals
**Goal:** agents stop writing a new Unity test on every run. Writing a new test, or changing or deleting an existing one, becomes optional. The agent asks the user each time and describes each test. Only three kinds of test are still written without asking: golden saves, contract fixtures, and fixture runs for a new implementation.

**Non-goals:**
- Running existing tests stays as it is (`eng.rule.testing-on-request`, `tools test --changed`).
- No existing test is deleted.
- city-bus-flow takes no other template commits.
- No Unity code changes.

### 2. User decisions
- **D1:** Remove the "write a test" requirements from the workflow extension, then sync pi-config.
- **D2:** In knowledge and game-template, tests are optional. The agent asks the user every time and describes each test.
- **D3:** city-bus-flow follows game-template upstream with a "Take template <sha>" PR, as the last step of this work.
- **D4 (Q1):** The agent also asks before changing or deleting an existing test, even when the change breaks it on purpose.
- **D5 (Q2):** Golden saves and contract fixtures stay required and are written without asking.
- **D6 (Q4):** The executor merges the knowledge, game-template and city-bus-flow PRs itself after the judge passes and the checks are green.
- **D7 (A):** When asked about an existing test that a change breaks on purpose, the user picks one of: a) update the test as described; b) delete it (deleting counts as changing); c) keep the old behaviour. The PR stays open until the user answers.
- **D8 (B):** `testPlan()` adds a default line: no test is written, changed or deleted unless the user approved it. A fix that needs a test changed is reported as not done, with the reason. The user approves by answering on that bug item (`D<n>. <ID>: approve …`), and that answer overrides the default in the next round.
- **D9 (C):** Plan section 6 keeps its heading `6. Tests` and lists only the tests the user approved. The judge checks only those tests.
- **D10:** An unexpected test break: in a normal flow the executor stops and asks; in a test-flow fix round the step is reported as not done.
- **D11:** The question about tests gives, for each test: the file, the test name, the setup, input and expected result, what break it catches, the assembly, how long it runs, and the command. All tests for one change go in one question. In a flow, the question is asked during discuss or plan and the answer is recorded as a D<n>.

Merge points:
- S7: `pi-config sync` pushes straight to pi-config `master`. This is how the repo syncs.
- S20: game-template must be merged before city-bus-flow can take its commit SHA.

### 3. Facts
- **Installed extension:** `C:\Users\unkno\.pi\agent\extensions\workflow\`. Its `prompts.ts` and `test-flow.ts` are the same as `d:/works/pi-config/pi/agent/extensions/workflow/`. The `*.bak-*` files exist only in the installed copy and are not exported.
- **Lines to change in `prompts.ts`:**
  - 58: the plan template's section 6
  - 142, 145, 156: the judge
  - 170: the discussion judge, item 6
- **Lines to change in `test-flow.ts`:** 207-229 (`testPlan`); the Done-when line is 223 and the commit line is 226.
- **D-numbers:** `answerItem` (`test-flow.ts:152-155`) numbers answers `D${answers.length+2}`.
- **Test flow not wired in:** `test-flow.ts` is imported only by its tests. `index.ts` doesn't call it in this commit.
- **Section heading parser:** `plan-doc.ts:31` finds sections by `\d\.\s*(…|Tests|…)`, and `plan-doc.test.ts:18` uses `### 6. Tests`.
- **Extension test command:** `workflow/README.md:229`, using `node --experimental-strip-types --test …`.
- **pi-config:**
  - `pi-config export` copies the machine's files into the repo. `pi-config sync` exports, commits and pushes to `master`.
  - pi-config `AGENTS.md`: a workflow change updates `docs/workflow-improvements.md` in the same commit (its line 9): the item's row, the Status line (line 5), and a row in the "Effect measurement" table (line 152 onward).
  - The highest A ID is A46, so the new item is A47.
- **Knowledge:**
  - Entry fields are in `schema/fields.yaml`, including `replaced_by` and `paths`. A rule without `paths` goes into every eng rule pack.
  - Model the new rule on `entries/eng/rule/testing-on-request.md`.
  - Check with `knowledge.bat check`. The pre-push hook blocks pushes to `main`; enable it with `git config core.hooksPath .githooks`.
  - `docs/plans/design.md:845` is the "Appendix: Superseded" table.
- **Knowledge files that mention tests:**
  - **Rewrite (they ask for new tests):**
    - `entries/eng/guideline/testing-the-base.md:14,25`
    - `entries/design/decision/test-rules.md:18` (rule 4)
    - `entries/eng/guideline/asmdef-versiondefines-plain-versions.md:20`
    - `entries/eng/guideline/scripts-normalise-line-endings.md:18`
    - `entries/eng/playbook/add-or-edit-module.md:23`
    - `entries/eng/playbook/add-meta-feature.md:7,24`
    - `entries/eng/playbook/add-camera-behaviour.md:32`
    - `entries/eng/playbook/convert-view-to-prefab.md`
    - `docs/plans/design.md:621`
    - `docs/plans/new-base-plan.md`
  - **Exceptions (D5), keep them and add a link to the new rule:**
    - golden save and contract lines in `add-save-section.md:36`
    - `add-game-state-and-route.md:28`
    - `skills/base-game/SKILL.md:52`
    - `extension-point-contract.md`
    - `save-sections-and-durability.md`
  - **Check with grep:** `add-ads-vendor`, `add-analytics-provider`, `in-app-purchases`, `save-data-and-app-state`, `one-inventory-item-kinds`, `payments-in-economy`, `game-saves-use-secure-store`, and the rules `game-state-in-save-sections`, `inventory-changes-are-transactions`, `modules-fall-back-to-mocks`, `no-unity-api-on-workers`. Most only say that existing or contract tests pass, and those stay.
- **game-template:**
  - Rules go in `AGENTS.md` section 2; the merge checklist is section 8.
  - The local `main` is 5 commits behind `origin/main`.
  - Tasks use `tools tasks add|set|report|diff main`.
- **city-bus-flow:**
  - The main clone is on `flow/k209-turn-in-push-contact`.
  - The upstream remote is `upstream` (game-template).
  - Template changes come in "Take template <sha>" PRs (#120, #99), each with a task.
  - `AGENTS.md` section 2 differs from the template's because of decision 102 (`--skip-unity`).
  - Its design and notes docs already say "no new tests". Leave them as they are.

### 4. Design
The policy is defined once, in a knowledge rule with its decision entry. The other places point to it:
- The workflow prompts only remove the test requirements and refer to "tests the user approved".
- The game-template `AGENTS.md` names the rule.

**The rule `eng.rule.new-tests-on-request`:**
- type `rule`, domain `eng`, no `paths`
- tags `[testing]`
- related: `design.decision.new-tests-on-request`, `eng.rule.testing-on-request`, `design.decision.test-rules`

**Rule text:**
1. Writing a new test, or changing or deleting an existing one, is optional. Before doing any of it, ask the user one question that covers every test the change would need, with the D11 details for each. Then wait for the answer.
2. In a workflow, ask during discuss or plan. Record the answer as a user decision. The plan's `6. Tests` lists only the approved tests.
3. When a change breaks an existing test on purpose, offer the D7 choices a, b and c. The PR stays open until the user answers, because `tools test --changed` must pass.
4. When a test breaks that nobody expected:
   - In a normal flow, stop and ask.
   - In a test-flow fix round, report the step as not done, with the reason.
5. Written without asking, then reported to the user:
   - a new contract fixture for a new extension point
   - the test that runs a fixture against a new implementation
   - a golden save for each new save-section version
6. Running existing tests follows `eng.rule.testing-on-request`.

**The decision `design.decision.new-tests-on-request`:**
- **Context:** the workflow prompts and the "every bug fix adds a test" lines made agents add a test on every run.
- **Decision:** as in the rule above.
- **Consequences:** fewer tests are written. A regression may be caught later. The three exceptions still protect saves and contracts.
- It replaces `test-rules` rule 4 and the `design.md:621` line.

**Rejected alternative:** a rule only in each game's `AGENTS.md`. The workflow prompts and the team guidelines would still win over it.

### 5. Steps

### Stage 1: Workflow extension and pi-config sync
**S1. Plan template, `prompts.ts:58`.**
- Keep the heading text `6. Tests` exactly.
- New wording: "Tests: only the tests the user approved (a User decision): file, name, input, expected result; none when the user approved none."
- Keep the commands, the expected output and the slow-suite sentence.

**S2. Judge prompt.**
- **`prompts.ts:142`:** keep "You cannot run code. Treat any claim that tests pass as unverified." Replace the rest with: "When the user approved new or changed tests (a User decision), check that those exist, test the target and would fail without the change. Never ask for other tests."
- **`prompts.ts:145`:** becomes "2. The plan: every step done; nothing beyond it that changes behaviour; the tests the user approved are present, and no others were added."
- **`prompts.ts:156`:** remove ", which test to add".

**S3. Discussion judge, `prompts.ts:170`:** becomes "6. Missing acceptance criteria."
- Then grep every live `.ts` file in `workflow/`, `agents/` and `orchestrate/` (skip `*.bak-*`) for "regression test", "which test to add", "fail without the change", "missing or weak tests" and "new or changed test".
- Change any other line that asks for a new test the same way.

**S4. `testPlan()` in `test-flow.ts:207-229`.**
- **New decision line**, right after `...f.answers`: `D${f.answers.length + 2}. Tests: write, change or delete none unless the user approved it in an answer above; a fix that needs one is reported as not done, with the reason.` This keeps D-numbers unique.
- **Done-when:** replace line 223 with "- no test written, changed or deleted beyond the user's answers; a step that needs one is reported as not done, with the reason".
- **Commits:** line 226 becomes "- one commit per step: fix: <title> (S<n>)".
- **Doc comment on `answerItem`:** an approval for a test is recorded as an answer on the bug item (`D<n>. <ID>: approve updating <test>`).

**S5. Tests (approved by approving this plan).**
- **Extend `test-flow.test.ts` "testPlan" (line 55):** with one answer `D2. S3: yes`, check that:
  - the plan contains `D3. Tests: write, change or delete none`
  - every `D<n>` at the start of a line is unique
  - the plan doesn't contain "regression test"
- **Prompt and plan-doc tests:** update `prompts.test.ts` and `plan-doc.test.ts` only if they assert the old wording.

**S6. pi-config backlog.**
1. Run `pi-config export`.
2. In `d:/works/pi-config/docs/workflow-improvements.md` add row **A47**: "Problem: agents added a test every run (plan section 6, judge checks, test-flow regression lines). **Done:** prompts.ts, test-flow.ts; tests only when the user approved them." Use the same columns as the other rows.
3. Update the Status line, adding A47.
4. Add an A47 row to the Effect measurement table:
   - Metric: new test files or cases per flow, and judge "missing test" findings.
   - How: count them in diffs and judge output across 3-5 flows.
   - Keep if: none without approval, and no rise in bugs that escape.

**S7. Deliver: pi-config.**
- Commit the exported extension files together with the docs change, in one commit, on `master`.
- Run `pi-config sync`, which pushes to `master`.
- Check that `pi-config status` shows no differences.

### Stage 2: Knowledge rule and decision
**S8. Branch.** In `D:/works/annamites/knowledge`, pull `main`, enable the hooks, and create branch `feat/new-tests-on-request`.

**S9. New files.** Add `entries/eng/rule/new-tests-on-request.md` and `entries/design/decision/new-tests-on-request.md` as described in section 4.
- Model their front matter on `testing-on-request.md` and `tests-on-request.md`.

**S10. `design.decision.test-rules`.**
- Rule 4 becomes: "Superseded by `design.decision.new-tests-on-request`: new and changed tests only when the user approves them; golden saves and contract fixtures are still required."
- Update the summary ("a test with each fix") to match.
- Add the new decision to `related`.

**S11. `design.decision.tests-on-request`:** add the new decision to `related`, with one cross-link line in the body.

**S12. `testing-the-base`.**
- **Line 14:** becomes "Tests run with no real time and no real SDKs. New tests only when the user approves them (`eng.rule.new-tests-on-request`)."
- **Line 25, step 1:** becomes "Propose the unit test to the user (`eng.rule.new-tests-on-request`); when approved, write it in the module's `Tests/Editor`."
- **Contract fixtures and golden files:** keep both lines, marked "required, no approval needed".

**S13. Other entries.** Rewrite every line in section 3's "rewrite" list the same way.
- **Pattern:** an order like "add a test" or "write tests" becomes "propose a test to the user (`eng.rule.new-tests-on-request`)".
- **Exception lines:** keep them, and add "(required; `eng.rule.new-tests-on-request`)".
- **Grep list:** check each file in section 3's "check with grep" list. Change only lines that order a new non-exception test.

**S14. `docs/plans/design.md`.**
- **Line 621:** becomes "No real time and no real SDKs. New tests only when the user approves them."
- **"Appendix: Superseded" table:** add the row "Every bug fix adds a test | `design.decision.new-tests-on-request`: tests on request; golden saves and contract fixtures required".
- **`new-base-plan.md`:** add the same "*Superseded by …*" note next to its line about bug-fix tests, in the style of line 43.

**S15. `skills/base-game/SKILL.md:52`:**
- Keep "a contract test".
- Add a line: "Other new or changed tests: ask first (`eng.rule.new-tests-on-request`)."

**S16. Check and PR.** Run `knowledge.bat check`, which must pass. Open the PR. Merge at the end of the flow (D6).

### Stage 3: game-template rule
**S17. Branch.** In `D:/works/annamites/game-template`, pull `main` (5 commits behind) and create branch `docs/new-tests-on-request`.

**S18. `AGENTS.md`.**
- **Section 2:** add a rule numbered 2a, right after rule 2: "New tests, and changes or deletions of existing ones, are optional: ask the user first, every time, with the details listed in `eng.rule.new-tests-on-request` (golden saves, contract fixtures and fixture runs are the exceptions). In a flow, ask during discuss or plan."
- **Merge checklist, section 8:** add an item: "Only the new or changed tests the user approved (golden saves, contract fixtures and fixture runs excepted)." Renumber the items after it.

**S19. Task, checks and PR.**
1. Add a task with `tools tasks add`. Done criteria: the rule is in `AGENTS.md` and the merge checklist has the new item.
2. Set it to done, with this PR as evidence.
3. Run `tools tasks report`.
4. Once the judge passes, run `tools test --changed` once. With no Unity code changed, it should only run `check`.
5. Open the PR. Paste the `test --changed` output and `tools tasks diff main` into it.

**S20. Deliver: merge the game-template PR.** Stage 4 needs its merged SHA.

### Stage 4: city-bus-flow takes the template change
**S21. Worktree.**
- Run `git -C D:/works/annamites/city-bus-flow fetch origin upstream`.
- Create worktree `D:/works/annamites/city-bus-flow-take-template` from `origin/main`, on branch `flow/take-template-<short sha>`.
- Don't touch the main clone or its branch. No Unity run, so no `Library/` is needed.

**S22. `AGENTS.md`.**
- Copy in rule 2a and the merge-checklist item from the merged template, by hand. Don't cherry-pick.
- Keep decision 102's `--skip-unity` text.
- Add a task with the title "Take template <sha>: new tests on request", then run `tools tasks report`.

**S23. Checks and PR.**
- Once the judge passes, run `tools test --changed` once.
- Open the PR "Take template <sha>: new tests only on request (K…)", with the test output and `tools tasks diff main`.
- Merge it at the end of the flow, together with the knowledge PR, then remove the worktree.

### 6. Tests
- **Workflow, fast (run while fixing):** in `C:/Users/unkno/.pi/agent/extensions/workflow`, run `node --experimental-strip-types --test test-flow.test.ts plan-doc.test.ts prompts.test.ts`. Leave out any file that doesn't exist. Expect 0 failures.
- **Workflow, full (once, before the first judge call):** the command at `workflow/README.md:229`. Expect 0 failures.
- **Changed test:** `test-flow.test.ts`, test "testPlan" (S5). Expect `D2. S3: yes` and `D3. Tests: …`, no duplicate D-number, and no "regression test".
- **Knowledge:** `knowledge.bat check`. Expect the tests to pass and every entry to validate.
- **game-template and city-bus-flow:** `tools test --changed`, once each. Expect PASS with no Unity tests, because only docs and `AGENTS.md` change.
- **Done-check grep:** case-insensitive, for "adds? (one |a )?test|add tests|write tests|write the unit test first|regression test|which test to add|would fail without the change|missing or weak tests|each new or changed test". Run it over:
  - knowledge `entries/`, `skills/`, `docs/`
  - game-template `AGENTS.md`, `.agents/`, `docs/knowledge/`
  - city-bus-flow `AGENTS.md`, `.agents/`
  - the live `.ts` files of the workflow extension

  Leave out `*.bak-*`, `docs/design/`, `docs/notes/`, `docs/decisions/` of the game repos, `tasks.json` and `progress.md`. Allowed matches:
  - golden-save, contract-fixture and fixture-run lines
  - the approved-test wording in `prompts.ts` ("tests the user approved", "would fail without the change" in the approved clause)
  - the superseded notes
  - `test-flow.test.ts` asserting "regression test" is absent

### 7. Done when
- The workflow plan template, the judge, the discussion judge and `testPlan()` no longer ask for new tests. They refer only to tests the user approved. pi-config `master` has the change and A47, and `pi-config status` shows no differences.
- Knowledge has `eng.rule.new-tests-on-request` (global, with D7, D10, D11 and the D5 exceptions) and `design.decision.new-tests-on-request`. Rule 4 and the `design.md` line are marked superseded. The other entries point to the new rule. The PR is merged.
- game-template's `AGENTS.md` has rule 2a and the checklist item, with its task done. The PR is merged.
- city-bus-flow has the same lines in a "Take template <sha>" PR, alongside decision 102, with its task done. The PR is merged.
- The done-check grep returns only the allowed matches.
- Every check in section 6 passes.

### 8. Risks, rollback, what not to touch
- **Risk:** fewer regression tests mean some bugs are found later. The decision entry records this.
- **Risk:** the judge's prompt change also affects non-Annamites projects. That is intended (D1).
- **Rollback:** revert the pi-config commit, then run `pi-config import`. Revert the PRs in the other repos.
- **Don't touch:**
  - the main clone of city-bus-flow and its branch `flow/k209-…`
  - the `.bak-*` files
  - the city-bus-flow design and notes docs
  - `eng.rule.testing-on-request`, except for a related link
  - any test code in the game repos

### 9. Commits
- **pi-config:** `workflow: tests only when the user approves them (A47)`: `pi/agent/extensions/workflow/prompts.ts`, `test-flow.ts`, `test-flow.test.ts` (and the prompt or plan-doc tests if they changed), `docs/workflow-improvements.md`.
- **knowledge:** `New and changed tests only on request; golden saves and contract fixtures required`: the two new entries, the edited entries, the playbooks, the guidelines, `design.md`, `new-base-plan.md`, `skills/base-game/SKILL.md`.
- **game-template:** `AGENTS: new tests only when the user approves them (K…)`: `AGENTS.md`, `docs/tasks.json`, `docs/progress.md`.
- **city-bus-flow:** `Take template <sha>: new tests only on request (K…)`: `AGENTS.md`, `docs/tasks.json`, `docs/progress.md`.

## Amendment 1 (arbiter: merge)
Merge allowed in stage 1: The approved plan names S7 as a merge point in section 2: "`pi-config sync` pushes straight to pi-config `master`. This is how the repo syncs." That puts this merge inside the user's approved intent, so it isn't something the executor added for convenience. Section 7's "Done when" also requires "pi-config `master` has the change and A47, and `pi-config status` shows no differences." pi-config has no PR flow, and its HEAD is already on `master` (`.git/HEAD` → `refs/heads/master`, commit `cc50eb9` "workflow: tests only when the user approves them (A47)"). So pushing a branch can't deliver this step; the push to `master` is the delivery. The executor says the judge passed; stage 1's other steps (S1–S6) are checked off.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Plan template, `prompts.ts:58`.
- [x] S2 Judge prompt.
- [x] S3 Discussion judge, `prompts.ts:170`: becomes "6. Missing acceptance criteria."
- [x] S4 `testPlan()` in `test-flow.ts:207-229`.
- [x] S5 Tests (approved by approving this plan).
- [x] S6 pi-config backlog.
- [x] S7 Deliver: pi-config.
- [x] S8 Branch. In `D:/works/annamites/knowledge`, pull `main`, enable the hooks, and create branch `feat/new-tests-on-request`.
- [x] S9 New files. Add `entries/eng/rule/new-tests-on-request.md` and `entries/design/decision/new-tests-on-request.md` as descr
- [x] S10 `design.decision.test-rules`.
- [x] S11 `design.decision.tests-on-request`: add the new decision to `related`, with one cross-link line in the body.
- [x] S12 `testing-the-base`.
- [x] S13 Other entries. Rewrite every line in section 3's "rewrite" list the same way.
- [x] S14 `docs/plans/design.md`.
- [x] S15 `skills/base-game/SKILL.md:52`:
- [x] S16 Check and PR. Run `knowledge.bat check`, which must pass. Open the PR. Merge at the end of the flow (D6).
- [ ] S17 Branch. In `D:/works/annamites/game-template`, pull `main` (5 commits behind) and create branch `docs/new-tests-on-reque
- [ ] S18 `AGENTS.md`.
- [ ] S19 Task, checks and PR.
- [ ] S20 Deliver: merge the game-template PR. Stage 4 needs its merged SHA.
- [ ] S21 Worktree.
- [ ] S22 `AGENTS.md`.
- [ ] S23 Checks and PR.
