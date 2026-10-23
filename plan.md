<!-- pi-workflow plan v1 flow=20261023-1850-make-stage-and-step-waits-finish-on-thei-bf8c -->
## Plan: Make stage and step waits finish on their own, and stop the Unity guard refusing `unity-packages` paths

### 1. Goal and non-goals
**Goal**
- A wait check written in backticks, whether in a stage heading `(after: …; check: …)` or a step `**S<n>.** Wait: … (check: …)`, runs as the plain command.
- The final plan is not accepted while a wait check has a placeholder (`<…>`), command substitution, or text that is not a read-only command (for example an English sentence).
- A wait that starts gets its first check about 5 s later instead of after the 120 s poll interval.
- The planning rules forbid waits on merges or publishes that an earlier stage does itself, and checks with versions that aren't known yet.
- The worktree Unity guard no longer refuses `run_code` scripts that only mention a path like `unity-packages` and words like "test" or "run".

**Non-goals**
- The `unity-packages` version-claim script that picked 2026.10.22: it lives in another repo.
- Changing the plan approval path when `finalizePlan` is off.
- Changing the poll interval, the 60-minute limit or `autoResume`.
- Fixing the running reward-ads session by hand.

### 2. User decisions
- D1: The bug to fix is that backticks around `check:` stay in the command, so the check can never pass. Remove or reject them.
- D2: Wait checks are validated when the plan is approved: no placeholders, no English sentences, and the check must be a command that can run.
- D3: A stage-start wait checks once right away instead of waiting for the first 2-minute poll.
- D4: The planning rules say: use `(after:)` / `Wait:` only for something a person does; never for a merge or publish an earlier stage does itself; never with a version a script picks later.
- D5: The worktree Unity guard is narrowed so `unity-packages` doesn't count as running the Unity CLI. This is in the same change.
- D6: Delivery: the executor commits, pushes, opens the PR and merges it after a judge pass.

### 3. Facts the executor needs
**Wait parsing**
- `pi/agent/extensions/workflow/stages.ts:11-13`: `HEADING`, `TAG` and `AFTER`. `AFTER` captures the check as `aft[2]`, and `parseStages` stores it as is at `stages.ts:39`, backticks included.
- `stages.ts` currently imports nothing from `waits.ts`. `waits.ts:3` imports only `plan-doc.ts`. Keep it that way: `waits.ts` must not import `stages.ts`.
- `waits.ts:11` `CHECK` and `waits.ts:14-31` `parseWaitStep`: the check (`c[1].trim()`) keeps its backticks.
- `waits.ts:124-133` `checkVerdict`: exit 126 or 127 is "broken", other non-zero exits are "fail".

**The wait tool and wait state**
- `index.ts:2494-2506`, `wait_for_user`: `const check = params.check?.trim() || undefined`, then `readOnlyProblem(check)`, then a first `runWaitCheck`.
- `readonly-bash.ts:289`: `readOnlyProblem(command: string, allow: RegExp[] = []): string | null`. It is imported in `index.ts:75`.
- `index.ts:1809-1833`: restores a persisted `status.waiting` and copies `status.waiting.check` as it is (`:1820`).

**Poll timer**
- `index.ts:2367-2376`: `waitTimer` (an interval), `waitTimerStart`, `waitChecking` and `stopWaitTimer()`, which only clears the interval.
- `index.ts:2381-2388`, `startWaitTimer(sinceMs?)`: returns early without a check or when the check already passed, then `setInterval(() => void waitTick(), cfg.wait.pollMs)` with `unref`.
- `index.ts:2421-2462`, `waitTick`: it holds while the session is busy or the editor has text. On a pass it clears the wait and sends the held text, or the default continue message, as a `workflow-wait` follow-up.
- `config.ts:242`: `wait: { pollMs: 120_000, maxMs: 3_600_000, checkTimeoutMs: 30_000, autoResume: true }`.
- `index.ts:3597-3607`, `holdForStageWait`: sets `state.waiting` with `atStageStart` and `held`, then calls `startWaitTimer()`.

**Final plan acceptance**
- `index.ts:670-679`, `approve()`: sets `state.finalizing = true` and sends the finalize prompt. `index.ts:3412-3420`: the same for a typed approval.
- `index.ts:620-633`, the `agent_end` handler: when `state.phase === "plan" && state.finalizing`, it sets `finalizing = false`. When the reply stopped normally and has `## Plan:`, it calls `setPhase(ctx, "execute")`, then `startExecution(ctx, finalText)`, `persist()` and `handover(...)`. Otherwise it notifies "that reply is not a final plan … Approve again to retry."

**Planning rule**
- `prompts.ts:25`, `CHECKPOINTS`: the rule text for `Wait:` and `(after: …)`. `prompts.test.ts:88` asserts it contains `(after:`.

**Unity guard**
- `pi/agent/extensions/worktree/unity-guard.ts:131-136`, `codeProblem`: `/\bunity(\.exe)?\b/` together with a word list. `unity-packages` matches because `-` counts as a word boundary.
- `worktree/unity-guard.test.ts:27-29`: the existing `codeProblem` tests. `spawn('unity',['recompile'])` must stay refused, and `const community = 1` must stay allowed.

**Tests and docs**
- `workflow/README.md:211`: the full workflow test command (`node --experimental-strip-types --test …`).
- `docs/workflow-improvements.md:5`: the Status line. The last D row is D20 (`:120`). The Effect measurement rows end at D20 (`:178`). `AGENTS.md` requires the row, the Status line and the measurement row to change in the same commit.

### 4. Design
**Components**
- `waits.ts`:
  - `cleanCheck` normalises a check string.
  - `waitCheckProblem` finds what makes a check unusable (it has no I/O).
- `stages.ts`:
  - `parseStages` stores cleaned checks.
  - New `planWaitProblems` gathers the problems in all wait checks of a plan. It lives here because it needs `parseStages`, and `waits.ts` must not import `stages.ts`.
- `index.ts`:
  - `wait_for_user` and the wait restore use `cleanCheck`.
  - Final plan acceptance calls `planWaitProblems` and asks the planner to fix the checks once.
  - `startWaitTimer` adds a one-shot first tick.
- `prompts.ts`: one new rule sentence.
- `worktree/unity-guard.ts`: a stricter `codeProblem`.

**Contracts**
```ts
// waits.ts
export function cleanCheck(s: string | undefined): string | undefined;
export function waitCheckProblem(check: string): string | null;
// stages.ts
export function planWaitProblems(plan: string, isReadOnly: (c: string) => string | null): string[];
```

`cleanCheck`:
- trims the string;
- if it starts and ends with the same run of 1 or 2 backticks and is longer than both runs together, removes that run from both ends and trims again;
- returns `undefined` for `undefined`, an empty string, or a string that is empty after cleaning;
- removes only one wrapping, and leaves inner backticks alone.

`waitCheckProblem`, checked in this order:
- `"has a placeholder"` when the check matches `/<[A-Za-z][^<>|]*>/`;
- `"uses command substitution"` when it contains a backtick or `$(`;
- otherwise `null`.

`planWaitProblems`:
- covers, in plan order:
  - every stage in `parseStages(plan)` with `after.check`, labelled `Stage <n> check`;
  - every step id found by `/\*\*(S\d+)\.?\*\*[ \t]*Wait\s*:/gi` whose `parseWaitStep(plan, id)` has a `check`, labelled `<id> check`;
- for each check, the problem is `waitCheckProblem(check) ?? isReadOnly(check)`;
- each entry reads `` `${label}: ${problem}: ${check}` ``;
- an empty array means the checks are fine;
- a plan with no stages (fewer than 2, which `parseStages` treats as unstaged) still gets its `Wait:` steps checked.

**Finalize retry**
- Add an `index.ts` closure variable `finalizeWaitRetried = false`. Reset it to `false` wherever `state.finalizing = true` is set by an approval (`:675` and `:3417`), but not by the retry itself.
- In the `:620` branch, after the reply qualifies as a final plan and before `setPhase`, compute `planWaitProblems(finalText, (c) => readOnlyProblem(c))`.
- No problems: continue exactly as today.
- Problems on the first try:
  - set `finalizeWaitRetried = true` and `state.finalizing = true`, then call `persist()`;
  - send a `workflow-finalize` follow-up with `triggerTurn: true`, `deliverAs: "followUp"` and the text below (the list is all problems, one per `- ` line);
  - return without starting execution.
- Problems on the second try:
  - notify ``workflow: the final plan still has wait checks that can't run (${problems[0]}). Approve again to retry.`` with `"warning"`;
  - call `persist()` and return without starting execution; `finalizing` stays false.

The follow-up text:

```
The final plan has wait checks that can't run:
- <problem 1>
- <problem 2>
Fix them and reply with the whole final plan again. A check is one plain read-only command: no backticks around it, no placeholders like <version>, no command substitution. If a value is only known after an earlier stage (a version a script picks), drop that check or the wait itself.
```

**First tick**
- Add a `waitFirstTimer: ReturnType<typeof setTimeout> | undefined`.
- In `startWaitTimer`, after the interval is set, also set `setTimeout(() => void waitTick(), 5_000)` and `unref` it.
- `stopWaitTimer` clears it as well.
- `waitTick` is unchanged: when the session is busy it holds, and the interval checks later.

**Compatibility**
- A persisted wait with a backticked check is cleaned on restore (`:1820`), so old sessions resume correctly after a reload.
- Plans without backticks parse the same as before.

**Failure handling**
- The model may ignore the fix request. The second failure falls back to the existing "Approve again" path, so there is no loop.
- `readOnlyProblem` refuses any check that isn't read-only. The same rule already applies to `wait_for_user`.

**Scale**
- A plan has at most a few dozen steps and 2-5 stages, and the checks are pure string work: microseconds.
- One extra wait check runs per wait start, with a 30 s timeout.

**Alternatives rejected**
- Running each check at approval time: slow, and every check fails by design until the earlier stage is done.
- Telling the planner "no backticks" without code: the planner writes Markdown and will keep using them.
- Putting `planWaitProblems` in `waits.ts`: it would create an import cycle with `stages.ts`.

**Unity guard**
- `codeProblem` refuses only when both of these hold:
  - `/(?<![\w.\/-])unity(\.exe)?(?![\w.-])/` matches;
  - `/\b(child_process|spawn|spawnSync|exec|execSync|execFile|execFileSync)\b/` matches.
- The existing word list is dropped. Spawning is what makes code drive the CLI.

### 5. Steps
**S1.** `workflow/waits.ts`: add `cleanCheck` and `waitCheckProblem` next to `CHECK` (`:11`), as specified in section 4. In `parseWaitStep` (`:26-28`), set `check = cleanCheck(c[1])`.

**S2.** `workflow/stages.ts`:
- Import `cleanCheck` and `waitCheckProblem` from `./waits.ts`, and `parseWaitStep` too.
- At `:39`, store the check as `cleanCheck(aft[2])`, keeping it only when defined.
- Add the exported `planWaitProblems` after `parseStages`, as specified in section 4.

**S3.** `workflow/index.ts`, `wait_for_user` (`:2494-2500`):
- Set `const check = cleanCheck(params.check)`.
- When `check` is set and `waitCheckProblem(check)` returns a problem, return ``reply(`The check ${problem}. Nothing changed.`)`` before the `readOnlyProblem` test.
- Add the imports to the existing `./waits.ts` import (`:78`).

**S4.** `workflow/index.ts`, wait restore (`:1820`): pass `status.waiting.check` through `cleanCheck`, and keep the key only when the result is defined.

**S5.** `workflow/index.ts`, final plan acceptance (`:620-627`): add the `finalizeWaitRetried` handling and the problem check described in "Finalize retry". Import `planWaitProblems` from `./stages.ts`, next to `parseStages`. Reset the flag at `:675` and `:3417`. Model the follow-up message on `approve()` (`:677`).

**S6.** `workflow/index.ts`, `startWaitTimer` / `stopWaitTimer` (`:2373-2388`): add the 5 s one-shot first tick and clear it in `stopWaitTimer`.

**S7.** `workflow/prompts.ts:25`, `CHECKPOINTS`: right after the sentence ending `` ends its heading in `(after: <what>; check: <command>)`. ``, insert:

> Use `Wait:` or `(after:)` only for something a person must do, never for a merge or publish that an earlier stage does itself (`publish_packages` already waits for earlier versions). Write a check as one plain read-only command: no backticks around it, no placeholders, and no version that a script picks later.

**S8.** `worktree/unity-guard.ts:131-136`, `codeProblem`: change it to the two-condition test from section 4. Keep the refusal text `refuse("code that runs the unity CLI")`.

**S9.** Add the tests from section 6 and run both suites.

**S10.** `docs/workflow-improvements.md`:
- Add row D21 after D20 (`:120`), in the same column format. Text: "Wait checks in `(after:)` headings and `Wait:` steps kept their Markdown backticks, so bash ran them as command substitution: a finished wait reported 'can't run' (exit 127), and plans with placeholder or English checks were accepted, so stages waited until the user typed. **Done:** `cleanCheck` and `waitCheckProblem` (`waits.ts`), `planWaitProblems` (`stages.ts`), a final-plan check with one retry, a 5 s first poll and cleaned checks in `wait_for_user` and the wait restore (`index.ts`), and a planning rule (`prompts.ts`)."
- Fill the remaining columns like D20's: `Medium (T) | S | Low: …`.
- Add D21 to the Status line (`:5`), in the group with D18, D19 and D20.
- Add an Effect measurement row after D20's (`:178`): `| D21 | Stage waits that never pass | Count 'wait check can't run' notices and "you continued without the check passing" resumes in flow transcripts. Implemented, not measured yet. | Zero |`.

**S11.** Deliver: merge. Commit, push, open a PR and merge it after a judge pass.

### 6. Tests
**`workflow/waits.test.ts`**
- `cleanCheck`:
  - `` "`git ls-remote x`" `` gives `"git ls-remote x"`.
  - ` "``a `b` c``" ` gives `` "a `b` c" ``.
  - `"  plain  "` gives `"plain"`.
  - `undefined`, `""` and ``"``"`` each give `undefined`.
- `waitCheckProblem`:
  - `"git ls-remote --exit-code --tags origin x/v<new set version>"` gives `"has a placeholder"`.
  - `` "a `b`" `` and `"echo $(x)"` give `"uses command substitution"`.
  - `"git -C D:/r ls-remote --exit-code --tags origin a/v1"` and `"git log 2>&1 | head"` give `null`.
- `parseWaitStep backticked check`: plan `` "**S7.** Wait: open the Editor (check: `ls x`)" `` with id `S7` gives `{ reason: "open the Editor", check: "ls x" }`.

**`workflow/stages.test.ts`**
- `parseStages strips backticks from an after check`: `` "### Stage 1: a\n### Stage 2: b (after: published; check: `git ls-remote --exit-code --tags origin p/v1`)\n" `` gives stage 2 `after.check === "git ls-remote --exit-code --tags origin p/v1"`.
- `planWaitProblems reports the reward-ads checks`: the plan has stages 1-3. Stage 2 is `` (after: Stage 1 published; check: `git -C D:/r ls-remote --exit-code --tags origin s/v<new set version>`) ``. Stage 3 is `` (after: Stage 1 published; check: the same `ls-remote` as Stage 2) ``. The stub `isReadOnly` returns `"not read-only"` for checks starting with `the` and `null` otherwise. Expected: 2 entries, the first starting `Stage 2 check: has a placeholder`, the second starting `Stage 3 check:`.
- `planWaitProblems checks Wait steps`: the plan contains `**S4.** Wait: open the Editor (check: echo $(x))`. Expected: one entry starting `S4 check: uses command substitution`.
- `planWaitProblems clean plan`: the checks are plain `git ls-remote …` commands and the stub returns null. Expected: `[]`.

**`workflow/prompts.test.ts`**
- Next to `:88`: the checkpoint rules contain `no backticks around it` and `never for a merge or publish that an earlier stage does itself`.

**`worktree/unity-guard.test.ts`** (in the `codeProblem` test)
- `codeProblem("const fs=require('fs');process.chdir('D:/w/unity-packages');/* run test */ fs.writeFileSync('a','b')")` gives `null`.
- `codeProblem("require('child_process').execSync('unity test')")` is refused (`/^Refused \(worktree\)/`).
- `codeProblem("spawn('unity.exe',['recompile'])")` is refused.
- The existing `spawn('unity',['recompile'])` case is still refused and `const community = 1` is still `null`.

**Commands** (both are fast)
- From `pi/agent/extensions/workflow`: the full command in `README.md:211`. Expected: all tests pass, 0 failures.
- From `pi/agent/extensions/worktree`: `node --experimental-strip-types --test unity-guard.test.ts`. Expected: all pass.

### 7. Done when
- A backticked check in an `(after:)` heading, in a `Wait:` step or in a `wait_for_user` call runs as the plain command. A persisted backticked check is cleaned on restore.
- A final plan whose wait checks have placeholders, command substitution or text that isn't a read-only command is not started. The planner is asked once to fix them; a second failure falls back to "Approve again".
- A new wait checks about 5 s after it starts, then every `pollMs`.
- The planning rule forbids waits on an earlier stage's own merge or publish, and checks with backticks, placeholders or versions not known yet.
- The Unity guard allows `run_code` that only mentions `unity-packages`, and still refuses code that spawns `unity`.
- Both test suites pass.
- `docs/workflow-improvements.md` has D21 in its row, the Status line and the measurement table.
- The PR is merged after a judge pass.

### 8. Risks, rollback, what not to touch
**Risks**
- `readOnlyProblem` could refuse a check that was fine before, for example one with redirects. This only affects plans with such checks, and the planner gets one retry. `wait_for_user` already uses the same rule.
- The first tick runs while the executor's turn is still ending. `waitTick` holds while the session is busy, so nothing breaks.

**Rollback**
- Revert the single commit.

**Don't touch**
- The `checkVerdict` classification.
- `pollMs`, `maxMs` and `autoResume`.
- The non-finalize approval path.
- The installed copy under `~/.pi/agent/extensions`.
- `unity-guard.ts` `unityProblem` (the bash path).
- Any other repo.

### 9. Commits
1. `fix(workflow): wait checks run without backticks and are validated at plan approval; unity guard ignores unity-packages paths`
   - `pi/agent/extensions/workflow/waits.ts`, `waits.test.ts`
   - `pi/agent/extensions/workflow/stages.ts`, `stages.test.ts`
   - `pi/agent/extensions/workflow/index.ts`
   - `pi/agent/extensions/workflow/prompts.ts`, `prompts.test.ts`
   - `pi/agent/extensions/worktree/unity-guard.ts`, `unity-guard.test.ts`
   - `docs/workflow-improvements.md`

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 `workflow/waits.ts`: add `cleanCheck` and `waitCheckProblem` next to `CHECK` (`:11`), as specified in section 4. In `par
- [ ] S2 `workflow/stages.ts`:
- [ ] S3 `workflow/index.ts`, `wait_for_user` (`:2494-2500`):
- [ ] S4 `workflow/index.ts`, wait restore (`:1820`): pass `status.waiting.check` through `cleanCheck`, and keep the key only whe
- [ ] S5 `workflow/index.ts`, final plan acceptance (`:620-627`): add the `finalizeWaitRetried` handling and the problem check de
- [ ] S6 `workflow/index.ts`, `startWaitTimer` / `stopWaitTimer` (`:2373-2388`): add the 5 s one-shot first tick and clear it in 
- [ ] S7 `workflow/prompts.ts:25`, `CHECKPOINTS`: right after the sentence ending `` ends its heading in `(after: <what>; check: 
- [ ] S8 `worktree/unity-guard.ts:131-136`, `codeProblem`: change it to the two-condition test from section 4. Keep the refusal t
- [ ] S9 Add the tests from section 6 and run both suites.
- [ ] S10 `docs/workflow-improvements.md`:
- [ ] S11 Deliver: merge. Commit, push, open a PR and merge it after a judge pass.
