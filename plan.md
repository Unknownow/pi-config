<!-- pi-workflow plan v1 flow=20261021-1204-test-and-fix-workflow-strong-supervisor-e37a -->
## Plan: Test-and-fix workflow (strong supervisor, Haiku runners, automatic fix loop)

### 1. Goal and non-goals

**Goal.** Add a test-and-fix flow to the workflow extension.

- A strong supervisor runs in the main session's new `test` phase. It plans tests, sends test tasks to cheap `runner` subagents, triages their results and writes a structured test report.
- The report then drives an automatic loop: fix round on the execute model → judge (with arbiter) → commit → retest by the supervisor. The loop repeats until the scope is clean.
- The user is asked only in the defined crucial cases, batched at the end of a round.

**Non-goals.**
- iOS device testing. No Xcode toolchain here; the design must not block it later.
- Forwarding MCP servers to runners (no `runnerMcpServers`).
- `/flow resume` of test flows. They are refused.
- Changes to the worktree extension.
- Headless (no-UI) operation of the loop. Like the execute loop, it needs a UI.
- Changes to normal plan → execute flows beyond the shared refactors named in the steps.

### 2. User decisions

- **D1.** A new test-and-fix flow, separate from the implementation flow. Fixes are automatic. The user is asked only when it is crucial.
- **D2.** Keep the judge for fix rounds. Add a test-flow judge addendum: no weakened or rewritten tests or expected values; the regression test fails without the fix; fix the root cause, not a special case for the repro input.
- **D3.** Keep the arbiter. In test flows its ASK_USER does not open a blocking menu: the item becomes a batched question and the round carries on.
- **D4.** Explore and advisor stay unchanged, available on demand.
- **D5.** The supervisor is a strong model in the main session. Running tests and reporting back is done by `runner` subagents on Haiku.
- **D6.** Supervisor role `test` = Opus 5.5, thinking **medium**.
- **D7.** Runners run in parallel by default, ordered by `resource`, with an option to change it: `test.concurrency`, default 4; `1` = one at a time.
- **D8.** Unity is driven through the `unity` CLI, not MCP. Testing on devices is also needed.
- **D9.** Test flows commit after each fix round, without the delivery menu.
- **D10.** Runner results are claims. The workflow attaches the commands actually run, from the subagent's tool calls, and marks unverified passes.
- **D11.** The supervisor gets the plan phase's read-only tool policy plus `test_run`. Runners get no `edit`/`write`.
- **D12.** Tags `[bug]`, `[ask]`, `[blocked]`, `[manual]`, plus `[fixed]` in retests. `[manual]` asks the user to do steps on the device and type what they saw.
- **D13.** A bug that fails again after its fix: the next fix round runs escalated; after `test.refails` (2) failed fixes the user is asked.
- **D14.** Delivered in two stages:
  1. supervisor, runners and report;
  2. the automatic fix loop.

### 3. Facts the executor needs

Line numbers are at commit `d84af74`.

**`pi/agent/extensions/workflow/index.ts`**
- `:97` `type Phase = "off" | "plan" | "execute"`. `:99-178` `FlowState`, persisted by `persist()` `:310`.
- `:184-186` `APPROVED`, `APPROVED_FINAL`, `FIX_MESSAGE`. `:299` `--flow` flag. `:2879` the flag is accepted only for `plan|execute|off`.
- Lifecycle:
  - `:330` `summarizeFlow`
  - `:358` `endFlow`: `returnToPlan` via `phaseAfterFlow`
  - `:383` `emitStatus`: contract K4
  - `:401` `applyRole`
- `:417-428` `blockPlanTools` / `restorePlanTools`. `:430-465` `setPhase`: it summarizes and records "abandoned" when leaving `execute` with an approved plan, and resets per-flow fields.
- `:473` `startExecution`. `:569-598` `runRole`: timeout comes from `cfg.subagent.timeoutMs` at `:587`; `extensions` and `env` options exist.
- `:1385-1408` `judgeOnce`: system prompts are assembled at `:1400-1408`. `:1490-1534` the `explore` tool: the model for `test_run` (`mapLimit`, `toolProgress`, `renderRuns`).
- `:1537` `plan_check`: execute only. `:1612` `judge` tool.
- Hooks:
  - `:1660-1690` `before_agent_start`: `prompts.phaseSection` goes into `sections.workflow`
  - `:1692-1736` `tool_call`: the push guard for `execute`, the read-only checks for `plan`
  - `:1917` `input`: typed approval
- `:1959` `handover(customType, content)`: compaction plus plan card.
- `:1983` `onAgentEnd`:
  - `:2004` finalizing
  - `:2019` `if (!ctx.hasUI) return;`
  - `:2022` plan branch
  - `:2050` execute branch with `skipJudge` and the Retry menu
- `:2104` `startNextStage`: the model for round switches. `:2165-2205` `summarizeCommit`: where a stage advances or the flow ends.
- Review and plan flaws:
  - `:2263` `reviewDiff`: the no-diff branch is at `:2270`
  - `:2347` `fixOrAsk`
  - `:2375` `resolvePlanFlaw`
  - `:2415` `notePlanFlaws`
  - `:2443` `runArbiter`
- Delivery:
  - `:2524` `summarizePass`: a pass with nothing committed ends the flow
  - `:2586` `finishPassed`
  - `:2729-2766` `commitInSubagent`: how a subagent-only guard extension is passed (`env` + `extensions`); path constant at `:195`
- `:1429`, `:1455`, `:2770` set `view.stage = state.phase === "plan" ? "plan" : "execute"`.
- `:2837-2890` `session_start`: restores state; `:2864` `if (state.phase === "plan") blockPlanTools()`. `:2892` K2 switch guard. `:2924` `statusText`. `:3062` the `/flow` subcommand switch. `:1166` `resumeFlow`. `:959-1000` `writePlan`, which builds `PlanStatus` at `:970`.

**`pi/agent/extensions/workflow/config.ts`**
- `:17` `ROLES`. `:155` `DEFAULTS`. `:147-153` `subagent`. `:238-272` `loadConfig`: merge plus per-key validation, the pattern for the new `test` block.

**`pi/agent/extensions/workflow/view.ts`**
- `:27` `Stage`, `:28` `SubRole`, `:49` `STAGES`, `:63` `emptyStageTokens`, `:78` `emptyFlowUsage`.
- Restore merges with the empties (`index.ts:2859-2860`), so a new stage key is backward compatible.

**Read-only checks**
- `readonly-tools.ts:31` `planToolRefused`, `:206` `planToolProblem` (shell text gets the `allow` regexes).
- `readonly-bash.ts:17` `ParsedCommand { words, writes, env }`, `:248` `parseCommands`, `:289` `readOnlyProblem`, `:297` `commandProblem` (not exported). `parseCommands`, `KEYWORDS` and `WRAPPERS` are contract K5: don't change them.

**`subagent.ts`**
- `:19` `RunOptions`, `:45` `ToolCall { name, args, isError?, result? }` (result is the first 4000 characters), `:58` `RunResult.toolCalls`, `:306` `mapLimit`.

**`commit-guard.ts:1-40`**
- The subagent-only guard pattern: an env spec parsed defensively. It imports `shellProblem` and `repoKey`.

**`plan-doc.ts`**
- `:22` `SECTION`: numbered section names Goal, User decisions, Facts, Design, Steps, Tests, Done when, Risks, Commits.
- `:23` `AMENDMENT = /^## (?:Amendment \d+|Plan choices upheld)/`. `:24` step `ITEM`.
- `:139` `PlanStatus`, `:189` `parseStatus`.

**`agent-end.ts`**
- `:83` `skipJudge`. `:93` `phaseAfterFlow(returnToPlan, phase: "off"|"plan"|"execute")`.

**Tools on this machine and in the worktree extension**
- `unity` is at `~/AppData/Local/Unity/bin/unity`. `adb` is on PATH. There is no `xcrun`.
- `worktree/live.ts:80-83` shows any phase other than plan/execute as "idle". It handles unknown phases, so emitting `"test"` is safe.

### 4. Design

#### Components

| Component | Responsibility |
|---|---|
| `test` phase (main session, role `test`) | Supervisor. Plan-phase read-only tools plus `test_run`, with an extended bash allow list. `edit`, `write`, `judge` and `plan_check` are refused. |
| `test_run` tool (`index.ts` wiring, logic in new `test-run.ts`) | Takes task cards. Schedules them by resource and concurrency. Runs one `runner` subagent per task. Verifies each result against the subagent's tool calls. Writes per-task records. Returns one result section per task. |
| `runner` role (subagent) | Haiku 5.5, thinking low. Tools `bash, read, grep, find, ls`. Loads `runner-guard.ts`. Runs exactly the card and reports facts only. |
| `runner-guard.ts` (new, subagent-only extension) | Refuses runner bash commands: git/gh that change something, `test.runnerDeny` matches, project paths outside the flow's repos, assignments to `test.runnerPathEnv` names. |
| `test-report.ts` (new) | Parses and validates the supervisor's `## Test report`. Pure. |
| `test-flow.ts` (new, stage 2) | Pure flow logic: builds the fix-round plan from the flow state, decides the next action after a report, builds the round messages, the question batch items and the outcome text. |
| `prompts.ts` | Seven texts: `TEST_PHASE` (supervisor), `RUNNER`, `FIX_ROUND` (execute addendum in test flows), `JUDGE_TEST`, `ARBITER_TEST`, `testRoundMessage(...)`, `fixRoundMessage(...)`. |

#### Config contract

Add `"test"` and `"runner"` to `ROLES`.

`DEFAULTS.roles`:
- `test: { model: "claude-bridge/claude-opus-5-5", thinking: "medium" }`
- `runner: { model: "claude-bridge/claude-haiku-5-5", thinking: "low" }`

New `test` block in `WorkflowConfig`, `DEFAULTS` and `pi/agent/workflow.json`:
```json
"test": {
  "concurrency": 4,
  "maxTasks": 8,
  "runnerTimeoutMs": 2700000,
  "maxRounds": 3,
  "refails": 2,
  "delivery": "commit",
  "runnerTools": ["bash", "read", "grep", "find", "ls"],
  "supervisorBashAllow": ["^adb( -[sdetHP] \\S+)* (devices|shell getprop)\\b", "^unity (cmd )?(status|editor_status|console_status)\\b"],
  "runnerDeny": ["^adb( -[sdetHP] \\S+)* (reboot|reboot-bootloader|sideload|root|unroot|remount|disable-verity|enable-verity)\\b", "^adb\\b.*\\bshell\\b.*(\\brm\\s+-[a-z]*r|\\bwipe\\b|\\brecovery\\b|\\bfactory\\b|\\bformat\\b|\\breboot\\b)", "^fastboot\\b"],
  "runnerPathFlags": ["--project-path", "-projectPath"],
  "runnerPathEnv": ["UNITY_PROJECT_PATH"]
}
```

Validation in `loadConfig`. Bad values fall back to the default:

| Key | Valid values |
|---|---|
| `concurrency` | integer ≥ 1 |
| `maxTasks` | integer 1-16 |
| `runnerTimeoutMs` | number ≥ 60000 |
| `maxRounds` | integer ≥ 0; `0` = no limit |
| `refails` | integer ≥ 1 |
| `delivery` | `isDelivery` |
| the five arrays | arrays of strings |

App-level `adb install -r`, `adb uninstall` and `pm clear` stay allowed. The user did not say whether devices are dedicated test phones, so this follows the proposal; a user can add patterns to `runnerDeny`.

#### Phase and state

- `Phase` becomes `"off" | "plan" | "execute" | "test"`.
- `FlowState.testFlow?: TestFlow`, persisted with the rest. A test flow is active while `state.testFlow` is set.
- `TestFlow` fields:

| Field | Meaning |
|---|---|
| `scope` (string) | what the user asked to test |
| `round` | test rounds started, 1-based |
| `fixRounds` | fix rounds started |
| `fixBudget` | rounds allowed before asking; starts at `maxRounds` |
| `items` | map ID → `{ tag, title, body, round }`, the latest version of each item |
| `ran` | the latest report's `Ran:` lines |
| `fixed` | IDs verified fixed |
| `lastFixIds` | the steps of the last fix round |
| `refails` | map ID → count |
| `skipped` | IDs |
| `answers` | lines `D<n>. <ID>: <answer>` |
| `pending` | questions `{ id, kind: "ask"|"blocked"|"manual"|"refail"|"dispute", text, options? }` |
| `escalateNext` | boolean |
| `nudged` | boolean, per round |
| `snapshot` | per repo root, `git status --porcelain` lines at round start |
| `strays` | paths |
| `nextId` | number |

- Entering `test` from `/flow test`, `--flow test` or the plan phase goes through `setPhase(ctx, "test")`:
  - the existing abandon logic for leaving an executing flow still fires;
  - plan or test tool blocking is applied with the test allow list;
  - `applyRole(ctx, "test")`.
- Inside an active test flow, test ↔ execute switches go through a new `switchRoundPhase(ctx, phase)`, never `setPhase`. That keeps the flow, plan doc and claims, and does not record "abandoned". It sets `state.phase`, swaps tool blocking, applies the role (clearing `escalated`), resets the per-round fields as `startNextStage` (`:2104-2120`) does, and persists.
- `setPhase` to `plan` or `off` while a test flow is active ends the flow like leaving `execute` today: summary "back to planning" or "abandoned", milestone abandoned, `testFlow` cleared.
- The leave-flow conditions in `setPhase` (`:431`, `:438`) apply when `state.phase` is `execute` **or** `test`.

#### Test report contract

This is the supervisor's final reply of every test round.

```
## Test report: <scope title>
Ran: <command or scenario> → <result counts>
Ran: ...
**S1.** [bug] <title>
  Repro: <exact steps/commands>
  Expected: <behaviour> (source: <test name | file:line | doc | user decision>)
  Actual: <what happened, with the runner evidence>
  Suspect: <file:line>
  Root cause: <the diagnosis>
  Fix direction: <what to change, in words>
**S2.** [ask] <title>
  Question: <one question>
  Options: a) ... b) ...
**S3.** [blocked] <title>
  Needs: <credential, device, service>
**S4.** [manual] <title>
  Steps: <what the user must do on the device>
  Look for: <what to report>
**S5.** [fixed] <title>
  Evidence: <repro now passes, runner task id>
VERDICT: CLEAN | BUGS
```

`parseTestReport(text, expect)` returns `{ title, ran: string[], items: TestItem[], verdict, problems: string[] }`, or `null` when the report heading or the VERDICT line is missing.

```ts
export type TestTag = "bug" | "ask" | "blocked" | "manual" | "fixed";
export interface TestItem { id: string; tag: TestTag; title: string; fields: Record<string, string>; body: string }
export function parseTestReport(text: string, expect: { nextId: number; known: string[]; mustReport: string[] }): TestReport | null;
```

How parsing works:
- An item starts at a line matching the plan-doc `ITEM` style with a `[tag]` right after the ID.
- Its body runs until the next item, a `#` heading, or the VERDICT line.
- Fields are `Name: value` lines. Field names are case-insensitive and stored with lowercase keys. Each value may continue on indented lines.

`problems` lists each of these as one line naming the ID:
- a `[bug]` missing any of Repro, Expected (with `source:`), Actual, Root cause, Fix direction;
- an `[ask]` without Question;
- a `[blocked]` without Needs;
- a `[manual]` without Steps;
- an unknown tag;
- `VERDICT: CLEAN` while a `[bug]` item exists;
- no `Ran:` line;
- an ID listed in `mustReport` missing from the report;
- a new ID below `nextId` that is not in `known`.

Duplicate IDs: the first one wins, and the duplicate is a problem.

#### `test_run` contract

Parameters: `tasks` (1+) of:

| Field | Meaning |
|---|---|
| `id` | short name |
| `run` | exact commands or scenario |
| `observe` | what to capture |
| `pass` | criteria |
| `resource` | e.g. `unity:<project>`, `device:<serial>`, `none` |

The tool works only in the `test` phase. Anywhere else, `tool_call` refuses it with "test_run works only in the test phase".

- **Limits and task IDs.** Tasks beyond `test.maxTasks` are dropped, with a note line. IDs are sanitized to `[A-Za-z0-9_-]{1,40}`; an empty result becomes `task<n>`, and duplicates get `-2`, `-3`, ….
- **Scheduling.** `scheduleTasks(tasks, concurrency, runOne)` in `test-run.ts`:
  - tasks with the same `resource` (trimmed, case-insensitive) form one group and run one after another, in input order;
  - `none` (or empty) puts each task in its own group;
  - groups run through `mapLimit(groups, concurrency)`;
  - results come back in input order.
- **Card.** One runner subagent per task. The workflow builds the task text:
  ```
  ## Task <id>
  Run: <run>
  Observe: <observe>
  Pass when: <pass>
  Resource: <resource>
  Working folder: <ctx.cwd>
  Artifacts folder: <abs path>
  ```
  The artifacts folder is `<plan folder>/runs/<round>/`. The plan folder is the folder of `planFilePath()`; when there is none, `os.tmpdir()/pi-test-runs/<flowId or timestamp>/<round>/`. It is created with `mkdirSync({ recursive: true })`.
- **Runner run.**
  - `runRole("runner", "[<resource>] <id>", …)` with tools `test.runnerTools`, system prompt `prompts.RUNNER`, cwd `ctx.cwd`, and the tool's abort `signal`.
  - `extensions: [RUNNER_GUARD_EXTENSION]` and `env: { PI_WORKFLOW_RUNNER_GUARD: JSON spec }`.
  - Timeout `test.runnerTimeoutMs`: add an optional `timeoutMs` to `runRole`'s opts that overrides `cfg.subagent.timeoutMs`.
  - If the guard file is missing, every task returns `ERROR: runner guard extension not found at <path>` and no runner starts.
- **Runner reply contract**, parsed by `parseRunnerReply`:
  ```
  RESULT: PASS | FAIL | ERROR
  Command: <exact command(s) run>
  Exit: <exit code(s)>
  Observed:
  <at most 40 lines>
  Artifacts: <paths, comma- or line-separated>
  ```
  A missing RESULT line means ERROR "runner gave no RESULT line". Observed is cut to 40 lines by the workflow too.
- **Verification.** `verifyRun(parsed, toolCalls)`:
  - The ran list holds every call whose name ends in `bash`, as `ok|error` plus the first 200 characters of the command.
  - A PASS or FAIL with no bash call becomes `<RESULT> (unverified: no command was run)`.
  - A PASS where any bash call has `isError` becomes `PASS (unverified: <n> command(s) failed)`.
  - A failed subagent (`!result.ok`) becomes `ERROR: <error>`.
- **Per-task record.** The workflow writes `<artifacts>/<id>.md`: the card, the runner's reply, and each bash call with the first 2000 characters of its result.
- **Tool result**, one section per task:
  ```
  ### <id> · <resource> · <status>
  Command: … / Exit: … / Observed: … / Artifacts: …
  Commands actually run (<n>):
  - ok `…`
  Record: <path to <id>.md>
  ```
  The `usage` is summed as in `explore`. Live rows come from `toolProgress` and `renderRuns`, as in `explore`.

#### Runner guard contract

```ts
export const RUNNER_GUARD_ENV = "PI_WORKFLOW_RUNNER_GUARD";
export interface RunnerGuardSpec { roots: string[]; deny: string[]; pathFlags: string[]; pathEnv: string[] }
```

`roots`: the flow repos' roots plus the added folders; with no git, `[ctx.cwd]`. A malformed spec means the guard refuses every bash call: "runner guard spec missing". It hooks `tool_call` for any tool whose name matches `(^|__)bash$` and checks the command text in this order:
1. Any parsed command whose name (after `KEYWORDS` and wrappers) is `git` or `gh` and that the plan-phase read-only check refuses is refused: "runners may not change git or GitHub". Export a new `commandReadOnlyProblem(cmd: ParsedCommand, allow: RegExp[])` from `readonly-bash.ts` wrapping `commandProblem`. This is an addition; K5 is unchanged.
2. A `deny` regex matching a parsed command's words joined with spaces, or the whole text, is refused: "refused by test.runnerDeny: <pattern>".
3. A word equal to a `pathFlags` entry takes the next word; a word starting `<flag>=` takes the rest. The value:
   - is refused if it contains `$`, a backtick or `%`;
   - is otherwise resolved against the subagent's `process.cwd()`;
   - must be inside one of `roots` (compared through `repoKey`, as in `commit-guard.ts`).
   Outside the roots it is refused: "project path <p> is outside this flow's folders".
4. A parsed command whose `env` contains a `pathEnv` name is refused: "set the project with --project-path instead of <NAME>".

It's a guard against drift, not a sandbox. A `cd` inside the text does not move the base for relative paths; that is a documented limit.

#### Supervisor tool policy

- In `test` phase, active tools = the plan filter (`planToolRefused` with `planAllowedTools` plus `^test_run$`) minus `judge` and `plan_check`.
- `tool_call` in `test`:
  - refuses `edit`, `write`, `judge` and `plan_check`;
  - otherwise runs exactly the plan checks (`planToolRefused`, `planToolProblem`), with allow = `planBashAllow` + `test.supervisorBashAllow`;
  - refusal reason prefix: "Test phase: the supervisor only reads and sends runners".
- `session_start` restore re-applies the blocking for `test` as it does for `plan`.

#### Fix-round plan, built by `test-flow.ts` `testPlan(flow, tail)`

```
## Plan: Test: <scope title>
1. Goal and non-goals.
Goal: every [bug] step below behaves as its Expected says, verified by its repro in the next test round, without changing behaviour outside them.
Non-goals: new features; refactors; items tagged ask, blocked or manual until answered; skipped items.
2. User decisions:
D1. Test scope: <scope>
<answers, D2...>
3. Facts:
Ran: <each latest Ran line>
5. Steps:
**S<n>.** [bug] <title>
  <body fields>
7. Done when:
- each step's Expected holds and its repro passes in the next test round
- each step has a regression test that fails without the fix, or the executor's report says why none can exist for that layer
- the suites under Facts pass
9. Commits:
- one commit per step: fix: <title> (S<n>), with its regression test
```

- Steps = every `[bug]` item of the flow that is not skipped, in ID order. Items waiting on a refail question are left out.
- `tail` = the current approved plan from the first `AMENDMENT` heading on, kept verbatim, so arbiter amendments and upheld notes survive regeneration.
- At each regeneration the checklist ticks are reset to `done = fixed.includes(id)`.
- The title is `"Test: " +` the first line of the scope, at most 60 characters.

#### Round lifecycle (stage 2)

**Start.**
- `/flow test <scope>` → `setPhase("test")`, then `startTestFlow(scope)`, then a `workflow-test` message with the scope and `triggerTurn`.
- `/flow test` with no scope, or `--flow test` → `setPhase("test")` with a notice "describe what to test". The next typed message (not from an extension) in the `test` phase with no active flow starts the flow with that text as the scope, and continues unchanged.
- `startTestFlow`:
  - sets `testFlow` (round 1, `fixBudget = maxRounds`, `nextId` 1);
  - sets `approvedPlan = testPlan(...)` with no steps;
  - sets `state.delivery = cfg.test.delivery` and `state.planFlaw = "auto"`;
  - calls `planMilestone`;
  - takes the stray snapshot.

**End of a test round** (`onAgentEnd`, new branch for `state.phase === "test"` after the `hasUI` return at `:2019`):
1. **Reply ended in error or abort** (`skipJudge`): a menu with "Retry" (sends "Continue the test round where you stopped.") and "Stop" (summarizes "stopped: the supervisor's reply failed", then `endFlow`). Escape = Stop.
2. **Parse the report** with `expect = { nextId, known: ids, mustReport: lastFixIds }`.
   - `null` or `problems` with `!nudged`: set `nudged` and send `workflow-test-report` with the problem lines and "End with the test report in the required format", with `triggerTurn`.
   - Still invalid: the Retry/Stop menu.
3. **Record.** Store the items (latest wins), `ran`, and `nextId = max ID + 1`. Diff the stray snapshot: new or changed porcelain entries go to `strays`.
   - For each ID in `lastFixIds`: `[fixed]` → add to `fixed`. `[bug]` → `refails[id]++`:
     - count 1 sets `escalateNext`;
     - count ≥ `test.refails` adds a pending `refail` question.
   - New `[ask]`, `[blocked]` and `[manual]` items that are not already answered or skipped get a pending question.
   - Clear `lastFixIds`.
4. **Next action**, from the pure `nextAction(flow, cfg)`:
   - open bugs exist (`[bug]`, not fixed, not skipped, no pending refail):
     - `fixBudget > 0` (or `maxRounds` is 0) → **fix**;
     - otherwise → **limit**;
   - else pending questions exist → **ask**;
   - else → **done**.
5. **fix** → `startFixRound`:
   - `fixRounds++`, `fixBudget--`; regenerate the plan; `refreshChecklist` with the reset ticks; `planMilestone`;
   - `lastFixIds` = this round's step IDs;
   - `switchRoundPhase("execute")`, then `escalate(ctx)` if `escalateNext` (then clear it);
   - `handover("workflow-test-fix", fixRoundMessage(stepIds, strays))`, then clear `strays`. The message tells the executor to restore or delete stray files unless a step needs them.
6. **limit** → a menu "Fix round limit reached with <n> open bug(s)" offering "Run <maxRounds> more fix rounds" (`fixBudget += maxRounds`, then fix) or "Stop" (done with open bugs). Escape = Stop.
7. **ask** → `askBatch`, one prompt per pending question:

   | Kind | Prompt | Choices |
   |---|---|---|
   | `ask` | `ctx.ui.select` | its Options, then "Other (type it)" (opens `ctx.ui.input`), then "Skip" |
   | `manual` | `ctx.ui.input` "Do: <Steps>. Look for: <Look for>. What did you see? (empty skips)" | |
   | `blocked` | `select` | "It's available now", "Skip", "Stop the flow" |
   | `refail` | `select` "<ID> still fails after <n> fixes" | "Keep trying (escalated)" (sets `refails[id] = refails - 1` and `escalateNext`), "Skip this bug", "Stop the flow" |
   | `dispute` | `select` showing the flaw line | "The test's Expected is right", "The fix is right; the Expected is wrong", "Skip" |

   - Escape = Skip. Skip adds the ID to `skipped`; skipped items are never asked again or fixed.
   - Any other answer is appended to `answers` as `D<n>. <ID>: <answer>`, with n continuing after D1.
   - "Stop the flow" goes straight to **done**.
   - Pending is cleared.
   - If any non-skip answer was given, `startTestRound(ctx, "answers")`; otherwise **done**.
8. **done** → `summarizeFlow(testOutcome(flow), ok)`, then `endFlow`.
   - `testOutcome` text: `test: <f> fixed in <r> fix round(s)`, then `; open: <ID tag, …>` and `; skipped: <IDs>` when present.
   - `ok` = no open `[bug]`.
   - Clear `testFlow`.

**After a fix round.**
- `summarizeCommit` (`:2165`): when `testFlow` is set, record the outcome; if not ok, notify a warning and carry on. Then `startTestRound(ctx, "retest")` and return `"advanced"`.
- A pass with nothing committed (`summarizePass` `:2524`, reached when delivery is `off`) and an execute turn ending with no diff (`reviewDiff`'s no-diff branch `:2270`) both call `startTestRound(ctx, "retest")` when `testFlow` is set, instead of ending the flow or waiting.

**`startTestRound(ctx, why)`:**
- `round++`, clear `nudged`, take the stray snapshot;
- `switchRoundPhase("test")`;
- `handover("workflow-test-round", testRoundMessage(...))`. The message carries:
  - the reason;
  - the fixed-this-round IDs with their Repro lines, to re-run and report as `[fixed]` or `[bug]`;
  - the latest Ran lines, to re-run as the regression check;
  - the new answers;
  - "next free ID: S<nextId>";
  - "continue with the parts of the scope not yet covered".

**Judge and arbiter in test flows.**
- `judgeOnce` appends `prompts.JUDGE_TEST` after `JUDGE` (full review and re-review) when `testFlow` is set.
- `runArbiter` appends `prompts.ARBITER_TEST` after `ARBITER`.
- `resolvePlanFlaw`: in a test flow, when the arbiter returns `"ask"`:
  - add one pending `dispute` question per plan-flaw line (`planFlawLines`), with the first `S\d+` in the line as its ID, else `"plan"`;
  - call `notePlanFlaws(ctx, report, "Plan choices upheld until the user answers")` (the heading must match `AMENDMENT`);
  - return `"continue"`, with no menu.
- `fixOrAsk`'s round-cap menu stays as it is: a crucial limit.

#### Other contract changes
- **K2:** the switch guard also cancels while `state.phase === "test"` and a test flow is active. Same notice text, with "a flow is executing".
- **K3:** `--flow` accepts `test`.
- **K4:** `phase` may be `"test"`.
- **`PlanStatus`:** gains `kind?: "test"`, written when `testFlow` is set. `parseStatus` keeps `kind` only when it is `"test"`.
- **`resumeFlow`:** lists test flows marked `(test flow)` and refuses them: "test flows can't be resumed; start a new one with /flow test".
- **View:**
  - `Stage` gains `"test"`, `SubRole` gains `"runner"`, `STAGES = ["plan", "test", "execute", "judge", "commit"]`, and `emptyStageTokens` and `emptyFlowUsage` gain `test`.
  - The widget pipeline and the summary card show the `test` node or row only when it has tokens or `view.stage === "test"`.
  - Runner runs count toward `test`. The three `view.stage = …` sites (`:1429`, `:1455`, `:2770`) use one helper mapping `test` → `"test"`.
- **`phaseAfterFlow`'s** type widens to include `"test"`.
- **`statusText`:** in a test flow, adds the line `test flow: round <r>, fix rounds <f>, fixed <n>, open <m>, pending questions <q>`.
- **`/flow judge` and `/flow approve`** in the test phase: notice "not used in the test phase", nothing else.
- **`/flow test`** while an approved non-test flow is executing, or while a test flow is active: refused with "finish it or leave it with /flow off first".

#### Failure handling

| Failure | Handling |
|---|---|
| Runner subagent fails or times out | That task is `ERROR: <error>`; the other tasks continue |
| Supervisor reply fails | Retry/Stop menu |
| Report invalid twice | Retry/Stop menu |
| Commit incomplete | Warning, retest continues |
| Arbiter fails | Returns `"ask"`, which in test flows becomes a dispute question |
| Plan file missing | Artifacts go to the temp folder |
| Abort during a round | Like stages: nothing is handed over (`turnAborted`); the user continues manually |

#### Scale assumptions
- Up to 8 tasks per `test_run` and 4 runners at once (4 Haiku processes, each one `pi` boot plus bridge).
- Runner records are at most about 20 KB each. The supervisor's tool result is about 60 lines per task, at most 8 × 60 lines.
- Typical flows: 1-3 fix rounds, under 30 items.
- `items` is held in persisted state. Beyond about 200 items the state entry and the regenerated plan get large (the 60k-character plan trim at `index.ts:1342` cuts it). Above that, split the scope.

#### Alternatives rejected
- **More tools for the planner:** expensive per call, and loses the read-only guarantee.
- **A supervisor that runs tests itself:** that's Opus making the many tool calls.
- **Runners in the main session:** no parallelism.
- **Forwarding MCP to runners:** not needed for the CLI (D8).
- **A planner-written fix plan per round:** breaks "automatic" (D1).
- **Several tasks per runner:** tool calls could no longer be matched to a task for verification (D10).

### 5. Steps

### Stage 1: Supervisor, runners and test report

**S1.** `config.ts:17`, `:155-215`, `:238-272` and `pi/agent/workflow.json`.
- Add the roles `test` and `runner` and the `test` block exactly as in Design → Config contract, with the stated validation.
- Model the validation on the `plans` and `idleTimeoutMs` checks (`config.ts:260-265`).
- Add the two roles and the block to `workflow.json`: `test` = opus-5-5 medium, `runner` = haiku-5-5 low.

**S2.** `readonly-bash.ts:297`.
- Export `commandReadOnlyProblem(cmd: ParsedCommand, allow: RegExp[] = []): string | null`. It returns `commandProblem(cmd, allow)` and behaves the same.
- Don't touch `parseCommands`, `KEYWORDS` or `WRAPPERS` (K5).

**S3.** New `runner-guard.ts`, a subagent-only extension.
- Export `RUNNER_GUARD_ENV`, `RunnerGuardSpec`, `parseRunnerSpec(raw)` (null when malformed, like `parseGuardSpec` at `commit-guard.ts:25-40`) and `runnerProblem(text, spec, cwd, platform?)`.
- `runnerProblem` checks in the order given in Design and returns the reason or null.
- The default export registers a `tool_call` handler: for bash-named tools it blocks with `Refused (runner guard): <reason>`, and with no valid spec it blocks every bash call.
- Model it on `commit-guard.ts`. Add `RUNNER_GUARD_EXTENSION` next to `index.ts:195`.

**S4.** New `test-report.ts`.
- `parseTestReport` and its types exactly as in Design → Test report contract.
- The item regex must accept `**S1.** [bug] title`, `- S2: [ask] title` and `S3) [manual] title`, the forms `ITEM` at `plan-doc.ts:24` accepts.

**S5.** New `test-run.ts`.
- `sanitizeIds(tasks)`, `scheduleTasks(tasks, concurrency, runOne)`, `parseRunnerReply(text)`, `verifyRun(parsed, toolCalls)` and `formatTaskResult(...)`, as in Design → `test_run` contract.
- Pure, apart from `runOne`. Reuse `mapLimit` from `subagent.ts:306`.

**S6.** `prompts.ts`. Add `TEST_PHASE` and `RUNNER`, and extend `phaseSection` to return `TEST_PHASE` for `"test"`.

`TEST_PHASE` must say all of the following:
- You are the test supervisor, on a strong model. You read, plan tests and triage. You never run tests yourself and never edit: send runners with `test_run`.
- Write cards with exact commands, `observe` and `pass`.
- Resource naming: all Unity commands on one project share `unity:<project folder>`; one device = `device:<serial>` with `adb -s <serial>`; independent work = `none`.
- Unity goes through the `unity` CLI with `--project-path` inside the working folder. Device checks use `adb`, with logcat filtered to the app and `adb exec-out screencap -p` into the artifacts folder. Open screenshots with `read`.
- You may run `adb devices` and `unity status` yourself.
- Runner results are claims. Rerun any `unverified` result before relying on it. Read a task's record file only when needed.
- Triage rules:
  - `[bug]` only when a test, spec, doc, file:line or user decision says what is right;
  - `[ask]` only when nothing says what is right and the readings lead to different code, or when a fix needs a public interface, data format, dependency or user-data change;
  - `[blocked]` when something is missing;
  - `[manual]` when only a person can check it.
- Don't ask the user in chat: the workflow asks the questions in a batch.
- Diagnose every bug: Suspect, Root cause and Fix direction are direction, not code.
- In retests, report every listed fixed ID as `[fixed]` or `[bug]`.
- Number new items from the next free ID given.
- End with the report in exactly the format above, including the VERDICT line.
- The batch line, as in `planPhase`.

`RUNNER` must say:
- Run exactly the card. Don't fix, edit or diagnose.
- Redirect long output into `<artifacts>/<id>-*.log`. Write only inside the artifacts folder.
- Never run git or gh commands that change things. A refused command is reported, not worked around.
- Reply only in the runner reply format.

**S7.** `view.ts:27-80`.
- Add `"test"` to `Stage`, `STAGES` (order as in Design) and the empties, and `"runner"` to `SubRole`.
- Show the `test` node and row only when it has tokens or is the active stage (`:195`, `:207`, `:418-446`).
- Runner runs count toward `test`, which follows from `view.stage` (`:296`).

**S8.** `index.ts` phase plumbing.
- `Phase` gains `"test"`, `FlowState` gains `testFlow?`, and `phaseAfterFlow` (`agent-end.ts:93`) widens its type.
- `setPhase` (`:430-465`):
  - enter or leave tool blocking for `test` with its own allow list (generalize `blockPlanTools`/`restorePlanTools` into one function that takes the extra allowed patterns);
  - extend the leave-flow conditions to `test`;
  - clear `testFlow` when the target is `plan` or `off`.
- Add `switchRoundPhase` as in Design.
- `session_start` (`:2864`): re-block for `test`. `:2879`: accept `--flow test`, and update the flag description at `:299`.
- Replace the three `view.stage` sites (`:1429`, `:1455`, `:2770`) with the helper.
- `emitStatus` needs no change beyond the type.
- K2 guard (`:2892`): also for an active test flow.

**S9.** `index.ts` `tool_call` (`:1692-1736`). Add the `test` branch exactly as in Design → Supervisor tool policy. `test_run` called outside `test` is refused.

**S10.** `index.ts`: register the `test_run` tool after `explore` (`:1534`), following its structure.
- Wire it to the `test-run.ts` functions.
- Add `timeoutMs?` to `runRole`'s opts (`:569-598`).
- Build the guard spec:
  - `roots` from `flowRepos(ctx)` roots plus `existingFolders()`, or `[ctx.cwd]`;
  - `deny`, `pathFlags` and `pathEnv` from `cfg.test`.
- Write the per-task records.
- `renderCall` shows `test_run <n> task(s)`, `renderResult` reuses `renderRuns`, and each run is finished with its status (`view.finish`).

**S11.** `index.ts`: start a test flow.
- `/flow test [scope]` in the `/flow` switch (`:3062`), plus its completion and help text.
- The `input` handler (`:1917`): typed scope in the test phase with no active flow.
- `startTestFlow` as in Design. `writePlan` (`:970`) writes `kind: "test"`, and `parseStatus` (`plan-doc.ts:189`) keeps it.
- `resumeFlow` (`:1166`) refuses test flows as in Design.
- `statusText` (`:2924`) adds the test-flow line. `/flow judge` and `/flow approve` in the test phase give the notice.

**S12.** `index.ts` `onAgentEnd`: the stage 1 `test` branch, after `:2019`.
- Steps 1-3 of Design → End of a test round: error menu, parse and nudge, record (no refail handling yet).
- Then end the flow: regenerate the plan with the items as steps (the stage 2 `testPlan` does not exist yet, so do this with a local helper that S14 replaces), `planMilestone`, then `summarizeFlow` with `test: <n> bug(s), <a> ask, <b> blocked, <m> manual found; not fixed` (`ok` = no bugs), then `endFlow`.
- If `strays` is non-empty, also notify "files changed during testing: …".

**S13.** `README.md` and `docs/workflow-improvements.md`.
- README:
  - roles table rows for `test` and `runner`;
  - a new section "Test and fix" (supervisor, runners, report format, `test_run` scheduling and verification, runner guard and its limits, config keys);
  - `/flow test` in Commands;
  - K2, K3 and K4 updated;
  - the new test files in the test command line.
- Backlog: new row **A12** "Test-and-fix flow: strong supervisor, Haiku runners in parallel by resource, automatic fix loop" with **Partly done:** stage 1 (`runner-guard.ts`, `test-report.ts`, `test-run.ts`, `index.ts`). Add it to the Status line as partly implemented, and add an Effect-measurement row A12:
  - Metric: user prompts per test flow; supervisor vs runner tokens (D3 metrics); bugs verified fixed per flow.
  - Keep if: most flows end without prompts beyond the crucial cases; runner tokens are the larger share; no fix is committed that the retest shows broken.

### Stage 2: Automatic fix loop

**S14.** New `test-flow.ts`.
- `testPlan(flow, tail)`, `nextAction(flow, cfg)`, `openBugs(flow)`, `recordReport(flow, report, refailsLimit)` (step 3 of the lifecycle, including the refail and pending rules; it returns the updated flow), `testOutcome(flow)` and `pendingFromFlaws(lines)`.
- Pure, exactly as in Design → Fix-round plan and Round lifecycle.
- Replace the S12 local helper with `testPlan`.

**S15.** `prompts.ts`.
- `FIX_ROUND`, appended by `phaseSection("execute", …)` when a new option `testFix: true` is passed; `before_agent_start` passes it when `testFlow` is set. It must say:
  - fix the root cause, using Fix direction as a claim to verify;
  - add a regression test that fails without the fix, or say in the report why none can exist for that layer;
  - run the repro and the suites from Facts;
  - never change an existing test's expectation or an expected value unless the step says it is wrong;
  - fix only the listed steps; report other problems seen instead of fixing them;
  - restore stray files unless a step needs them.
- `JUDGE_TEST`:
  - a weakened, deleted or rewritten existing test or expected value is major unless the step says the expectation is wrong;
  - special-casing the repro input instead of fixing the root cause is major;
  - a fix without a regression test, and without a stated reason, is minor;
  - changes beyond the listed steps are major;
  - an Expected that contradicts its cited source is `[plan-flaw]`.
- `ARBITER_TEST`: the steps come from a test report. Decide each disputed Expected from the source it cites. REVISE amends that step's Expected and Fix direction. ASK_USER when the source is ambiguous.
- `testRoundMessage` and `fixRoundMessage` with the contents given in Design.

**S16.** `index.ts`: the fix loop.
- Replace the end of the S12 branch with steps 3-8 of Design → End of a test round, using `test-flow.ts`.
- Add `startFixRound`, `startTestRound` and `askBatch`.
- Add the test-flow hooks in `summarizeCommit` (`:2165-2205`), `summarizePass` (`:2524`) and `reviewDiff`'s no-diff branch (`:2270`).
- Judge and arbiter prompt addenda (`:1400-1408`, `:2449`). The `resolvePlanFlaw` dispute path (`:2375`) as in Design.
- `startTestFlow` sets `state.delivery = cfg.test.delivery` and `planFlaw = "auto"`, so no delivery menu (D9).
- Model the round switches on `startNextStage` (`:2104-2120`), including `markPassSummarized` and clearing `lastJudge`.

**S17.** README "Test and fix" section: describe the loop, when it asks, refail and escalation, `maxRounds`, and the end outcome text. Backlog: A12 becomes **Done:** (`test-flow.ts`, `index.ts`, `prompts.ts`), and the Status line is updated.

### 6. Tests

Run from `pi/agent/extensions/workflow`:

```
node --experimental-strip-types --test agent-end.test.ts readonly-bash.test.ts readonly-tools.test.ts tokens.test.ts push-guard.test.ts knowledge.test.ts mcp-forward.test.ts subagent.test.ts delivery.test.ts repos.test.ts stages.test.ts commit-guard.test.ts repo-diff.test.ts prompts.test.ts config.test.ts metrics.test.ts plan-store.test.ts boundary.test.ts plan-doc.test.ts runner-guard.test.ts test-report.test.ts test-run.test.ts test-flow.test.ts
```

Expected: every test passes, 0 failures. `test-flow.test.ts` exists from stage 2 on; in stage 1 run the list without it.

**`config.test.ts`**
- "test block defaults": no file → `test.concurrency` 4, `maxTasks` 8, `runnerTimeoutMs` 2700000, `maxRounds` 3, `refails` 2, `delivery` "commit"; roles `test` opus medium, `runner` haiku low.
- "test block validation": `concurrency: 0`, `maxTasks: 99`, `runnerTimeoutMs: 5`, `refails: 0`, `delivery: "x"`, `runnerDeny: "str"` → each falls back to its default. `concurrency: 1` is kept.

**`readonly-bash.test.ts`**
- "commandReadOnlyProblem": `parseCommands("git push")[0]` → non-null; `parseCommands("git status")[0]` → null.

**`runner-guard.test.ts`**
- `git commit -m x` → refused "runners may not change git".
- `git log --oneline` → null.
- `adb -s R58 reboot` → refused by runnerDeny.
- `adb shell rm -rf /sdcard/x` → refused.
- `adb install -r app.apk` → null.
- `adb uninstall com.x` → null.
- `fastboot flash boot x` → refused.
- `unity run-tests --project-path D:/other/proj` with roots `["D:/projects/game"]` → refused, outside.
- `--project-path=D:/projects/game/unity` → null.
- `--project-path $P` → refused.
- `UNITY_PROJECT_PATH=x unity build` → refused.
- `parseRunnerSpec("{")` → null.

**`test-report.test.ts`**
- A full valid report (one of each tag) → five items, fields lowercased, verdict BUGS, no problems.
- A `[bug]` without Root cause → problem naming the ID.
- `VERDICT: CLEAN` with a `[bug]` → problem.
- No VERDICT line → null.
- `mustReport ["S1"]`, report without S1 → problem.
- New ID S2 with `nextId` 5 and not known → problem.
- The three item line forms → parsed.
- Duplicate ID → first kept, problem.

**`test-run.test.ts`**
- "same resource never overlaps": 4 tasks on `unity:p`, concurrency 4, fake `runOne` tracking active counts per resource → max 1 per resource; results in input order.
- "concurrency respected": 6 `none` tasks, concurrency 2 → max active 2.
- "concurrency 1 is serial" → max active 1.
- `sanitizeIds` with `["a b", "a b", ""]` → `["a_b" or "ab", "...-2", "task3"]`. Assert the rule: unique and matching `[A-Za-z0-9_-]{1,40}`.
- `parseRunnerReply` without RESULT → ERROR.
- `verifyRun`: PASS with no tool calls → `PASS (unverified: no command was run)`; PASS with one `isError` bash → `PASS (unverified: 1 command(s) failed)`; FAIL with calls → FAIL.
- Observed over 40 lines → cut to 40.

**`prompts.test.ts`**
- `phaseSection("test", …)` contains `test_run`, `[ask]`, `VERDICT: CLEAN | BUGS`, `unity:` and `device:`.
- `RUNNER` contains `RESULT: PASS | FAIL | ERROR`.
- (Stage 2) `phaseSection("execute", { testFix: true, … })` contains "regression test". `JUDGE_TEST` mentions weakened tests and special-casing.

**`plan-doc.test.ts`**
- `parseStatus` keeps `kind: "test"` and drops `kind: "other"`.

**`agent-end.test.ts`**
- `phaseAfterFlow(true, "test")` → `"plan"`.

**`boundary.test.ts`**
- Unchanged; it must still pass with the new files.

**`test-flow.test.ts`** (stage 2)
- `nextAction`:
  - open bug, `fixBudget` 1 → fix;
  - open bug, `fixBudget` 0, `maxRounds` 3 → limit;
  - `maxRounds` 0 → fix;
  - only pending ask → ask;
  - nothing → done.
- `recordReport`:
  - `lastFixIds ["S1"]` and report `[fixed]` S1 → `fixed` includes S1;
  - `[bug]` S1 → `refails.S1 = 1` and `escalateNext`;
  - again with `refails` 2 → a pending refail, and S1 is excluded from `openBugs`.
- `testPlan`:
  - parses with `planSections` (goal, decisions, doneWhen, commits present);
  - `parseChecklist` returns the bug IDs only;
  - a tail starting `## Amendment 1 (arbiter)` is kept verbatim.
- `testOutcome` with 2 fixed, 1 manual open, 1 skipped → `test: 2 fixed in <r> fix round(s); open: S3 manual; skipped: S4`.
- `pendingFromFlaws`: a line with `S2` → id S2; without → "plan".

**Manual checks** (report in the final message, they can't be automated):
- `/flow test run the unit tests` in this repo: the supervisor sends at least one runner, the widget shows `test` and runner rows, the report parses, and the flow ends.
- Stage 2: plant a failing assert on a scratch branch and check fix → judge → commit → retest `[fixed]` → done.

### 7. Done when

- `/flow test <scope>`, `/flow test` followed by a typed scope, and `--flow test` start a test flow:
  - the supervisor runs on `roles.test` (Opus 5.5 medium);
  - it can't edit, judge or tick steps;
  - its bash is read-only plus `test.supervisorBashAllow`.
- `test_run`:
  - runs one Haiku runner per task, with same-resource tasks one at a time and others in parallel up to `test.concurrency` (default 4; `1` is serial);
  - each result carries the commands actually run, with unverified passes marked;
  - per-task records are in the plan folder's `runs/<round>/`.
- Runners can't edit, can't change git or GitHub, can't run `test.runnerDeny` commands, and can't point `--project-path` outside the flow's folders.
- A valid test report is parsed and recorded. An invalid one gets one automatic nudge, then the Retry/Stop menu.
- **Stage 2:**
  - open `[bug]` items start a fix round automatically, with no approval or delivery menu, on the execute model, with the test-flow fix, judge and arbiter addenda;
  - a pass commits (`test.delivery`, default commit) and the retest starts automatically on the supervisor;
  - a bug that fails again gets one escalated fix round, then a question;
  - the user is asked only in the cases in D12/D13/D3, the fix-round limit and the existing judge round cap, all batched after the clear bugs;
  - the flow ends with the `test: …` outcome and returns to planning.
- Normal plan → execute flows behave as before: all existing tests pass unchanged.
- README (roles, Test and fix, commands, K2/K3/K4, test list) and backlog row A12 are updated in the same commits as the code.

### 8. Risks, rollback, and what not to touch

**Risks**
- Restored sessions: the new `"test"` stage key relies on the merge with the empties (`index.ts:2859-2860`). Don't change that merge.
- The `setPhase` refactor of tool blocking can break the plan phase: the existing `readonly-tools.test.ts` and plan-phase behaviour must stay the same.
- Runner verification only sees bash calls. A runner that "observes" without running is caught, but a runner that runs the wrong command is not; the supervisor reads the attached commands.
- Parallel runners can hit API rate limits. `test.concurrency: 1` is the fallback.
- The worktree extension's live view shows the `test` phase as "idle" (`worktree/live.ts:80-83`). This is accepted and the worktree extension is not changed.
- `adb uninstall` and `pm clear` are allowed by default. A personal phone needs extra `runnerDeny` patterns.

**Rollback**
- Each stage is its own commits. Revert stage 2 to get back to "test and report". Revert stage 1 to remove the feature. Config keys that are no longer read are ignored.

**Don't touch**
- `parseCommands`, `KEYWORDS`, `WRAPPERS` (K5).
- The push-guard and commit-guard rules.
- The normal judge prompt texts: the addenda are separate constants.
- `delivery.ts`.
- The worktree extension.
- The plan-phase allow list defaults (`PLAN_TOOLS`, `planBashAllow`).

### 9. Commits

**Stage 1**
- `feat(workflow): runner guard for test runner subagents`: `runner-guard.ts`, `runner-guard.test.ts`, `readonly-bash.ts`, `readonly-bash.test.ts`.
- `feat(workflow): test report parser`: `test-report.ts`, `test-report.test.ts`.
- `feat(workflow): test phase with supervisor and parallel test_run runners`: `test-run.ts`, `test-run.test.ts`, `config.ts`, `config.test.ts`, `view.ts`, `prompts.ts`, `prompts.test.ts`, `index.ts`, `agent-end.ts`, `agent-end.test.ts`, `plan-doc.ts`, `plan-doc.test.ts`, `pi/agent/workflow.json`, `pi/agent/extensions/workflow/README.md`, `docs/workflow-improvements.md`.

**Stage 2**
- `feat(workflow): automatic fix loop for test flows`: `test-flow.ts`, `test-flow.test.ts`, `prompts.ts`, `prompts.test.ts`, `index.ts`, `pi/agent/extensions/workflow/README.md`, `docs/workflow-improvements.md`.

<!-- pi-workflow:status -->
## Outcome
2026-10-21T05:40:48.931Z — ok: stage 1: committed (10 commits), push skipped: master is protected; stage 2: committed (3 commits), push skipped: master is protected
