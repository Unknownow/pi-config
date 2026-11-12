<!-- pi-workflow plan v1 flow=20261112-1041-manual-judge-review-of-the-discussion-s-c81b -->
## Plan: Manual judge review of the discussion's conclusion (`/flow judge` in discuss)

**Goal:** you can trigger the judge whenever you want during the discuss phase. Today, `/flow judge` in discuss only finds an empty diff. After this change it sends the discussion's conclusion (the last `Agreed so far:` list plus the session transcript) to the judge model for an adversarial review. You get findings and a PASS/FAIL. It blocks nothing; you decide when to run `/flow plan`.

**Non-goals:** no automatic trigger. No gate on `/flow plan` or approve. No change to the diff review in plan, execute or quick flows, or to the `judge` tool. No extra model turn to write a brief. Plan-phase plan review (`workflow:plan-ready`) is untouched.

### User decisions
- D1. Triggered manually only, by the user.
- D2. It reviews the discussion's final result before the hand-off to plan mode.
- D3. Recorded as backlog item A46 in `docs/workflow-improvements.md`.
- D4 (my recommendation, which the plan uses): the command is the existing `/flow judge`. In the discuss phase it reviews the discussion; in every other phase it keeps reviewing the diff. The last `Agreed so far:` list (which the discuss prompt already requires, `prompts.ts:100`) is the brief, so no separate brief-writing turn.
- D5: the result is posted into the conversation as a displayed message without starting a turn. The discuss model sees it in your next message, and so does the planner.

### Facts the executor needs
- Command dispatch: `index.ts:4261` (`case "judge": await reviewDiff(ctx, true)`). Menu label: `index.ts:3982`.
- Pattern for a role subagent: `runRole(role, label, {systemPrompts, tools, task, cwd, signal}, onChange)` at `index.ts:735`. The knowledge-check call at `index.ts:1840-1858` is a close model to follow. Its result has `.ok`, `.error`, `.text`, `.usage`. `view.finish(run, ok, summary)` closes the row.
- Verdict rule used by the judge: `/VERDICT:\s*PASS/i.test(text) && !/VERDICT:\s*FAIL/i.test(text)` (inside `judgeOnce`, around `index.ts:1933`).
- Working message pattern: `ctx.ui.setWorkingMessage(...)` with `setWorkingMessage()` in `finally` (`index.ts:3416-3421`).
- Displayed message with no turn: `pi.sendMessage({ customType, content, display: true }, { triggerTurn: false })` (`index.ts:2524`).
- Transcript serialization already exists in the agents extension: `transcript(ctx)` at `agents/index.ts:111-124`. It uses `convertToLlm` and `serializeConversation` from `@earendil-works/pi-coding-agent`, turns `custom_message` entries into user messages, and clips the middle when the text is over a limit (keeps 30% from the head).
- Judge config type and defaults: `config.ts:136-151`, `config.ts:202-211` (`maxDiffChars: 400_000`). Read-only judge tools: `cfg.judge.tools`.
- Discuss prompt: `prompts.ts:92-101`. Judge prompt format: `prompts.ts:136-159`.
- Tests: `node:test` and `node:assert/strict`, run with `node --experimental-strip-types --test`.

### Design
- **`shared/transcript.ts` (new):** moves the agents extension's transcript code here so both extensions use the same code.
  - `clipMiddle(text: string, max: number): string` is pure. It returns the text unchanged when `length <= max`. Otherwise it keeps `floor(max*0.3)` characters from the head and the rest of `max` from the tail, joined by the same `[... N characters of the middle omitted ...]` line used today.
  - `branchTranscript(branch: readonly unknown[], max: number): string` holds today's logic from `agents/index.ts:112-123`, then calls `clipMiddle`.
- **`workflow/discussion-review.ts` (new, pure):**
  - `lastAgreedList(assistantTexts: string[]): string | undefined`: searches from the newest text backwards. For the first text with a line matching `/^\s*\**Agreed so far:?\**:?/im`, it returns that text from that line to its end, trimmed. Returns `undefined` when there is none.
  - `discussionVerdict(text): "PASS" | "FAIL"`: same rule as the judge.
  - `discussionReviewPrompts(conclusion: string | undefined, transcript: string, folders: string[]): string[]` builds the system prompts:
    1. `prompts.JUDGE_DISCUSSION`
    2. `## Conclusion under review`, followed by the list, or the line "No `Agreed so far:` list yet: review the latest conclusion in the transcript."
    3. When `folders` is non-empty, `## Other folders of this session` with the folder list.
    4. `## Discussion transcript`, followed by the transcript.
- **`prompts.JUDGE_DISCUSSION`:** an adversarial reviewer in a separate session that assumes the conclusion is wrong.
  - It checks for: gaps (unhandled cases, failure modes, missing migration or compatibility), contradictions between decisions, unstated assumptions, claims about the code (it verifies them with read-only tools; same read budget as the judge, about 15 calls), scope creep or missing non-goals, missing acceptance criteria or tests, scale with no numbers, and open questions that block a plan.
  - It must not reopen choices the user explicitly made unless they are unsafe or contradict each other.
  - Output is the judge's format: `- blocker|major|minor - [gap|contradiction|assumption|fact|scope|acceptance|risk] problem`, then `Why:` (a transcript quote or file:line), then `Fix:` (what to settle in the discussion). Last line is `VERDICT: PASS|FAIL`. It is FAIL when there is any blocker or major finding. No praise.
- **Config:** new key `judge.maxDiscussionChars: number`, default `400_000`, the transcript limit. Nothing else needs it in `workflow.json`.
- **Failure handling:**
  - Subagent error: notify `workflow: discussion review failed: <error>` (error level). No message is posted.
  - Empty transcript: notify `workflow: nothing to review yet` (info).
  - No `Agreed so far:` list: run anyway, and say so in the notify.
  - It changes no judge or flow state: `judgeRounds`, `lastJudge`, `passedDiff`, `seenDiffs` and `pendingPlanFlaw` stay untouched, and nothing is persisted.
- **Scale:** one judge run per trigger. The transcript is capped at 400k characters (about 100k tokens). Beyond that the middle of the discussion is dropped, the same trade-off the advisor makes.
- **Rejected:**
  - A separate brief-writing turn by the discuss model: it costs an extra turn, and the `Agreed so far:` list is already that brief.
  - Gating `/flow plan` on a PASS: you asked for a manual check, not a gate.
  - Copying the transcript code into workflow: two copies would drift apart.

### Steps
**S1.** Create `pi/agent/extensions/shared/transcript.ts` with `clipMiddle` and `branchTranscript` as specified in Design. Move the logic out of `agents/index.ts:111-124` and keep the behaviour byte for byte. Change `agents/index.ts` so `transcript(ctx)` becomes `branchTranscript(ctx.sessionManager.getBranch(), loadConfig().config.advisor.maxTranscriptChars)`, and drop imports that are no longer used.

**S2.** Add `maxDiscussionChars: number` to the `judge` type in `workflow/config.ts:136` with a short doc comment ("transcript limit for `/flow judge` in discuss"). Add `maxDiscussionChars: 400_000` to `DEFAULTS.judge` (`config.ts:202`). Check that loading merges it like the other judge keys: a `workflow.json` without the key must give the default.

**S3.** In `workflow/prompts.ts`:
- Add `export const JUDGE_DISCUSSION` (contract in Design), next to `JUDGE` (`prompts.ts:136`). Reuse `PACE` the way `JUDGE` does.
- Change the last sentence of `DISCUSS_PHASE` (`prompts.ts:100`) so it also mentions that `/flow judge` has the judge check the conclusion first. Example ending: "...and mention that `/flow judge` has the judge check it, and `/flow plan` or "go" moves on to planning."

**S4.** Create `workflow/discussion-review.ts` with `lastAgreedList`, `discussionVerdict` and `discussionReviewPrompts` (Design).

**S5.** In `workflow/index.ts`, add `async function reviewDiscussion(ctx)`. Put it next to `reviewDiff` (`index.ts:3383`) and model it on that function.
1. Read the branch with `ctx.sessionManager.getBranch()`. Collect the text of assistant `message` entries (text parts only) in order.
2. Build the transcript with `branchTranscript(branch, cfg.judge.maxDiscussionChars)`. If it is empty, notify and return.
3. Find the conclusion with `lastAgreedList`.
4. Set the working message to `judge reviewing the discussion…`.
5. Run `runRole("judge", "discussion review", { systemPrompts: discussionReviewPrompts(conclusion, transcript, state.folders ?? []), tools: cfg.judge.tools, task: "Review the discussion's conclusion as described in your system prompt.", cwd: ctx.cwd })`.
6. On failure: notify the error and return.
7. On success: `view.finish(run, verdict === "PASS", \`${verdict} · discussion\`)`, then post `pi.sendMessage({ customType: "workflow-discussion-review", content: \`**Discussion review: ${verdict}**\n\n${text}\`, display: true }, { triggerTurn: false })`. Notify `workflow: discussion review ${verdict}` (and "(no Agreed so far: list found)" when none was found).

**S6.** Change `case "judge"` at `index.ts:4261`: when `state.phase === "discuss"`, call `reviewDiscussion(ctx)`. Otherwise keep `reviewDiff(ctx, true)`. Change the menu label at `index.ts:3982` to `judge - review the current diff now (in discuss: the discussion's conclusion)`.

**S7.** Docs:
- `workflow/README.md:350`: the `/flow judge` row gets "(in discuss: reviews the discussion's conclusion, the last `Agreed so far:` list and the transcript; findings and PASS/FAIL, blocks nothing)".
- In the "Discuss and plan phases are read-only" section (`README.md:182`), add one short paragraph saying the same thing and naming `judge.maxDiscussionChars`.
- `docs/workflow-improvements.md`:
  - New row A46 in section A, after A45 (`:75`). Problem: a discussion's conclusion goes to the planner unchecked, and the judge only sees diffs. **Done:** `/flow judge` in discuss (`discussion-review.ts`, `shared/transcript.ts`, `prompts.ts` `JUDGE_DISCUSSION`). Benefit: Medium (T). Effort: S. Risk: Low (manual, blocks nothing).
  - Add A46 to the Status line's implemented list (after A45).
  - Add an Effect measurement row after `:261`: "Plan-phase rework after a discussion review | Count `## Plan changes` replies and plan-flaw findings in flows with and without a `workflow-discussion-review` entry. Implemented, not measured yet. | Fewer plan changes and plan flaws".

### Tests
- `shared/transcript.test.ts` (new):
  - `clipMiddle` returns short text unchanged.
  - For a 1000-character text with `max` 100: the head is 30 characters, the tail is 70, and the omitted line says 900.
- `workflow/discussion-review.test.ts` (new):
  - `lastAgreedList` returns undefined when no text has the list.
  - It picks the newest of two messages that have the list, and returns from the `Agreed so far:` line to the end.
  - It also matches `**Agreed so far:**`.
  - `discussionVerdict`: "VERDICT: PASS" gives PASS; text with both PASS and FAIL gives FAIL; no verdict line gives FAIL.
  - `discussionReviewPrompts`: the first entry is `JUDGE_DISCUSSION`. With `undefined` as the conclusion, the fallback line is present. The folders section appears only when folders are given. The transcript section is last.
- `workflow/prompts.test.ts`:
  - `JUDGE_DISCUSSION` contains `VERDICT: PASS or VERDICT: FAIL` and the word `Agreed so far`.
  - `DISCUSS_PHASE` mentions `/flow judge`.
  - Adjust any existing assertion on the old `DISCUSS_PHASE` ending.
- `workflow/config.test.ts`: `DEFAULTS.judge.maxDiscussionChars === 400_000`, and loading a config file without the key gives 400000.
- Command: `node --experimental-strip-types --test pi/agent/extensions/shared/*.test.ts pi/agent/extensions/agents/*.test.ts pi/agent/extensions/workflow/*.test.ts`. Expected: all pass, 0 failures.

**S8.** Verify: start pi, run `/flow discuss`, discuss a small change until the model writes `Agreed so far:`, then run `/flow judge`. Look for: a judge row "discussion review", then a displayed **Discussion review: PASS/FAIL** message with findings in the judge format, no new assistant turn, and the phase still discuss. In plan or execute, `/flow judge` still reviews the diff.

### Done when
- `/flow judge` in discuss runs the judge model on the last `Agreed so far:` list plus the transcript and posts findings with PASS/FAIL without starting a turn or changing the phase.
- `/flow judge` in every other phase behaves exactly as before.
- The advisor's transcript is unchanged (same shared code).
- The A46 row, the Status line and the Effect measurement row are updated in the same commit as the feature.
- All tests pass.

### Risks, rollback, what not to touch
- Risk: a long session costs a full judge run (up to about 100k tokens) each time you trigger it. It is manual, so you control that.
- Risk: the S1 refactor could change the advisor's transcript. Keep the code identical, and the `clipMiddle` test pins the format.
- Don't touch `reviewDiff`, `judge()`/`judgeOnce`, the `judge` tool, the merge gates or the plan-review event.
- Rollback: revert the commits. There is no state or data migration.

### Commits
1. `shared: move the session transcript serialization to shared/transcript.ts`: `shared/transcript.ts`, `shared/transcript.test.ts`, `agents/index.ts`.
2. `workflow: /flow judge in discuss reviews the discussion's conclusion (A46)`: `workflow/discussion-review.ts`, `workflow/discussion-review.test.ts`, `workflow/prompts.ts`, `workflow/prompts.test.ts`, `workflow/config.ts`, `workflow/config.test.ts`, `workflow/index.ts`, `workflow/README.md`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create `pi/agent/extensions/shared/transcript.ts` with `clipMiddle` and `branchTranscript` as specified in Design. Move 
- [ ] S2 Add `maxDiscussionChars: number` to the `judge` type in `workflow/config.ts:136` with a short doc comment ("transcript l
- [ ] S3 In `workflow/prompts.ts`:
- [ ] S4 Create `workflow/discussion-review.ts` with `lastAgreedList`, `discussionVerdict` and `discussionReviewPrompts` (Design)
- [ ] S5 In `workflow/index.ts`, add `async function reviewDiscussion(ctx)`. Put it next to `reviewDiff` (`index.ts:3383`) and mo
- [ ] S6 Change `case "judge"` at `index.ts:4261`: when `state.phase === "discuss"`, call `reviewDiscussion(ctx)`. Otherwise keep
- [ ] S7 Docs:
## For you after the flow
- S8 Verify: start pi, run `/flow discuss`, discuss a small change until the model writes `Agreed so far:`, then run `/flow j
