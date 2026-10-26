<!-- pi-workflow plan v1 flow=20261026-1219-show-the-visualizer-s-commit-stage-only-41ee -->
## Plan: Show the visualizer's commit stage only when git_task ran

**1. Goal and non-goals**
- Goal: there is no commit phase any more, so the workflow visualizer must stop showing `commit` as one.
  - The `commit` stage appears only while `git_task` runs or when `git_task` has spent tokens.
  - This applies to the live flow line, the end-of-flow card and the `/flow status` tokens line.
  - The README diagram and the `view.ts` header comment stop showing a commit phase after judge.
  - The backlog doc records this as D22.
- Non-goals:
  - No change to the `Stage` type, `STAGES`, `emptyStageTokens`, `emptyFlowUsage`, or any persisted key.
  - No change to `git_task` behaviour or to how its tokens are attributed.
  - No rename of the label.
  - No change to how phases work.

**2. User decisions**
- D1: Keep `commit` as a token bucket (stored key `commit`), for compatibility with `state.tokens`, `status.json` and flow-report `stages`.
- D2: Display `commit` the way `discuss` and `test` are displayed: only when it is the active stage or has non-zero tokens.
- D3: Keep the label `commit`; no rename to `git`.
- D4: Fix the README diagram and the `view.ts` header comment so they no longer show a commit phase.
- D5: Record the finding in `docs/workflow-improvements.md` as a new row, marked done, in the same commit.

**3. Facts**
- `pi/agent/extensions/workflow/view.ts:28`: `Stage` includes `"commit"`. `view.ts:81`: `STAGES = ["discuss", "plan", "test", "execute", "judge", "commit"]`. Both stay as they are.
- `view.ts:6`: the header comment's example line ends `▸ judge … ▸ commit · Σ …`.
- `view.ts:239-243` (`summaryLines`): `rows = STAGES.filter((st) => (st !== "test" && st !== "discuss") || !isZero(stageTokens(st)))`, with the comment "The discuss and test rows show only for flows that used them." `total` (line 241) sums all stages.
- `view.ts:549-575` (`FlowView.render`): `discussNode` and `testNode` (lines 568-569) are conditional on `this.stage === X || !isZero(this.stageTokens(X))` and carry a trailing `sep`. Line 574 always appends `${sep}${node("commit", null)}` after the judge node. `total` (line 567) sums all stages.
- `view.ts:500`: `sessionTokens(stage)` gives the session's tokens per stage.
- `index.ts:4273` (`/flow status`): `tokens    ${STAGES.map(...)…join(" · ")} · session total …`. It lists every stage, including zero ones.
- `index.ts:2692` and `index.ts:2707`: `git_task` sets `view.stage = "commit"` while it runs, then restores the previous stage. This is the only setter of `"commit"`.
- `README.md:8`: the diagram line ends `-> judge (Opus 5.5) -> commit (subagent, Sonnet 5.5 low)`. `README.md:28` already describes `git_task` correctly. `README.md:47` says that on PASS the executor commits, pushes, opens the PR and merges.
- `view.test.ts`:
  - It loads `view.ts` through the `registerHooks` stubs (lines 1-15) and uses the theme stub `theme = { fg: (_c, s) => s, bold: (s) => s }` (line 39) and `roles` (line 40).
  - `new FlowView(roles)` is used with a dynamic import (lines 45-46).
  - The existing old-summary tests (lines 17 and 101) pass `commit: stage(0)`.
- `docs/workflow-improvements.md`:
  - The rules are at line 7 and following.
  - The Status line is line 5.
  - Section "D. Robustness and maintainability" starts at line 97, and its last item is D21.
  - "Effect measurement" is at line 123; its rows look like `| B14 | <metric> | <how> | <target> |`.

**4. Design**
None: this is a display-only change within existing functions, with no new components or data.

**5. Steps**

**S1.** `view.ts`, `FlowView.render` (`view.ts:549-575`): draw the commit node only when it is used.
- Add a `commitNode` next to `testNode` (model it on `view.ts:569`). It is non-empty only when `this.stage === "commit"` or `this.stageTokens("commit")` is non-zero.
- Because commit is the last node, the separator goes before it (`${sep}${node("commit", null)}`), not after.
- Line 574 then ends `…${node("judge", "judge")}${commitNode}` followed by the `Σ` part, which is unchanged.
- Edge cases:
  - With no commit usage the line ends at the judge node, with no trailing ` ▸ `.
  - While `git_task` runs (stage `commit`) the node shows as active, `● COMMIT`, even before any tokens arrive.
- Leave `total` unchanged.

**S2.** `view.ts`, `summaryLines` (`view.ts:242-243`): hide a zero commit row on the end-of-flow card.
- Extend the row filter so that `commit`, like `test` and `discuss`, is kept only when its tokens are non-zero.
- Update the comment to name commit as well, for example: "The discuss, test and commit rows show only for flows that used them."
- `total` and the per-model part are unchanged.
- Old summaries that have `commit` with tokens still show the row.

**S3.** `view.ts:6`, header comment: remove ` ▸ commit` from the example line so it ends `▸ judge opus-5-5·high 90,004 (21,300) · Σ …`.
- Also check the end-of-flow card example around `view.ts:233-237`. If it shows a `commit` row, it may stay as an example of a flow that used `git_task`; don't remove it.

**S4.** `index.ts:4273`, `/flow status` tokens line: leave out zero optional stages.
- List a stage when it is not one of `discuss`, `test`, `commit`, or when its `view.sessionTokens(s)` is non-zero. So `plan`, `execute` and `judge` always appear.
- The `session total` still sums all of `STAGES`, as now.

**S5.** `README.md:8`: change the diagram's main line so it ends at judge. For example `… -> judge (Opus 5.5) -> PASS: executor delivers (commit, push, PR, merge; git_task helper optional)`, or simply end it at `judge (Opus 5.5)`.
- Keep the alignment of the `^`/`|` lines beneath it readable. They point at the `execute` and `judge` columns, so don't shift text before those columns.
- No other README edits.

**S6.** `view.test.ts`: add the tests in section 6. Model them on the `FlowView` tests at `view.test.ts:44-60`.

**S7.** `docs/workflow-improvements.md`: record D22 (follow the rules at line 7 and following).
- Add row D22 after D21 in section D, in that table's column format.
  - Text: "The visualizer still drew the removed commit step as a pipeline stage after judge (flow line, end-of-flow card, `/flow status`)."
  - Note: **Done:** `commit` shows only when `git_task` ran; files `view.ts`, `index.ts`, `README.md`.
  - Ratings in the table's style: Low, S, Low risk, None.
- Status line (line 5): add D22 to the implemented items, for example "…, D18, D19, D20, D21 and D22 are implemented".
- Effect measurement: add `| D22 | commit node in flows without git_task | Look at the flow line and the end-of-flow card. Display only, not measured. | No commit node or row unless git_task ran |`.

**6. Tests**
Add these to `pi/agent/extensions/workflow/view.test.ts`. For the flow line, render through `(v as any).render(theme)` and take the line that starts with `flow`.
- `"flow line hides the commit node when git_task did not run"`
  - Input: `new FlowView(roles)`, `v.phase = "execute"`, `v.stage = "execute"`.
  - Expected: the flow line contains `judge`, does not contain `commit` (case-insensitive), and does not end with `▸` after trimming.
- `"flow line shows the commit node while git_task runs or after it spent tokens"`
  - Input (a): `v.phase = "execute"`, `v.stage = "commit"`. Expected: the line contains `COMMIT`.
  - Input (b): a fresh view with `v.stage = "commit"`, a `mainUsage` call to add tokens (as at `view.test.ts:48`), then `v.stage = "execute"`. Expected: the line contains `commit`.
  - If adding tokens through `mainUsage` doesn't attribute them to `commit` in this API, use any existing public path that does, and say which one was used.
- `"summary card hides a zero commit row and keeps a used one"`
  - Input: the `stage()` helper from line 102, with `commit: stage(0)`. Expected: no line whose trimmed text starts with `commit`.
  - Input: `commit: stage(7)`. Expected: such a line exists.
- The existing tests at `view.test.ts:17` and `view.test.ts:101` must still pass unchanged.

Commands, from `pi/agent/extensions/workflow` (fast, under 2 minutes):
- `node --experimental-strip-types --test view.test.ts`: all pass.
- `node --experimental-strip-types --test *.test.ts`: all pass, 0 failures.

**7. Done when**
- A flow that never calls `git_task` shows no `commit` node on the flow line, no `commit` row on the end-of-flow card, and no zero `commit` entry in `/flow status`.
- While `git_task` runs, the flow line shows `● COMMIT`. Its tokens are still counted under `commit` and shown wherever that stage has tokens.
- Persisted keys and types are unchanged, and old summaries still render.
- `README.md:8` and the `view.ts` header no longer show a commit phase after judge.
- D22 is in `docs/workflow-improvements.md` (row, Status line, Effect measurement), in the same commit.
- All workflow tests pass.

**8. Risks, rollback, what not to touch**
- Risk is low because the change is display-only.
- A trailing separator left behind is the main visual bug to avoid; the tests check for it.
- Rollback: revert the single commit.
- Don't touch:
  - `Stage`, `STAGES`, `emptyStageTokens`, `emptyFlowUsage`, `SubRole`.
  - Persistence in `plan-doc.ts` and the `state.tokens` handling.
  - `git_task` (`index.ts:2650-2720`).
  - The `total`/`Σ` sums.

**9. Commits**
- `fix(workflow): show the commit stage only when git_task ran`: `pi/agent/extensions/workflow/view.ts`, `pi/agent/extensions/workflow/index.ts`, `pi/agent/extensions/workflow/view.test.ts`, `pi/agent/extensions/workflow/README.md`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `view.ts`, `FlowView.render` (`view.ts:549-575`): draw the commit node only when it is used.
- [x] S2 `view.ts`, `summaryLines` (`view.ts:242-243`): hide a zero commit row on the end-of-flow card.
- [x] S3 `view.ts:6`, header comment: remove ` ▸ commit` from the example line so it ends `▸ judge opus-5-5·high 90,004 (21,300) 
- [x] S4 `index.ts:4273`, `/flow status` tokens line: leave out zero optional stages.
- [x] S5 `README.md:8`: change the diagram's main line so it ends at judge. For example `… -> judge (Opus 5.5) -> PASS: executor 
- [x] S6 `view.test.ts`: add the tests in section 6. Model them on the `FlowView` tests at `view.test.ts:44-60`.
- [x] S7 `docs/workflow-improvements.md`: record D22 (follow the rules at line 7 and following).
## Outcome
2026-10-26T05:21:20.472Z — ok: flow/show-commit-stage-only-when-used, 1 commit since the review base
