<!-- pi-workflow plan v1 flow=20261101-0128-trim-and-speed-up-the-pi-setup-normal-mo-921c -->
## Plan: Trim and speed up the Pi setup (normal mode first, agents extension, sync deletes, faster flows)

### 1. Goal and non-goals
**Goal:**
- Normal mode (no flow) is the default way of working. `explore`, `advisor`, `judge`, `git_task` and `test_run` work there.
- `pi/agent/AGENTS.md` is a short normal-mode rulebook.
- The sync propagates deletions safely.
- `explore`, `advisor`, `test_run` and the sub-agent runner live in a new `agents/` extension.
- The test phase is removed.
- Flows are faster:
  - one minor-fix round
  - a single plan
  - an automatic arbiter
  - fewer compactions
  - bash commits
  - tools limited per phase
  - trimmed prompts

**Non-goals (item 7, later):**
- the 44–47 KB AGENTS.md files in game-template and shiny-loop
- ww-kanboard / `mcp.json` and rotating its token
- `video_frames`
- `.bak` pruning
- the worktree review
- sessions cleanup
- the `knowledge` block in `workflow.json` (stays)
- `/flow board`, metrics and flow-report overlap
- `install/releases`

### 2. User decisions
- D1. Normal mode is the default. Flow features the user wants in both modes must work outside a flow.
- D2. Items 1–6 are done in this one flow, in the agreed order, and each part is merged on its own. Item 7 waits, and the user is reminded of it after the flow.
- D3. AGENTS.md becomes the normal-mode rulebook.
  - Firm rules: explore for folder exploration and multi-file search (read a file yourself only when you know its exact path); advisor only at real decision points; judge optional before a risky commit.
  - Kept: the output budgets, "read only lines you edit / narrow the query", "several calls → one codemode script, independent calls in parallel", "keep going until you need the user, a tool result or an explorer", "long commands in the foreground with a timeout; poll, never sleep minutes".
  - Cut only exact duplicates of the tool descriptions.
- D4. Explore thinking goes from `low` to `medium`. The model stays `claude-bridge/claude-haiku-5-5`.
- D5. A new extension `pi/agent/extensions/agents/`, loaded in every session.
  - It holds `explore`, `advisor`, `test_run`, the runner guard and `subagent.ts`.
  - `workflow` imports `subagent.ts` from `../agents/`.
  - The workflow keeps plan, execute, judge, arbiter, deliver, `git_task` and the guards.
- D6. Sub-agent usage reaches the workflow's token tracking through `pi.events`.
- D7. The `agents/` config goes in its own `agents.json`.
- D8. The test phase and its fix loop are removed.
- D9. Sync deletes use the per-machine record `local/sync-state.json`.
  - **Export:** a file that has a record, is gone locally, and whose repo copy still matches the record is deleted in the repo, and its record is marked deleted. An edited repo copy is kept, with a warning.
  - **Import:** a file that has a record, is gone from the repo, and whose local copy still matches the record is deleted locally, and empty parent folders are removed. An edited local copy is kept, with a warning.
  - A file with no record is never deleted.
- D10. Auto-commit commits deletions whose record is marked deleted.
  - There is no `.bak` for deletes.
  - JSON files are compared in their exported (scrubbed) form.
  - `--dry-run` prints `WOULD delete <path>`.
- D11. Safety cap: more than 20 files, or more than 25% of recorded files, needs `--allow-deletes`.
- D12. The user sees the exact delete paths before any irreversible deletion.
- D13. `/flow off` restores the model (and thinking level) from before the flow.
- D14. `git_task` works in normal mode without the judge gate.
- D15. `maxMinorRounds` goes from 3 to 1. After the minor-fix round, the judge reports only blocker and major findings.
- D16. A single plan.
  - "go" writes the final plan directly.
  - A requested change gets written only as the changed steps.
  - Approve executes the plan with no rewrite.
- D17. `planFlaw: "auto"`. The approval menu becomes Approve, Keep discussing and Back to discussion.
- D18. Small changes get a short plan template (Goal, Decisions, Steps, Tests, Done when). The full template is only for changes that add or reshape components, or that are staged.
- D19. Discuss runs on Opus with thinking `medium` (was `high`).
- D20. Handover compaction happens only at the start of execute and at stage starts. Minor-fix and open-steps handovers don't compact; the normal 140k guard still applies to them.
- D21. In execute, plain commits, pushes and PRs go through bash. `git_task` is only for conflicts, rebases and long split-commit sequences.
- D22. Each phase activates only the tools it can use. Normal mode keeps explore, advisor, judge, git_task and test_run.
- D23. Workflow prompts are trimmed of exact duplicates. The publish and mirror syntax is sent only where it applies.
- D24. Each change to `pi/agent/extensions/workflow/` updates `docs/workflow-improvements.md` in the same commit: the item's row, the Status line and the "Effect measurement" row.

### 3. Facts the executor needs
**Repo and sync**
- Repo `D:\works\pi-config`, protected branch `master`, GitHub `Unknownow/pi-config`.
- The sync extension loads its config **once**, at extension load (`extension/index.ts:152`). The config is `config/sync.json` (all automatic flags are on) overridden by the gitignored `local/sync.json` (`extension/index.ts:91-93`). `local/sync.json` does not exist today.
- The sync works on whatever branch is checked out, with no branch check:
  - pull with `--rebase --autostash` (`extension/index.ts:311`)
  - import from the working tree (`:434`, `bin/lib.js:25`)
  - the watcher on `~/.pi/agent` (`:376`)
  - commit (`:267`) and push (`:289`, `:295`); a push retry rebases and re-imports (`:298`)
- Auto-commit only commits files whose hash matches the record (`extension/ready.ts:20-30`). Today a missing file counts as a hand edit.
- Sync internals:
  - record handling: `bin/lib.js:361-426`; `editedInRepo`: about `lib.js:413-421`
  - "never deletes" notes: `lib.js:10-13`, `bin/export.js:9`, `bin/import.js:9`, `README.md`
  - `.bak` creation: `import.js:87-89`; `.bak` exclusion: `lib.js:101-108`, `extension/index.ts:364`
  - `MIRROR_DIRS`: `lib.js:42`
- Sync tests: `bin/sync.test.js`, `extension/ready.test.ts`.

**Workflow extension** (`pi/agent/extensions/workflow/`; `index.ts` is 4642 lines, `prompts.ts` 387)
- **Tools:** `pi.registerTool` at `index.ts`:

  | Tool | Line |
  |---|---|
  | explore | 2245 |
  | test_run | 2291 |
  | wait_for_user | 2471 |
  | publish_packages | 2596 |
  | git_task | 2644 (execute-only guard at 2656) |
  | plan_check | 2820 |
  | advisor | 2858 |
  | judge | 2895 |
  | deliver | 3006 |

- **Active-tool filtering:** `blockPlanTools`, `planToolRefusedIn`, `refilterTools` and `restorePlanTools` (`index.ts:519-556`), with test lists at `540-546`.
- **`tool_call` hook:** `index.ts:3113-3179`, with the `test_run` block at 3114.
- **Sub-agents:**
  - `runRole`: `index.ts:722-752` (view, metrics at 748, knowledge wiring at 731-737)
  - `transcript(ctx)`: 907-921
  - advisor resets `consecutiveErrors` at about 2871
- **Import edges:**
  - `subagent.ts:16-17` imports the `RoleSpec` type from `./config.ts` and `FORWARD_ENV` from `./mcp-forward.ts`. Only `index.ts`, `subagent.ts` and `mcp-forward.test.ts` use `mcp-forward`.
  - `test-run.ts:6-7` imports `mapLimit` and `ToolCall` from `subagent.ts`.
  - `runner-guard.ts:11-12` imports `readonly-bash.ts` and `repos.ts`.
- **Precedent for a cross-extension import:** `extensions/worktree/unity-guard.ts:2` imports `../workflow/readonly-bash.ts`.
- **Prompts** (`prompts.ts`):
  - `PACE` 7, `minorFixMessage` 18-20, `NO_SLEEP` 23, `batchLine` 28, `CHECKPOINTS` 37
  - `planPhase` 40-60, `PLAN_KICKOFF` 85, `finalize` 87-96, `SHOW_PLAN` 114-115
  - `EXECUTE_PHASE` 117, with the commit line at 131; `TEST_PHASE` 136
  - `RUNNER` 178, `EXPLORE` 207, `ADVISOR` 219, fix-round prompts 230-273
  - `JUDGE` 277-299, `JUDGE_RECHECK` 301-306, `COMMIT` 311
- **Plan approval:**
  - `approve()`: `index.ts:670-684`, with the finalize branch at 672-680 and the non-finalize branch at 681-684
  - typed "go": 3415-3417; typed approval: 3423-3430
  - finalize handling: 3500-3530, including the wait-check retry at 3505-3514 and execute start at 3521-3525
  - plan menu: 3540-3567
  - `APPROVED_FINAL`: `index.ts:212`
  - `isPlanReady`, `hasPlanLine`, `canApprove`: `agent-end.ts:39-56`
- **Minor-fix loop:**
  - `fixMinorFindings`: `index.ts:3979-3992`, called at 3761 and 3813
  - `afterPass`, `minorFixOpen`: `agent-end.ts:59-66`
  - `state.minorRounds`: `index.ts:120-122`
  - judge prompt assembly: `index.ts:1895-1916`
- **Handovers:**
  - `handover()`: `index.ts:3459`
  - `handoverAction`: `agent-end.ts:94`, called at `index.ts:3305`
  - handover sites: execute 3525, stage 3650, minor fix 3988, open steps 4083, test 2153/2162
  - `handoverCompactTokens`: 30000 (`config.ts:228`)
  - the guard: `index.ts:3274-3345`
- **Config** (`config.ts`):
  - defaults at 227-252: `maxMinorRounds` 231, `finalizePlan` 232, `planFlaw` 234, `planRecap` 238
  - legacy `returnToPlan` migration at 341-343
  - `supervisorBashAllow` 105/261; runner keys at 377
- **`/flow` menu:** about `index.ts:4245-4256` ("off - leave the workflow; model stays as is", "test [scope] …").

**Config and docs files**
- `pi/agent/workflow.json`:
  - roles 3-50: discuss `thinking: "high"` at line 4, `explore`, `test` at 40, `runner`
  - `maxMinorRounds` 53, `finalizePlan` 54, `planFlaw` 56, `planRecap` 61
  - `test` block from 105
  - `explore` 136-145, `advisor` 146-149
  - `knowledge` 173 (roles explore, advisor, judge, arbiter), `subagent` 193
- Workflow tests: the command at `README.md:215`.
- README sections:
  - test material: 30, 152, 217-248, 358
  - the approve menu: 35-38
- `docs/workflow-improvements.md`: next free IDs are A36, B15, C7, D29. Rules are in its "Keeping this file current" section.
- Tests that pin current behaviour:
  - `config.test.ts:193` (maxMinorRounds 3)
  - `delivery.test.ts:5,70` (`finalize`, `SHOW_PLAN`)
  - `agent-end.test.ts:17-22` (canApprove), 160-166 (afterPass), 190-198 (handoverAction)
  - `prompts.test.ts:68` (imports test-report), 187

### 4. Design
**Components**
- **`extensions/agents/`** (new, loaded automatically by Pi), containing:
  - `index.ts`: registers `explore`, `advisor` and `test_run`; loads `agents.json`; emits usage events
  - `subagent.ts` and `mcp-forward.ts`, moved
  - `test-run.ts` and `runner-guard.ts`, moved
  - `config.ts`, a loader with defaults
  - `prompts.ts`: `EXPLORE`, `ADVISOR`, `RUNNER`
  - the tests of the moved files
- **`extensions/workflow/`** keeps the phases, judge, arbiter, commit/`git_task`, deliver, the guards, metrics and the view.
  - It imports `runSubagent`, `mapLimit` and the types from `../agents/subagent.ts`.
  - `agents/runner-guard.ts` imports `../workflow/readonly-bash.ts` and `../workflow/repos.ts`, per the precedent.
  - `RoleSpec` moves to `agents/subagent.ts` (or an `agents/types.ts`), and `workflow/config.ts` re-exports it.

**Event contract**
- The agents extension emits:

  ```ts
  pi.events.emit("agents:subagent-finished", { role: "explore" | "advisor" | "runner", ms: number, usage: Usage, model: string, ok: boolean })
  ```

- While `state.phase !== "off"`, the workflow listens and:
  - adds the usage to the current stage's tokens (with `cfg.tokenWeights`)
  - writes a `kind: "subagent"` record to `metrics.jsonl`, in the same shape as today's `runRole` record
  - resets `consecutiveErrors` when the role is `advisor`
- Outside a flow the event is ignored.
- `agents` never imports workflow state.

**`agents.json` (`pi/agent/agents.json`)**
- Keys:
  - `roles`: `{ explore, advisor, runner }`, each `{ model, thinking }`
  - `explore`, `advisor`, `test` (runner settings) and `subagent`: the same shapes as today's `workflow.json` blocks
  - `knowledge`: the same shape, with `roles: ["explore", "advisor"]`
- Values are copied from `workflow.json`, except explore thinking, which becomes `"medium"`.
- `workflow.json` drops those keys. Its `knowledge.roles` becomes `["judge", "arbiter"]`.
- **Compatibility:** a missing `agents.json` uses the defaults in `agents/config.ts`. Old `workflow.json` keys for moved roles are ignored, and the workflow loader deletes them silently, the way `returnToPlan` is handled.

**Single plan**
- The planner's first `Plan:` reply uses the final format: `## Plan: <title>`, with either the short or the full template.
- Each later change reply contains a section that starts `## Plan changes`, listing the changed, added or removed steps by S-number.
- On approval:

  ```ts
  approvedPlan = lastFullPlan + "\n\n" + changeSections.join("\n\n")
  ```

  - `lastFullPlan` is the last reply matching `/^##\s*Plan:/m`.
  - `changeSections` are the `## Plan changes` sections written after it.
  - A new full `## Plan:` reply resets the list.
- The `Wait:` check, with its one retry message, runs when the plan-phase reply contains `## Plan:`. Approval is refused while it fails.
- `finalizePlan`, `planRecap`, `SHOW_PLAN` and `workflow-finalize` are removed. The old keys in a user config are ignored and deleted silently.

**Sync deletes**
- Each record entry gets an optional `deleted: true` (ISO time in `deletedAt`).
- A run computes its delete candidates first, then checks the cap:
  - `candidates > 20 || candidates > 0.25 * recordedFiles` with no `--allow-deletes` means: delete nothing, print the list and exit non-zero with a message naming the flag.
- `--dry-run` never deletes and prints `WOULD delete <path>` per candidate.
- **Failure handling:**
  - A failed unlink is a warning, and the record stays as it is.
  - Empty parent folders are removed only up to the mirror root, never the root itself.

**Phase tools**
- One table maps phase to active workflow tools:

  | Phase | Workflow tools |
  |---|---|
  | `off` | judge, git_task |
  | `discuss`, `plan` | judge |
  | `execute` | all |

- Tools owned by `agents/` (explore, advisor, test_run) are never removed by the workflow.
- The list is applied with `setActiveTools` on every phase change and when tools register late (`refilterTools`). Non-workflow tools are untouched, apart from the existing plan-phase edit/write block.
- The refusal hooks stay as a backstop.

**Scale**
- Up to about 600 recorded sync files. The 25% cap makes a mass delete impossible without the flag.
- One event per sub-agent run (tens per flow).

**Alternatives rejected**
- Keeping explore and advisor in workflow: they would be unusable in normal mode once phases filter tools.
- A rewrite-on-approve plan: this is exactly the double plan the user rejected.
- Deleting from the sync without a record: it can't tell a deletion from a file never synced.
- A `.bak` for deletes: it would regrow the pile.

### 5. Steps

Stay in `D:\works\pi-config`. Each stage works on its own `flow/` branch.

### Stage 1: AGENTS.md rulebook and flow speed, part 1

**S1.** Create the gitignored `D:\works\pi-config\local\sync.json`:

```json
{ "autoImportOnStart": false, "pullOnStart": false, "autoCommit": false, "autoPush": false, "autoSyncOnChange": false, "autoExportOnShutdown": false }
```

Why: a Pi restart or a second Pi session during the flow must not import, commit or push on the flow branch. The current session still has the old config loaded (`extension/index.ts:152`). Before every Deliver step, check `git log master..HEAD --format="%h %an %s"`. Report any sync commit (a subject starting with the sync's message) instead of silently delivering it.

**S2.** Rewrite `pi/agent/AGENTS.md` per D3, keeping the title and the "Applies in every repo. Project `AGENTS.md` files add to this." line.
- Sections: tool output budgets, delegation (explore / advisor / judge, with firm wording), pace (parallel calls, keep going, no long sleeps).
- Target about 1.5k characters. Remove sentences that only restate a tool's own description.
- Leave the repo-root `D:\works\pi-config\AGENTS.md` untouched.

**S3.** Deliver: merge — AGENTS.md rulebook.

**S4.** Minor-fix rounds (D15):
- Set `maxMinorRounds` to 1 in `workflow.json:53` and in the `config.ts:231` default. Update its doc comment.
- In the judge prompt assembly (`index.ts:1895-1916`), append a new exported `prompts.JUDGE_MAJOR_ONLY` when `state.minorRounds > 0` for the current stage. It is one sentence: after a minor-fix round, report only blocker and major findings, and leave out minor ones.
- `fixMinorFindings` (`index.ts:3979`) needs no other change; `afterPass` already stops at the cap.

**S5.** Single plan (D16, D18), as defined in Design:
- `planPhase` (`prompts.ts:40-60`):
  - Always ask for the first `Plan:` reply in the final format, and fold in the content of `finalize()` (`prompts.ts:87-96`), including the Commits item and the stage rules.
  - The template choice: the short template (Goal and non-goals, User decisions, Steps, Tests, Done when) unless the change adds or reshapes components, interfaces, data or concurrency, or is staged; otherwise the full template.
  - Later replies use `## Plan changes`.
- `approve()` (`index.ts:670-684`): use the non-finalize branch (681-684) with the composed plan, and send `APPROVED_FINAL`.
- Delete:
  - the finalize branch (672-680)
  - the `state.finalizing` path (3423-3430, 3500-3530), moving the wait-check retry to plan-reply time
  - `SHOW_PLAN` and the "Show the full plan" option (3551, 3559)
  - `finalize()`
  - the `finalizePlan` and `planRecap` keys (`config.ts:127, 140-141, 232, 238, 368`; `workflow.json:54, 61`)
  - the `returnToPlan` migration (`config.ts:131, 341-343`); old keys are ignored and deleted
- Keep `PLAN_KICKOFF` accurate.
- `canApprove` and `isPlanReady`: approval needs a `## Plan:` reply since the plan phase started.

**S6.** `workflow.json`:
- `"planFlaw": "auto"` at line 56
- discuss `"thinking": "medium"` at line 4

Keep `config.ts:234` defaulting to `"ask"` for other users. The menu (`index.ts:3549-3552`) then shows Approve, Back to discussion and Keep discussing. Update `README.md:35-38`.

**S7.** Handover compaction (D20):
- Add a `kind: "start" | "continue"` field to the `handoverAction` input (`agent-end.ts:94`).
- `"compact"` is returned only for `kind === "start"` above the threshold. `"continue"` returns `"send"` (or `"hold"` under the existing conditions).
- `handover()` (`index.ts:3459`) passes `"start"` for `workflow-execute` and `workflow-stage`, and `"continue"` for all others.
- The 140k guard is unchanged.

**S8.** Commits (D21):
- Change `EXECUTE_PHASE`'s commit line (`prompts.ts:131`): plain commits, pushes and PRs go through bash; `git_task` is only for conflicts, rebases and long split-commit sequences.
- Make the `git_task` description and `promptSnippet` (about `index.ts:2645-2650`) say the same.
- Check that the execute `tool_call` hook (`index.ts:3115-3159`) allows plain `git add`/`git commit`/`git push` (to a non-protected branch) and `gh pr create` in bash. If it refuses any of them, report that to the user rather than loosening guards.

**S9.** Update `README.md` and `docs/workflow-improvements.md` with new rows for S4–S8 (next free IDs per category), the Status line and the Effect-measurement rows. Measurements:
- judge runs per flow
- minor rounds per flow
- plan-phase minutes
- handover compactions per flow

**S10.** Deliver: merge — flow speed 5a.

### Stage 2: Sync deletes
**S11.** `bin/lib.js`: delete detection per D9–D11, next to the record code (`lib.js:361-426`), modelled on `editedInRepo`.
- One pure function returns `{ toDelete, keptEdited }` for a direction (`"export"` or `"import"`) from:
  - the record
  - the files present on the source and target sides
  - the target hashes
- JSON files are compared with the same scrub the export uses.
- A cap function: `tooMany(n, recorded) = n > 20 || n > 0.25 * recorded`.
- Replace the "never deletes" notes at `lib.js:10-13`.

**S12.** `bin/export.js` and `bin/import.js`: apply the deletions after copying.
- Honour `--dry-run` (`WOULD delete <path>`), `--allow-deletes` and the cap: over the cap without the flag, delete nothing, list the files and exit with code 2.
- Export marks the deleted record entries `deleted: true`. Import drops the record entries of files it deleted.
- Import removes empty parents up to, but not including, `~/.pi/agent`.
- No `.bak` for deletes. Warn for kept edited files.
- Update the notes at `export.js:9`, `import.js:9` and `README.md`.

**S13.** `extension/ready.ts` and `extension/index.ts`:
- `committableMirror` treats a missing file whose record says `deleted: true` as committable, and stages it with `git rm --cached`-style removal in the same pathspec commit (`extension/index.ts:245-267`).
- A missing file without that mark stays a hand edit.
- The extension shows the cap message as a warning notification when import or export exits with code 2.

**S14.** Run `node bin/import.js --dry-run` and `node bin/export.js --dry-run` against the real folders. Write every `WOULD delete` line, plus the cap result, to `D:\works\pi-config\local\delete-preview.txt`, and show them to the user in the reply.

**S15.** Wait: the user reads the paths in `local/delete-preview.txt` and confirms them by creating `local/deletes-reviewed.txt` (D12). The executor must never create this file itself, also under autopilot. (check: test -f D:/works/pi-config/local/deletes-reviewed.txt)

**S16.** Deliver: merge — sync deletes.

### Stage 3: agents extension
**S17.** Create `pi/agent/extensions/agents/`.
- `git mv` from `workflow/`:
  - `subagent.ts`, `mcp-forward.ts`, `test-run.ts`, `runner-guard.ts`
  - their tests (`subagent.test.ts`, `mcp-forward.test.ts`, `test-run.test.ts`, `runner-guard.test.ts`)
- Move the `RoleSpec` type as in Design.
- Fix the imports in both extensions. The only cross-imports are `agents → workflow/readonly-bash.ts, repos.ts` and `workflow → agents/subagent.ts, mcp-forward.ts`.

**S18.** `agents/config.ts` plus `pi/agent/agents.json`, per Design:
- Model the loader on `workflow/config.ts`: defaults, validation, unknown keys ignored.
- Explore thinking is `"medium"` (D4).
- Remove the moved keys from `workflow.json` and `workflow/config.ts`: the explore, advisor, test and runner roles; the `explore` and `advisor` blocks; the runner keys of `test`; `knowledge.roles` trimmed.

**S19.** `agents/index.ts`: register `explore` and `advisor`, moved from `workflow/index.ts:2245` and `2858`, together with:
- the sub-agent part of `runRole` (`index.ts:722-752`), including the knowledge wiring at 731-737
- `transcript(ctx)` (907-921)
- `EXPLORE_REASONS` (216)
- the `EXPLORE` and `ADVISOR` prompts
- the render functions

Behaviour, descriptions and parameters stay the same. Emit `agents:subagent-finished` after each run.

**S20.** `workflow/index.ts`:
- Remove the two tools.
- Keep `runRole` for judge, commit and arbiter, importing from `../agents/`.
- Add the `pi.events` listener per Design. Advisor's `consecutiveErrors` reset (about 2871) moves into it.

**S21.** Deliver: merge — agents extension, explore and advisor.

**S22.** Move `test_run` (`workflow/index.ts:2291` and its record helpers about 2026-2031 and 2328, 811-819) and the runner-guard registration into `agents/index.ts`.
- It works in every phase: cwd plus the session's added folders, and records in a temp folder when no plan exists.
- Remove the `test_run` block in the workflow hook (`index.ts:3114`).
- `RUNNER` and the runner config move to `agents/`.

**S23.** Update `README.md`: the workflow README sections on explore, advisor and test_run point to a short new `agents/README.md`.

**S24.** Deliver: merge — agents extension, test_run.

### Stage 4: Remove the test phase; normal-mode extras
**S25.** Remove the test phase (D8):
- `test-flow.ts`, `test-report.ts` and their tests; `prompts.test.ts:68` imports `test-report`
- `/flow test` and the `test` menu entry (about `index.ts:4251`)
- the `test` phase from the phase type and `STAGES`; the `test` role in `workflow.json:40`
- `switchRoundPhase` and the test branches of the active-tool filtering (`index.ts:540-546, 2112-2114`)
- the test hook branch (3163-3172), `onTestEnd` (about 3570), and the `index.ts` regions about 1905-1915, 1976-2218, 3105, 3748, 3909, 3926, 4062, 4444-4458
- the test-only `state.testFlow` parts of judge and arbiter prompts
- `TEST_PHASE`, `JUDGE_TEST`, `ARBITER_TEST`, the fix-round prompts (`prompts.ts:135, 230-273`), and `FIX_TESTS`, only if nothing outside the test loop uses it (check `FIX_MESSAGE` and `minorFixMessage` first)
- `supervisorBashAllow`, `testAllowedTools`/`testBlockedTools`, and the rest of the `test` block in `workflow.json` and `config.ts`
- the README sections at 30, 152, 217-248 and 358

A persisted state with `phase: "test"`, or with `tokens.test`, loads as `off` without errors.

**S26.** `/flow off` restores the model (D13):
- When a flow starts (leaving `off`), store `state.preFlowModel = { provider, id, thinking }`.
- `/flow off`, and the end of a flow back to `off`, restore it with the same calls `applyRole` uses, then clear it.
- If the model no longer exists, notify and keep the current one.
- Update the menu label (about `index.ts:4252`) to "off - leave the workflow; restore the model from before the flow".

**S27.** `git_task` in `off` (D14): its guard (`index.ts:2656`) allows phase `off` and execute. In `off` there is no judge gate on merges or protected pushes, matching the push and merge guards, which are already off outside a flow. Discuss and plan still refuse it.

**S28.** Docs rows (D24) for S25–S27.

**S29.** Deliver: merge — remove the test phase and normal-mode extras.

### Stage 5: Flow speed, part 2
**S30.** Per-phase tools (D22):
- Replace the plan/test filtering in `index.ts:519-556` with the phase → tools table from Design.
- Apply it in `setPhase` and `refilterTools`, never removing the `agents/` tools or non-workflow tools, except the existing `planBlockedTools` (edit, write) in discuss and plan.
- The hooks still refuse as before.

**S31.** Trim `prompts.ts` (D23):
- Remove the lines that restate the explore, advisor and judge tool descriptions (about lines 60, 79, 123, 124) and repeated `PACE`/`batchLine` text, keeping one copy per prompt.
- Send `CHECKPOINTS`' `Publish:`/`Mirror:` part only when `publishConfigured()` is true. That helper wraps the existing condition `publish_packages` uses to find a configured unity-packages repo.
- Record the per-turn prompt sizes in the docs row:
  - before: discuss about 1.9k, plan about 5k, execute about 6–7k characters
  - after: measured with a small script printing `planPhase(...)` and `EXECUTE_PHASE` lengths

**S32.** Docs rows for S30–S31. Update `README.md` for the tool tables per phase.

**S33.** Deliver: merge — flow speed 5b.

**S34.** Delete `local/sync.json`, `local/delete-preview.txt` and `local/deletes-reviewed.txt`, after looking at each (they are the files S1, S14 and S15 created). Check that `git -C D:/works/pi-config status --short` is clean on `master` and that master is up to date with origin.

**S35.** Verify: restart Pi in `D:\works\pi-config` — look for:
- the start-up import deletes exactly the files listed in S14 (`workflow/subagent.ts`, `test-flow.ts` and the others), without a cap warning
- `explore`, `advisor`, `judge`, `git_task` and `test_run` work with no flow
- `/flow discuss` then `/flow off` restores the model
- a small flow shows one plan, the three-option menu, and at most one minor-fix round

**S36.** Verify: on CuongPT-dev, after its next start — look for: the same deletions, and `hermes-memory-config.json` gone if it matched its record.

**S37.** Final report to the user, including the item-7 reminder:
- the 44–47 KB AGENTS.md files in game-template and shiny-loop
- ww-kanboard and rotating its token
- `video_frames`
- `.bak` pruning
- the worktree review
- sessions (104 MB)

### 6. Tests
**Commands**
- Workflow and agents: the `README.md:215` command, extended with `extensions/agents/*.test.ts` and with the removed files dropped.
  - Expected: all pass, 0 fail.
  - Fast while fixing: the single file, `node --experimental-strip-types --test <file>`.
- Sync:
  - `node bin/sync.test.js`
  - `node --experimental-strip-types --test extension/ready.test.ts`
  - Expected: all pass.
- No suite is expected to be slow (over 2 minutes).

**New or changed tests**
- **Minor rounds and the judge prompt:**
  - `config.test.ts`: `DEFAULTS.maxMinorRounds === 1`
  - `agent-end.test.ts`: `afterPass` gives `"fix"` at 0 rounds with findings, and `"commit"`/`"done"` at 1 round
  - `prompts.test.ts`: the judge prompt contains `JUDGE_MAJOR_ONLY` when `minorRounds > 0`, and not at 0 (test the exported assembly helper, extracting it from `index.ts` if needed)
- **Single plan:**
  - `agent-end.test.ts`: a composed plan from `## Plan:` plus two `## Plan changes` replies equals the full plan followed by both sections. A later `## Plan:` resets it. Approval is refused with no `## Plan:` reply.
  - `delivery.test.ts`: `finalize` and `SHOW_PLAN` are removed. `planPhase()` contains both template names and the `## Plan changes` rule.
  - `config.test.ts`: a config with `finalizePlan`/`planRecap`/`returnToPlan` loads without them and without errors.
- **Handover compaction:** `agent-end.test.ts` `handoverAction`:
  - `kind:"start"` with tokens 50k and threshold 30k → `"compact"`
  - `kind:"continue"` with the same → `"send"`
  - the existing hold cases still give `"hold"`
- **Sync deletes:** `bin/sync.test.js`, with temp folders:
  - export deletes a recorded, unchanged repo file that is gone locally, and marks the record deleted
  - export keeps an edited repo file and warns
  - import deletes a recorded, unchanged local file that is gone from the repo, and removes empty parents but not the root
  - import keeps an edited local file
  - no record → nothing deleted
  - 21 candidates → nothing deleted, exit 2; same with `--allow-deletes` → deleted
  - 26% of recorded files → refused
  - `--dry-run` prints `WOULD delete` and deletes nothing
  - a JSON file that differs only in scrubbed fields counts as unchanged
  - no `.bak` is created for deletes
- **Sync auto-commit:** `extension/ready.test.ts`: a missing file with a `deleted: true` record is committable; a missing file without it is not.
- **Agents extension:**
  - `agents/config.test.ts`: defaults with no file; explore thinking `"medium"`; unknown keys ignored
  - an event test: the workflow listener adds usage only while the phase is not `off`, and resets `consecutiveErrors` for the advisor (extract the listener body into a testable pure function)
- **Removed test phase:** the moved test files pass from their new location. A state with `phase: "test"` loads as `off` (in the state-loading test file).
- **Normal-mode extras:**
  - `preFlowModel` is saved on leaving `off` and cleared after restore
  - the `git_task` guard allows `off` and `execute`, and refuses `discuss` and `plan`
- **Tools per phase:** the phase → tool table gives the D22 sets, and never removes `explore`, `advisor` or `test_run`.

### 7. Done when
- All five stages are merged to `master` in order, each with a judge PASS on its tree.
- All workflow, agents and sync tests pass.
- D1–D24 hold in the code and config.
- `docs/workflow-improvements.md` has rows for every workflow change.
- The user approved the delete list (S15) before the sync-deletes merge.
- `local/sync.json` is removed at the end.
- The user gets the item-7 reminder in the final report.

### 8. Risks, rollback, what not to touch
**Risks**
- **This session's sync runs with the old config** and still auto-commits on the checked-out branch. S1 protects only new sessions. Check each branch for sync commits before delivering (S1).
- **The flow edits its own extension:** this session keeps the old code. Don't restart Pi before S34.
- **Stage 2's `bin/export.js` runs from the working tree** when this session's watcher exports. Commit the delete logic only with its tests passing. The record rule means nothing is deleted unless a live file is removed.
- **The move to `agents/`** loads a new extension, and a missing import breaks both. Run the full test command after S17 and after S20.

**Rollback:** each stage is one merge on `master`; revert its merge commit. Sync deletes can be stopped by setting `autoImportOnStart: false` in `local/sync.json`.

**Do not touch:**
- `pi/agent/mcp.json`
- the `knowledge` server config, other than splitting the roles
- `video_frames`
- the `worktree/` extension, other than import paths, if it imports moved files
- the repo-root `AGENTS.md`
- `auth.json`, `trust.json`, `models-store.json`
- sessions, `install/releases`

### 9. Commits
1. `docs: rewrite AGENTS.md as the normal-mode rulebook` — `pi/agent/AGENTS.md`
2. `workflow: one minor-fix round, then the judge reports blockers and majors only` — `config.ts`, `workflow.json`, `index.ts`, `prompts.ts`, `config.test.ts`, `agent-end.test.ts`, `prompts.test.ts`, `docs/workflow-improvements.md`
3. `workflow: single plan, no finalize rewrite; short template for small changes` — `prompts.ts`, `index.ts`, `agent-end.ts`, `config.ts`, `workflow.json`, `README.md`, `delivery.test.ts`, `agent-end.test.ts`, `config.test.ts`, docs
4. `workflow: arbiter settles plan flaws; discuss on medium thinking` — `workflow.json`, `README.md`, docs
5. `workflow: compact only at execute and stage starts` — `agent-end.ts`, `index.ts`, `agent-end.test.ts`, docs
6. `workflow: plain commits in bash, git_task for messy git jobs` — `prompts.ts`, `index.ts`, docs
7. `sync: propagate deletions using the sync record, with a safety cap` — `bin/lib.js`, `bin/export.js`, `bin/import.js`, `bin/sync.test.js`, `README.md`
8. `sync: auto-commit recorded deletions` — `extension/ready.ts`, `extension/index.ts`, `extension/ready.test.ts`
9. `agents: new extension with explore, advisor and the sub-agent runner` — `extensions/agents/*`, `pi/agent/agents.json`, `workflow/index.ts`, `workflow/config.ts`, `workflow.json`, moved tests, docs
10. `agents: move test_run and the runner guard; usable in every mode` — `extensions/agents/*`, `workflow/index.ts`, `workflow/config.ts`, `workflow.json`, READMEs, docs
11. `workflow: remove the test phase and its fix loop` — `workflow/*` (deleted files, `index.ts`, `prompts.ts`, `config.ts`, tests), `workflow.json`, `README.md`, docs
12. `workflow: /flow off restores the pre-flow model; git_task outside a flow` — `index.ts`, tests, `README.md`, docs
13. `workflow: activate only each phase's tools` — `index.ts`, tests, `README.md`, docs
14. `workflow: trim duplicate prompt text; publish syntax only where configured` — `prompts.ts`, `prompts.test.ts`, docs

## Amendment 1 (executor: autopilot)
Read local/delete-preview.txt (0 WOULD delete lines today) and create local/deletes-reviewed.txt to approve the sync-deletes merge (PR #22). (step S15, act)


<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create the gitignored `D:\works\pi-config\local\sync.json`:
- [x] S2 Rewrite `pi/agent/AGENTS.md` per D3, keeping the title and the "Applies in every repo. Project `AGENTS.md` files add to 
- [x] S3 Deliver: merge — AGENTS.md rulebook.
- [x] S4 Minor-fix rounds (D15):
- [x] S5 Single plan (D16, D18), as defined in Design:
- [x] S6 `workflow.json`:
- [x] S7 Handover compaction (D20):
- [x] S8 Commits (D21):
- [x] S9 Update `README.md` and `docs/workflow-improvements.md` with new rows for S4–S8 (next free IDs per category), the Status 
- [x] S10 Deliver: merge — flow speed 5a.
- [ ] S11 `bin/lib.js`: delete detection per D9–D11, next to the record code (`lib.js:361-426`), modelled on `editedInRepo`.
- [ ] S12 `bin/export.js` and `bin/import.js`: apply the deletions after copying.
- [ ] S13 `extension/ready.ts` and `extension/index.ts`:
- [ ] S14 Run `node bin/import.js --dry-run` and `node bin/export.js --dry-run` against the real folders. Write every `WOULD delet
- [ ] S15 Wait: the user reads the paths in `local/delete-preview.txt` and confirms them by creating `local/deletes-reviewed.txt` 
- [ ] S16 Deliver: merge — sync deletes.
- [ ] S17 Create `pi/agent/extensions/agents/`.
- [ ] S18 `agents/config.ts` plus `pi/agent/agents.json`, per Design:
- [ ] S19 `agents/index.ts`: register `explore` and `advisor`, moved from `workflow/index.ts:2245` and `2858`, together with:
- [ ] S20 `workflow/index.ts`:
- [ ] S21 Deliver: merge — agents extension, explore and advisor.
- [ ] S22 Move `test_run` (`workflow/index.ts:2291` and its record helpers about 2026-2031 and 2328, 811-819) and the runner-guard
- [ ] S23 Update `README.md`: the workflow README sections on explore, advisor and test_run point to a short new `agents/README.md
- [ ] S24 Deliver: merge — agents extension, test_run.
- [ ] S25 Remove the test phase (D8):
- [ ] S26 `/flow off` restores the model (D13):
- [ ] S27 `git_task` in `off` (D14): its guard (`index.ts:2656`) allows phase `off` and execute. In `off` there is no judge gate o
- [ ] S28 Docs rows (D24) for S25–S27.
- [ ] S29 Deliver: merge — remove the test phase and normal-mode extras.
- [ ] S30 Per-phase tools (D22):
- [ ] S31 Trim `prompts.ts` (D23):
- [ ] S32 Docs rows for S30–S31. Update `README.md` for the tool tables per phase.
- [ ] S33 Deliver: merge — flow speed 5b.
- [ ] S34 Delete `local/sync.json`, `local/delete-preview.txt` and `local/deletes-reviewed.txt`, after looking at each (they are t
- [ ] S37 Final report to the user, including the item-7 reminder:
## For you after the flow
- S35 Verify: restart Pi in `D:\works\pi-config` — look for:
- S36 Verify: on CuongPT-dev, after its next start — look for: the same deletions, and `hermes-memory-config.json` gone if it 
