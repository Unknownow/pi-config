<!-- pi-workflow plan v1 flow=20261111-0209-tick-plan-steps-when-they-are-finished-n-54c2 -->
## Plan: Tick plan steps when they are finished, not after the judge passes

**Goal:** the progress count (status bar `plan N/M`, flow card bar and current step, `plan_check` reply, plan file) moves as each step is implemented. A tick means "implemented, claimed by the executor". The judge's PASS on the exact tree stays the only proof, and the merge, protected-push and publish gates don't change.

**Non-goals:**
- No change to the code that reads `done`: the gates, `gateOpenSteps`, `noChangeTurn`, `flowWithoutChanges`, `publish_packages`, view or report.
- No separate "judged" state per step.
- No judge verdict on the flow card.
- No "claimed" wording in the flow report. Both of these go into the backlog row as ideas only.

**User decisions:**
- D1. The count stays based only on `done`. The fix is in the prompts: the executor ticks a step when it finishes it.
- D2. At a judge PASS, ticking becomes a catch-up ("tick any finished steps not ticked yet") before commit, push and merge. It is no longer the moment ticking happens.
- D3. Mitigations go into the execute prompt:
  - send `plan_check` in the same reply as the next tool call;
  - tick `Deliver:`, `Publish:`, `Mirror:` and `Wait:` steps only after their action has happened;
  - untick with `undone` when a judge finding shows a ticked step isn't finished.
- D4. Add a new row to `docs/workflow-improvements.md` for this finding, marked Done.

### Steps

**S1.** Rewrite the per-step tick rule in `pi/agent/extensions/workflow/prompts.ts:111` (`EXECUTE_PHASE`). Replace "After finishing a step, call `plan_check` with its ID." with one bullet that says:
- Tick a step with `plan_check` as soon as it is implemented. Put the call in the same reply as your next tool call, and don't save ticks for the judge.
- A tick means implemented, not judged.
- Tick a `Deliver:`, `Publish:`, `Mirror:` or `Wait:` step only after its action has happened (merge or tag done, package published, check passing). `publish_packages` refuses a step that is already ticked.
- If a judge finding shows a ticked step isn't finished, untick it with `plan_check` `undone`.
- Keep the existing rule at `:117` unchanged: `Verify:` steps are never ticked.

**S2.** Change the four "tick at pass" phrases into catch-ups. The wording must say "not ticked yet" or "still open", so it is clear ticking already happened:
- `prompts.ts:113`: "When the judge passes, tick the finished steps with `plan_check`, then commit…" becomes "When the judge passes, tick any finished steps not ticked yet with `plan_check`, then commit…". The rest of the sentence stays word for word.
- `prompts.ts:117`: "At a stage end, get the judge's pass, commit and push, tick its steps and end your turn" becomes "… commit and push, tick any of its steps not ticked yet and end your turn".
- `stages.ts:75` and `:76` in `stageStart`: "tick its steps" and "tick the steps" become "tick any of its steps not ticked yet" and "tick any steps not ticked yet".
- `index.ts` judge tool `description` (around `:2529`): "…tick the steps and end your turn" becomes "…tick any steps not ticked yet and end your turn".
- `index.ts:2557-2558` PASS addenda: "Tick the finished steps with plan_check." and ", tick the finished steps with plan_check," become "Tick any finished steps not ticked yet with plan_check." and ", tick any finished steps not ticked yet with plan_check,".
- Leave `prompts.ts:116` ("all steps ticked, after the final judge pass") and the stage-end nudge at `index.ts:3724` unchanged. Both are correct as they are.

**S3.** Add a row to `docs/workflow-improvements.md` in section D, with the next free ID **D38** (the last one is D37). Follow the rules in "Keeping this file current":
- **Problem:** the progress count stayed at 0/N until the judge passed. `prompts.ts` said both "tick after finishing a step" and "when the judge passes, tick the finished steps", so executors ticked in one batch after the PASS.
- **Done:** ticks happen as steps finish (`prompts.ts`, `stages.ts`, `index.ts` judge texts); the PASS tick is a catch-up; action steps are ticked only after their action; unticked when a finding reopens a step.
- **Ideas, not done:** show the last judge verdict on the flow card; in an aborted flow's report, call ticks "claimed".
- **Ratings:** benefit Low (visibility), size S, risk Low: the gates still need a PASS on the exact tree, and early ticks only affect the no-change stage and flow prompts.
- Add D38 to the Status line's list of implemented items.
- Add a D38 row to the "Effect measurement" table, modelled on the D37 row at line 218. Metric: share of a flow's `plan_check` calls made before its first judge PASS (from the session log). Target: most of them.

### Tests
- `prompts.test.ts:109`: update the regex to the new `:113` wording ("When the judge passes, tick any finished steps not ticked yet with `plan_check`, then commit and push and open the pull request; merge it only when…").
- `prompts.test.ts`, new test "the execute prompt ticks steps as they finish". It checks that `EXECUTE_PHASE`:
  - contains "as soon as it is implemented", "`undone`" and "not judged";
  - names `Publish:` in the tick-after-action rule;
  - does not match `/tick the finished steps/`.
- `stages.test.ts` "stageStart and nextStage" (`:42`): assert that the stage text for a middle stage and for the last stage contains "not ticked yet" and does not contain "tick its steps and".
- Run from `pi/agent/extensions/workflow`:
  - `node --experimental-strip-types --test prompts.test.ts stages.test.ts` (expected: all pass)
  - the full list from `README.md:227` (expected: all pass, 0 failures)
- `grep -n "tick the finished steps\|tick the steps\|tick its steps and" prompts.ts stages.ts index.ts` should print nothing.

### Done when
- No execute-phase prompt, stage text, judge description or PASS addendum tells the executor to tick for the first time after the judge passes. Every one of them treats the PASS tick as a catch-up.
- The execute prompt has the immediate-tick rule with the three D3 mitigations.
- No code that reads `done` has changed.
- The tests above pass.
- `docs/workflow-improvements.md` has the D38 row, its Status entry and its Effect-measurement row.

**Risks and rollback:**
- Sonnet may still batch ticks. If it does, the measurement in S3 will show it.
- Rollback is a revert of one commit.
- Don't touch `checkpoints.ts`, `merge-gate.ts`, `agent-end.ts` or the `done` readers in `index.ts`.

**Commits:** one commit, `workflow: tick plan steps as they finish; the judge-pass tick is a catch-up`, with `prompts.ts`, `stages.ts`, `index.ts`, `prompts.test.ts`, `stages.test.ts` and `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Rewrite the per-step tick rule in `pi/agent/extensions/workflow/prompts.ts:111` (`EXECUTE_PHASE`). Replace "After finish
- [ ] S2 Change the four "tick at pass" phrases into catch-ups. The wording must say "not ticked yet" or "still open", so it is c
- [ ] S3 Add a row to `docs/workflow-improvements.md` in section D, with the next free ID D38 (the last one is D37). Follow the r
