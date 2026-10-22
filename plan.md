<!-- pi-workflow plan v1 flow=20261023-0250-skip-a-repeated-final-full-review-after-3223 -->
## Plan: Skip a repeated final full review after a passing one

### 1. Goal and non-goals
**Goal:**
- Today, a passing judge re-review triggers a final full review of the whole diff. The rule is in `judge()`, `pi/agent/extensions/workflow/index.ts:1008-1012`.
- Skip that final full review when two things hold:
  - a full review has already passed in this stage;
  - the change since that pass is at most `judge.finalFullReviewRepeatMaxShare` of the whole diff.
- Example: a 129-file stage ran a second full review costing about 1.7M tokens and about 2 minutes, right after a full review had passed on the same files. This change avoids such repeats.

**Non-goals:**
- No special rule for test or changelog files.
- No change to `reviewPlan` (`index.ts:964-990`). It decides between a full review, a re-review and "same".
- No change to `needsFinalFullReview` or `finalFullReviewNewFilesOnly`.
- No change to the judge prompts or the knowledge check.
- No push, pull request or merge.

### 2. User decisions
- **D1:** New config key `judge.finalFullReviewRepeatMaxShare`, a number, default `0.1`. The final full review is skipped when the change since the last passing full review is at most this share of the whole diff, both measured in diff characters. `0` never skips, which is today's behaviour.
- **D2:** Only a passing full review from the current stage counts. It also needs the same base and the same HEAD in every repo as now. Any failing full review clears the record.
- **D3:** When the review is skipped, the re-review's result text gets one extra line:
  `Final full review skipped: a full review passed this stage and the changes since are <p>% of the diff.`
  `<p>` is a whole number, rounded.
- **D4:** One commit, no push.
- **D5:** No rule by file kind (tests or changelogs).

### 3. Facts the executor needs
All paths are relative to `pi/agent/extensions/workflow/`.

**The judge flow in `index.ts`:**
- `judge()` (`index.ts:997-1017`):
  1. It calls `reviewPlan`, then `judgeOnce`.
  2. At `:1008-1012` it runs the final full review when all of these hold: the verdict is PASS, `plan.kind === "recheck"`, `limit > 0`, `diff.chars > limit`, and `needsFinalFullReview(...)` returns true.
  3. The final review is `judgeOnce(ctx, diff, focus, { kind: "full", snaps: plan.snaps }, …)`.
  4. Its usage is added to the re-review's usage.
- `judgeOnce` (`index.ts:1725`):
  - It receives `plan: Exclude<ReviewPlan, {kind:"same"}>` and sets `const recheck = plan.kind === "recheck"` at `:1734`.
  - At `:1797` it stores `state.lastJudge = plan.snaps ? { hash, repos: plan.snaps, base: diff.base, verdict, text } : undefined`.
- `hasPlanFlaw(r.text)` is used at `:1015`. A PASS that raises a plan flaw is not yet a pass.

**State and snapshots:**
- `type Snaps = Record<string, { tree: string; head: string }>` (`index.ts:246`). Its keys are `repoKey(root)`.
- The state field `lastJudge?: LastJudge` is at `index.ts:125`, inside the persisted state interface.
- `state.lastJudge = undefined` is reset at:
  - `:1960`, a new round;
  - `:2665`, after the workflow's commit;
  - `:3247`, a new stage.

**Git helpers:**
- Tree-to-tree diff per repo: `git(r.dir, "diff", "--no-color", before[k].tree, snaps[k].tree)` (`index.ts:974-977`), over `diff.repos`. Each `r` has `.dir` and `.root`.
- `git(cwd, ...args)` (`index.ts:782`) returns `{ stdout, code, … }`.
- `diff.chars` is the length of the whole diff, untruncated. `diff.base` is the base ref.

**Config:**
- The judge config type is at `config.ts:192-204`. Its keys include `recheckMaxShare`, `finalFullReviewOverChars` and `finalFullReviewNewFilesOnly`, each with a `/** … */` comment.
- The defaults are at `config.ts:276-284`.
- `pi/agent/workflow.json` sets only `tools` and `maxDiffChars` for `judge`. It needs no change.

**Pure helpers and tests:**
- `needsFinalFullReview` is at `repo-diff.ts:36-39`, with a one-line doc comment. Its test is at `repo-diff.test.ts:158-164`.
- `config.test.ts` imports `DEFAULTS` (`:16`) and checks defaults, for example at `:71-79`.

**Docs:**
- `README.md:95-103` describes the re-review and final-full-review rules.
- In `docs/workflow-improvements.md`:
  - Status line is at `:5`.
  - B1 is at `:69`, and B13 (the last B row) at `:81`.
  - The "Effect measurement" table starts at `:117`. Its B rows are at `:138-148`, and B12/B13 are at `:196-197`.
  - The next free ID is **B14**.

**Tests and environment:**
- Test command, run from `pi/agent/extensions/workflow`: `node --experimental-strip-types --test <file>.test.ts`. Last full run: 612/612 pass.
- Environment: Windows with bash, `cd /d/works/wt/reduce-context/pi-config`. There is no Python.
- Prefer the `edit` tool for edits. Don't use `sed` on lines that contain backslashes.

### 4. Design
**Components:**
1. **State:** a new optional field `lastFullPass?: { repos: Snaps; base: string }`. It records the snapshots of the latest full review that passed in this stage. It is optional, so older saved state still loads; a missing field means "no recorded pass".
2. **A pure decision function** in `repo-diff.ts`:
   ```ts
   export function shouldSkipRepeatFullReview(sinceChars: number, diffChars: number, maxShare: number): boolean
   ```
   It returns `maxShare > 0 && sinceChars <= diffChars * maxShare`.
3. **A config key:**
   ```ts
   finalFullReviewRepeatMaxShare: number; // default 0.1
   ```
4. **The skip logic in `judge()`**, placed before the final full review runs.

**When the record is set and cleared:**
- Set it in `judgeOnce`, next to `:1797`, when all of these hold: `plan.kind === "full"`, `plan.snaps` is non-null, the verdict is PASS, and `!hasPlanFlaw(text)`. Set it to `{ repos: plan.snaps, base: diff.base }`.
- Clear it (`undefined`) in these cases:
  - after a full review that does not meet that condition (FAIL, plan flaw, or no snaps);
  - at `:1960`, `:2665` and `:3247`, together with `lastJudge`.
- A re-review never sets or clears it.

**The skip check, inside the existing final-full-review condition and before calling `judgeOnce` for the final review:**
1. The recorded pass is usable only when all of these hold:
   - `lastFullPass` exists;
   - `lastFullPass.base === diff.base`;
   - its repo keys are exactly the keys of `plan.snaps`;
   - every key has the same `head` in both.
2. If it is usable, compute `sinceChars`: for each repo in `diff.repos`, take the length of the stdout of `git diff --no-color <lastFullPass tree> <plan.snaps tree>`, and sum these lengths.
3. If any of those git calls exits non-zero, don't skip.
4. If `shouldSkipRepeatFullReview(sinceChars, diff.chars, cfg.judge.finalFullReviewRepeatMaxShare)` is true:
   - Don't run the final review.
   - Keep `r`, the re-review result. Append `\n\n` and the D3 line, with `<p>` = `Math.round(100 * sinceChars / diff.chars)`.
5. Otherwise run the final full review exactly as today.

**Failure handling:** an unusable record or a git error means no skip. The fallback is always today's behaviour.

**Scale:** this adds one `git diff` between two trees per repo, and only when a final full review would otherwise run. That is a few milliseconds even on 100+ file diffs.

**Rejected alternatives:**
- A rule by file path (tests or changelogs): rejected because it is brittle (D5).
- Measuring the share against the change since the last re-review instead of since the last pass: rejected, because small fixes add up across rounds. The share must be measured from the last full pass.

### 5. Steps
**S1.** Config, in `config.ts:192-204` and `:276-284`.
- Add `finalFullReviewRepeatMaxShare: number` to the judge config type. Give it a doc comment: skip the final full review when the changes since the last passing full review of this stage are at most this share of the whole diff; 0 never skips.
- Add the default `finalFullReviewRepeatMaxShare: 0.1`.
- Model it on `recheckMaxShare`.

**S2.** Add `shouldSkipRepeatFullReview(sinceChars, diffChars, maxShare)` to `repo-diff.ts`, right after `needsFinalFullReview` (`:36-39`).
- Give it a one-line doc comment in the same style.
- Its contract is in §4.

**S3.** In `index.ts`:
- Add `lastFullPass?: { repos: Snaps; base: string };` to the state interface next to `lastJudge` (`:125`), with a doc comment: the last full review that passed in this stage.
- In `judgeOnce` next to `:1797`, set or clear it per §4.
- Clear it at `:1960`, `:2665` and `:3247`.

**S4.** In `judge()` (`index.ts:1008-1012`):
- Add the skip check from §4 inside the existing final-full-review condition.
- Import `shouldSkipRepeatFullReview` in the existing `./repo-diff.ts` import line (`index.ts:60`).
- Use the per-repo git diff pattern at `:974-977`.
- When it skips, the returned `r` keeps the re-review's verdict and usage, and its text gets the D3 line.
- `markPassed` at `:1015` behaves as before.

**S5.** Docs:
- `README.md:99-102`: after the sentence about the final full review, add one sentence. It says the final full review is skipped when a full review already passed in this stage and the changes since are at most `judge.finalFullReviewRepeatMaxShare` (10%) of the whole diff, and that `0` turns the skip off.
- `docs/workflow-improvements.md`:
  - Add a row **B14** after B13 (`:81`). Use the same column layout as B1:
    - **Idea:** after a passing re-review, the final full review repeated a full review that had just passed (129 files, about 1.7M tokens). Skip it when a full review already passed in this stage and the change since is small.
    - **Done:** `shouldSkipRepeatFullReview` in `repo-diff.ts`, `lastFullPass` in `index.ts`, `judge.finalFullReviewRepeatMaxShare` (default 0.1, 0 = off).
    - **Rating:** High (K, T).
    - **Size:** S.
    - **Risk:** Medium. A fix of up to 10% goes without a whole-change review.
    - **Measure:** count skipped final reviews.
  - Add B14 to the Status line, for example by changing "A26, A27, A28, A32 and D18 are implemented" to "A26, A27, A28, A32, B14 and D18 are implemented".
  - Add an Effect measurement row for B14 after B13 (`:197`):
    - **What:** full reviews per stage and judge tokens per flow.
    - **How:** the judge events in `metrics.jsonl`.
    - **Target:** fewer repeated full reviews of large stages, and no defect missed that the repeated review would have caught. Implemented, not measured yet.

**S6.** Run the tests in §6. Then call `judge` with the focus "Skip a repeated final full review after a passing one". Fix any blocker or major finding.

**S7.** Deliver: commit — the files in §9, no push.

### 6. Tests
**`repo-diff.test.ts`**, test `"shouldSkipRepeatFullReview follows the share"`:

| Call | Expected |
|---|---|
| `(100, 1000, 0)` | `false` (0 never skips) |
| `(100, 1000, 0.1)` | `true` (at the limit) |
| `(101, 1000, 0.1)` | `false` |
| `(0, 1000, 0.1)` | `true` |

**`config.test.ts`**, test `"finalFullReviewRepeatMaxShare defaults to 0.1"`: `DEFAULTS.judge.finalFullReviewRepeatMaxShare === 0.1`.

**Commands**, from `pi/agent/extensions/workflow`:
- While fixing: `node --experimental-strip-types --test repo-diff.test.ts config.test.ts`. Expected: all pass.
- Once before the judge: the full workflow suite, `node --experimental-strip-types --test *.test.ts`. Expected: 614 tests (612 plus 2), 0 fail.

### 7. Done when
- A passing re-review skips the final full review when a full review passed in this stage, with the same base and heads, and the change since is at most `finalFullReviewRepeatMaxShare` of the diff. The result text carries the D3 line.
- With the key set to `0`, or with no usable recorded pass, the behaviour is exactly as before.
- The README and the backlog are updated: row B14, the Status line, and the Effect measurement row.
- The workflow suite passes.
- The judge passes.
- One commit is made, with no push.

### 8. Risks, rollback, what not to touch
**Risks:**
- A fix of up to 10% of the diff no longer gets a whole-change review. The re-review still sees the fix, the earlier findings and every file name. The key set to `0` restores the old behaviour.
- `lastFullPass` is cleared in exactly the three places `lastJudge` is. A missed clear could carry a pass into the next stage, but the same-base and same-heads check still guards against that.

**Rollback:** revert the commit, or set `"judge": { "finalFullReviewRepeatMaxShare": 0 }` in `workflow.json`.

**Do not touch:**
- `reviewPlan`.
- `needsFinalFullReview` and `uncitedFiles`.
- The judge prompts and the knowledge check.
- The sandbox and worktree extensions.

### 9. Commits
- `feat(workflow): skip a repeated final full review after a passing one`. Files:
  - `pi/agent/extensions/workflow/config.ts`
  - `pi/agent/extensions/workflow/config.test.ts`
  - `pi/agent/extensions/workflow/repo-diff.ts`
  - `pi/agent/extensions/workflow/repo-diff.test.ts`
  - `pi/agent/extensions/workflow/index.ts`
  - `pi/agent/extensions/workflow/README.md`
  - `docs/workflow-improvements.md`

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Config, in `config.ts:192-204` and `:276-284`.
- [ ] S2 Add `shouldSkipRepeatFullReview(sinceChars, diffChars, maxShare)` to `repo-diff.ts`, right after `needsFinalFullReview` 
- [ ] S3 In `index.ts`:
- [ ] S4 In `judge()` (`index.ts:1008-1012`):
- [ ] S5 Docs:
- [ ] S6 Run the tests in §6. Then call `judge` with the focus "Skip a repeated final full review after a passing one". Fix any b
- [ ] S7 Deliver: commit — the files in §9, no push.
