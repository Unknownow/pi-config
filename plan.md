<!-- pi-workflow plan v1 flow=20261017-0018-judge-result-reminds-the-executor-of-unt-95df -->
## Plan: Judge result reminds the executor of unticked plan steps

### 1. Goal and non-goals
**Goal:** when the executor calls `judge` during the execute phase and steps of the current stage are still unticked, the judge tool's result ends with a reminder line that names those steps and points to `plan_check`. This catches the executor skipping `plan_check`, as happened in an earlier session where the card stayed at "0 of 13 done".

**Non-goals:**
- No change to `prompts.ts` texts, the judge's prompts, verdict logic, or the judge model's input.
- No auto-ticking, no blocking. The judge still passes or fails on the diff alone.
- No change to delivery or `protectedBranches`. The missing push was checked and is by design (fact F6).
- No change to `plan_check` itself or to the plan card.

### 2. User decisions
- D1: Add the reminder at the judge call. It is a reminder line in the judge result, non-blocking.
- D2: Do not auto-tick steps on a judge pass. The checklist stays the executor's claim.
- D3: Look into the missing push. Finding: on protected branch `master`, push is downgraded to commit by design. No code change.
- D4: The flow's delivery is commit + push.

### 3. Facts the executor needs
- F1: The `plan_check` tool is at `index.ts:1457-1493`. Its open-step filter is at `index.ts:1482`: `!i.done && (!staged || i.stage === undefined || i.stage === staged.current)`, with `staged = currentStages()`.
- F2: `currentStages()` (`index.ts:459-462`) returns `{ stages, current }` or `null` when the plan is not staged.
- F3: The `judge` tool's `execute` is at `index.ts:1555-1576`.
  - It returns early with "No changes to review." when the diff is empty (`:1562`).
  - The result text is `let text = r.text` (`:1567`). When there is a plan flaw, "This review questions the plan. … end your turn now; …" is appended (`:1570-1572`).
  - `hasPlanFlaw` reads `r.text`, not `text`, so appending to `text` does not change flaw detection.
- F4: `ChecklistItem` (`plan-doc.ts:5-12`) is `{ id, text, stage?, done }`. `state.checklist?: ChecklistItem[]` is at `index.ts:132`.
- F5: `plan-doc.test.ts` imports from `./plan-doc.ts` (line 3) and uses `import test from "node:test"` and `assert` from `node:assert/strict`.
- F6: Push downgrade:
  - `prepareDelivery` (`index.ts:2472-2497`) sets `mode = "commit"` and warns `on <branch>, committing without pushing` when the branch is in `cfg.protectedBranches`.
  - `pi/agent/workflow.json:65-68` lists `main` and `master`. The default is at `config.ts:178`.
- F7: README "Step checklist" bullet: `README.md:51`.

### 4. Design
- **New pure helper** in `plan-doc.ts`, so it can be tested without `index.ts`'s closure:
  `export function openStepsReminder(checklist: ChecklistItem[] | undefined, stage?: number): string | undefined`
  - Open steps are those with `!done && (stage === undefined || i.stage === undefined || i.stage === stage)`. This is the same rule as F1.
  - It returns `undefined` when the checklist is missing, empty, or has no open steps.
  - Otherwise it returns exactly: ``Open steps not ticked: S3, S5. Tick the finished ones with `plan_check`.``
    - IDs are joined with `, ` in checklist order.
    - Use `"Open step not ticked: S3. …"` when there is exactly one.
- **Caller:** the `judge` tool's `execute`. It applies only when `state.phase === "execute"`. It passes `currentStages()?.current` as `stage`.
- **Where the line goes:** after `r.text` and before the plan-flaw sentence, separated by a blank line (`\n\n`). The "end your turn now" instruction stays last.
- **When it is added:** on PASS and FAIL alike. It is not added on the "No changes to review." early return, and not on ERROR (that path throws).
- **Scale:** plans have about 5-40 steps, so the line stays short. No cap is needed.
- **Rejected alternatives:**
  - Auto-tick on pass (D2).
  - Blocking the judge until steps are ticked: this would add friction and break the "claims, not proof" model.
  - Rewording the execute prompt: the non-goal keeps prompt texts unchanged.

### 5. Steps
**S1.** `plan-doc.ts`: add `openStepsReminder` after `mergeChecklist` (`plan-doc.ts:86`), with a one-line doc comment. Its behaviour is as in section 4. Model the filter on `index.ts:1482`.

**S2.** `index.ts`, in the `judge` tool's `execute` (`index.ts:1567-1572`):
- Import `openStepsReminder` from `./plan-doc.ts` alongside the existing plan-doc imports.
- After `let text = r.text;`, if `state.phase === "execute"`, compute `openStepsReminder(state.checklist, currentStages()?.current)`. When it is defined, append `\n\n` + the reminder to `text`.
- Leave the plan-flaw append after this so it stays last.
- Change nothing else in that function.

**S3.** `plan-doc.test.ts`: add the tests in section 6 and add `openStepsReminder` to the import on line 3.

**S4.** `README.md:51`, "Step checklist" bullet: add one sentence. When `judge` runs with steps of the current stage still unticked, its result ends with a reminder naming them. This does not affect the verdict.

**S5.** Run every test file (section 6).

### 6. Tests
In `plan-doc.test.ts`:
- `openStepsReminder: none open` → `[{id:"S1",text:"a",done:true}]` returns `undefined`. Both `undefined` and `[]` also return `undefined`.
- `openStepsReminder: lists open steps in order` → S1 done, S2 open, S3 open, no stage. Returns exactly ``Open steps not ticked: S2, S3. Tick the finished ones with `plan_check`.``
- `openStepsReminder: singular` → only S2 open. Returns ``Open step not ticked: S2. Tick the finished ones with `plan_check`.``
- `openStepsReminder: only the current stage` → S1 (stage 1, open), S2 (stage 2, open), S3 (no stage, open), with `stage = 2`. Returns the line naming `S2, S3`.

Commands, from `pi/agent/extensions/workflow/`:
- `node --experimental-strip-types --test plan-doc.test.ts` should give `ℹ fail 0`.
- `for f in *.test.ts; do node --experimental-strip-types --test "$f" >/tmp/o.txt 2>&1 || echo "FAIL $f"; done` should print nothing.

### 7. Done when
- A `judge` call in the execute phase with unticked steps in the current stage returns a result ending in the reminder line. It comes before the plan-flaw sentence when that sentence is present.
- With every step of the current stage ticked, with no checklist, or outside the execute phase, the result text is unchanged.
- Verdicts, flaw detection and the judge's input are unchanged.
- No delivery or config change (D3).
- The four new tests pass and every `*.test.ts` passes.
- The README sentence is added.

### 8. Risks, rollback, and what not to touch
- **Risk:** the executor might untick or tick steps blindly just to silence the line. That is acceptable, because the judge still checks the diff (the checklist is "claims, not proof", `index.ts:816`).
- **Rollback:** revert the single commit.
- **Do not touch:**
  - `prompts.ts`, `JUDGE_*`, `judge()`/`judgeOnce`, `hasPlanFlaw`, `r.text`
  - `plan_check`, `planCard`
  - `prepareDelivery` and `protectedBranches`
  - `pi/agent/workflow.json`

### 9. Commits
- `feat(workflow): judge result reminds the executor of unticked plan steps`: `plan-doc.ts`, `plan-doc.test.ts`, `index.ts`, `README.md`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `plan-doc.ts`: add `openStepsReminder` after `mergeChecklist` (`plan-doc.ts:86`), with a one-line doc comment. Its behav
- [x] S2 `index.ts`, in the `judge` tool's `execute` (`index.ts:1567-1572`):
- [x] S3 `plan-doc.test.ts`: add the tests in section 6 and add `openStepsReminder` to the import on line 3.
- [x] S4 `README.md:51`, "Step checklist" bullet: add one sentence. When `judge` runs with steps of the current stage still untic
- [x] S5 Run every test file (section 6).
## Outcome
2026-10-16T17:21:37.229Z — ok: committed (1 commit)
