<!-- pi-workflow plan v1 flow=20261023-0032-make-the-deliverhintsblock-test-check-do-345a -->
## Plan: Make the deliverHintsBlock test check done and human items

### 1. Goal and non-goals
**Goal:**
- The test "deliverHintsBlock filters by stage and skips human items" in `pi/agent/extensions/workflow/checkpoints.test.ts` fails if `deliverHintsBlock` stops skipping done items or human items. It still checks the stage filter.

**Non-goals:**
- Do not change any production code: `checkpoints.ts`, `index.ts`, `plan-doc.ts`, `prompts.ts`, the README and the docs stay as they are.
- Do not change any other test.
- Do not touch `docs/workflow-improvements.md`. This adds no backlog item and implements none; it only adds test coverage to D17, which is already done.

### 2. User decisions
- D1: Fix the remaining judge finding: add a done Deliver step and a human item to the test, and assert that the block still contains only the `S3` line.

### 3. Facts the executor needs
- `pi/agent/extensions/workflow/checkpoints.test.ts:103-110` holds the test. Its `list` has two items: `S2` (stage 1) and `S3` (stage 2). `p` is `"**S2.** Deliver: push — a\n**S3.** Deliver: pr — b"`. The assertion is `deliverHintsBlock(p, list, 2, "pr")` equal to `'Deliver steps:\n- S3 → call deliver {mode: "pr", step: "S3"}'`.
- `pi/agent/extensions/workflow/plan-doc.ts:19-21`: `isHuman(i)` returns `!!i.human || VERIFY.test(i.text)`. Setting `human: true` on an item marks it as human.
- `deliverHintsBlock(plan, checklist, stage, cap)` in `pi/agent/extensions/workflow/checkpoints.ts` lists only checklist items that are open, not human, in `stage`, and have a Deliver spec.
- Test command, run from `D:/works/pi-config/pi/agent/extensions/workflow`: `node --test checkpoints.test.ts`. The full suite is `node --test *.test.ts`, which last gave 664 pass and 0 fail and takes well under 2 minutes.
- The working branch is `flow/publish-judged-checkpoint-commits-and-re`.

### 4. Design
None. This is a test-only change.

### 5. Steps
**S1.** In `checkpoints.test.ts:103-110`, test "deliverHintsBlock filters by stage and skips human items":
- **`list`:** add two stage-2 items after `S3`:
  - a done Deliver step: `{ id: "S4", text: "Deliver: push — c", done: true, stage: 2 }`
  - an open human Deliver step: `{ id: "S5", text: "Deliver: merge — d", done: false, stage: 2, human: true }`
- **`p`:** add the matching plan lines, so that `deliverStepSpec` would find both steps if they were not filtered: `**S4.** Deliver: push — c` and `**S5.** Deliver: merge — d`, each on its own line after `S3`.
- **Assertion:** keep it unchanged. The result must still be exactly `'Deliver steps:\n- S3 → call deliver {mode: "pr", step: "S3"}'`.

**S2.** Run `node --test checkpoints.test.ts`, then `node --test *.test.ts`. Both must report 0 failures. Then call `judge`.

### 6. Tests
- **Changed test:** `checkpoints.test.ts`, "deliverHintsBlock filters by stage and skips human items".
  - Input: the four-item `list` and the four-line `p` from S1, with stage `2` and cap `"pr"`.
  - Expected: exactly `'Deliver steps:\n- S3 → call deliver {mode: "pr", step: "S3"}'`.
- **Commands:**
  - `node --test checkpoints.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^not ok"` should print `ℹ fail 0`.
  - `node --test *.test.ts 2>&1 | grep -E "^ℹ (tests|pass|fail)|^not ok"` should print `ℹ tests 664`, `ℹ pass 664` and `ℹ fail 0`. The count stays the same because no test is added.
- **Sanity check (optional, do not commit):** temporarily remove the human check, or the done check, in `deliverHintsBlock`. The changed test must then fail. Restore the code afterwards.

### 7. Done when
- The test includes a done Deliver step and a human Deliver step in stage 2, and asserts that only `S3` is listed.
- All workflow node tests pass.
- No file other than `checkpoints.test.ts` changes.

### 8. Risks, rollback and what not to touch
- **Risk:** low, since only a test changes. Rollback is reverting the one commit.
- **Do not touch:** production code, other tests, the README, `docs/workflow-improvements.md`.
- **Publishing:** do not push or open a PR by hand. The PR may fail again with "must be a collaborator"; that is outside this plan.

### 9. Commits
- `test(workflow): check that deliverHintsBlock skips done and human items` — `pi/agent/extensions/workflow/checkpoints.test.ts`

<!-- pi-workflow:status -->
## Checklist
- [x] S1 In `checkpoints.test.ts:103-110`, test "deliverHintsBlock filters by stage and skips human items":
- [x] S2 Run `node --test checkpoints.test.ts`, then `node --test *.test.ts`. Both must report 0 failures. Then call `judge`.
## Outcome
2026-10-22T17:35:38.591Z — failed: committed (1 commit), pushed, no open pull request
