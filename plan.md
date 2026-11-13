<!-- pi-workflow plan v1 flow=20261113-1842-remove-the-orchestrator-s-false-alarms-d-8685 -->
## Plan: Remove the orchestrator's false alarms (drift/overlap and wait escalations)

Stages: 1. Monitor false alarms: porcelain parsing and a diff target for each run (fixes 1 and 2, D39). 2. Waits: a new wait ends the old ask, and `external` waits are parked (fixes 3 and 4, D40).

### 1. Goal and non-goals
**Goal:** in an orchestrated run, the orchestrator and the user get no drift, overlap or wait alarms that aren't real. Real drift (a sub editing paths it doesn't own) and waits that need a person still get reported and escalated as today.

**Non-goals:**
- No `git fetch` while polling.
- `decide.ts:40` stays as it is: resuming a wait by hand still needs a quote from the user.
- No guessing at sibling waits from the check text.
- A menu never makes another item stale.
- `manual` stays dropped when a flow resumes from its status file (today's behaviour).
- No change to `items.ts` reminder or escalation timings for other item kinds.

### 2. User decisions
- **D1:** Fix 1. Read `git status` with `--porcelain=v1 -z`, untrimmed, and parse it with a pure parser.
- **D2:** Fix 2. `run.targets` holds one target per repo, set at `orch_run`. It comes from each repo's own orchestrator checkout upstream, or from an optional `orch_run` `targets` parameter, which is checked. The result prints it. A detached HEAD or no upstream falls back to today's order.
- **D3:** Fix 3. A `setWaiting` helper in the workflow ends the old wait's ask at every place that assigns `state.waiting`. The orchestrator's rule that a new wait makes the old wait stale is only a safety net. Menus are left alone.
- **D4:** Fix 4. A new `wait_for_user` kind, `external`. It needs a check and pauses under autopilot without `manual`. Wait payloads carry `waitKind` and `checkStatus`. Only `external` + check + `pending` is parked; a missing field means escalate. `waitLimitMs` picks `wait.claimedMaxMs` or `wait.maxMs`, and a lost claim falls back to `maxMs`. `waitKind` survives a resume. The orchestrator ends a parked wait early by sending the sub a message.
- **D5:** Acceptance against run `o11131503`:
  - a raw replay: 14 escalations, 0 live items left;
  - an upgraded replay: 0 escalations, 0 live;
  - the drift fixture;
  - a live check on both worktrees: 0 drift and 0 overlap.
- **D6:** Docs rows D39 and D40 in `docs/workflow-improvements.md`, with the Status line and Effect measurement rows, in the same commits.

**Planner choices (the user said "go" without answering these):**
- `wait.claimedMaxMs` defaults to 4 h (14 400 000 ms).
- The kind is named `external`, because it covers a PR, CI or a release, not only another package.

### 3. Facts
Paths below are relative to `pi/agent/extensions/`.

**Orchestrator, polling (`orchestrate/index.ts`):**
- `git()` trims stdout (`:47-54`).
- `pollGit` reads porcelain and does `l.slice(3)` (`:1086-1091`). `porcelainHash` is at `:1095`. `prefix()` is at `:879`.
- `diffBase` is at `:1043-1062`.
- Stall suppression uses `liveItems` (`:1117-1118`).

**Orchestrator, `orch_run` and spawn (`orchestrate/index.ts`):**
- `orch_run` schema and execute are at `:1226-1270`. `sessionRepos` gives `run.repos` with each repo's `top`.
- Spawn sets `sub.base`/`worktrees` at `:1320-1339`.
- `Run` is in `orchestrate/brief.ts:31-44`. A single-repo run uses the working key `""` (`repos.ts:74`).

**Orchestrator, items and view:**
- `openItem` is in `orchestrate/items.ts:127-175`:
  - wait item creation is at `:129-135`;
  - a resend with the same live ref is a no-op at `:149-150`;
  - accept-request supersede is at `:153`, the model for the safety net;
  - every wait escalates at `:160`.
- `tick` is at `items.ts:179-190`. `isLive`/`liveItems` are at `:82-83`, `waitingForUser` at `:86`, `idleAllowed` at `:267`.
- `askText` is at `index.ts:768-777`. The escalated-item text is at `:732-748`. `ask`/`ask-done` handling is at `:910-918`.
- In `view.ts`, `Pending` is at `:11-20`, `pendingFromItems` at `:87-96`, `waitingForUser` at `:161` and `pendingMark` at `:183-190`.
- `kickoffText` rules are at `brief.ts:218-230`.

**Workflow:**
- The `state.waiting` type is at `workflow/index.ts:176`. Assignment sites:
  - `:2284` (`wait_for_user`)
  - `:2376` (publish)
  - `:2860` (tag)
  - `:3441` (stage `after:`)
  - `:1866` (resume from the status file, already preceded by `endWaitAsk()` at `:1855`)
- `endWaitAsk` is at `:2092`, `askWait` at `:2098`, `sendWaitAsk` at `:2110` and `reaskWait` at `:2137`.
- `reaskWait` callers:
  - `:2167`: a check fails after a resume.
  - `:2185`: polling stopped.
  - `:2199`: the check is broken.
  - `:2214`: the check passed with `autoResume` off.
- `waitTick` uses `cfg.wait.maxMs` at `:2180`, `:2184` and `:2186`. `startWaitTimer` sets `waitTimerStart` at `:2045-2049`.
- `wait_for_user` schema and execute are at `:2228-2290`: verify returns early at `:2245`, and the autopilot branch at `:2272` checks `!params.manual`.
- The restart path is at `:4107-4115`: the timer restarts, then `restoreAsks` and `sendWaitAsk(ctx, state.waiting)`.
- The status record writer is at `:1570`, and its type is in `workflow/plan-doc.ts:167`.
- `waitPayload` and `WaitInfo` are in `workflow/asks.ts:53-61`, and `restoreAsks` is at `asks.ts:118-123`.
- `pollDecision` is in `workflow/waits.ts:124-127`.
- Config: `workflow/config.ts:52` (type), `:191` (defaults), `:294` (number checks).

**Tests and docs:**
- Tests run with `node --experimental-strip-types --test <file>` from each extension folder (header of `orchestrate/paths.test.ts`).
- The run's evidence is in `D:/works/annamites/city-bus-flow/.git/pi/orchestra/o11131503-port-the-remaining-p/`. All 14 waits were `wait_for_user` calls with `manual: true` and a check. Asks `:2, :4, :6, :8, :9, :11, :13` never got an `ask-done`, because a second `wait_for_user` overwrote the wait.
- The last D row in `docs/workflow-improvements.md` is D38: the backlog row is at `:153`, the Effect row at `:229` and the Status line at `:5`.

### 4. Design
**Diff target (stage 1):**
- `Run.targets?: Record<string, string>` maps a repo key to a remote ref such as `origin/feat/new-gameplay`. It is stored once per run; nothing goes on `Sub` or `Worktree`.
- `diffBase` order, as a pure helper `pickDiffBase({ viaTarget, viaHead, viaName, spawn })`: merge-base with the target, then `origin/HEAD`, then the `gh` default branch, then the commit at spawn time.
- Old runs have no `targets`, so they keep today's behaviour.
- This design stops working when packages in one run target different branches of the same repo. That isn't supported now.

**Wait payload (stage 2):**
- The `wait` object adds `waitKind?: "external"` and `checkStatus: "pending" | "stopped" | "broken" | "passed"`, sent only when the wait has a check. An example of what a new sub sends:
  `wait: { reason, check, manual, waitKind: "external", checkStatus: "pending" }`
- `checkStatus` by situation:

| Situation | `checkStatus` |
|---|---|
| First ask | `pending` |
| A failed check after a resume (`:2167`) | `pending` |
| A resend after a restart (`:4115`) | `pending`, or `passed` when `w.checkPassed` |
| Polling stopped (`:2185`) | `stopped` |
| Check broken (`:2199`) | `broken` |
| Check passed, `autoResume` off (`:2214`) | `passed` |

**Item (stage 2):**
- `Item` adds `waitKind?: "external"`, `checkStatus?: string` and `parked?: true`.
- An item is parked when it is a `wait`, `waitKind === "external"`, the payload has a check, and `checkStatus === "pending"`. `manual` is ignored for parking.
- A parked item stays `state: "open"`, so it is live and stall suppression still applies. `tick` skips it.
- Everything else escalates as today. That includes a missing `waitKind` or `checkStatus`, which is how older subs behave.
- A parked wait polls for up to `claimedMaxMs`. It ends in one of three ways:
  - the check passes;
  - the sub sends a `stopped` re-ask, which escalates;
  - the orchestrator sends the sub a message, and the sub re-waits or moves on.

**Rejected:**
- Parking every wait that has a check: an Editor wait with a check would be hidden from the user.
- Guessing from the check text: fragile.
- A timer on the orchestrator side: it could disagree with the sub's own polling limit.

### 5. Steps

### Stage 1: Monitor false alarms
**S1.** `orchestrate/paths.ts`: add `parsePorcelainZ(out: string): string[]`, a pure function.
- Split the output on `\0` and drop empty entries.
- Each entry is `XY<space>path`; the path is `entry.slice(3)`. The input is untrimmed, so the leading space of the status is still there.
- When X is `R` or `C`, the next entry is the old path: skip it.
- No unquoting is needed with `-z`.

**S2.** `orchestrate/index.ts:47`: add `gitRaw(cwd, ...args)`, the same as `git()` but without `.trim()`. In `pollGit` (`:1086-1091`):
- read status with `gitRaw(wt.cwd, "status", "--porcelain=v1", "-z")`;
- take the dirty files from `parsePorcelainZ`;
- keep hashing the raw output into `por` and `porcelainHash`.

**S3.** `orchestrate/brief.ts` `Run`: add `targets?: Record<string, string>` with a doc comment ("the remote ref the packages' PRs go into, per repo key; drift and overlap are measured from the merge base with it").

**S4.** `orchestrate/index.ts` `orch_run` (`:1226`): add an optional parameter `targets: string[]`. Each entry is either `branch`, for the working repo, or `key:branch`.
- **Default for each repo key** (`""` for a single-repo run; otherwise each `run.repos` key), resolved in that repo's orchestrator-side checkout (`top`, or the repo's `top`):
  - `git rev-parse --abbrev-ref --symbolic-full-name @{u}`;
  - else, if the branch name `git rev-parse --abbrev-ref HEAD` isn't `HEAD`, and `git rev-parse --verify --quiet refs/remotes/origin/<branch>` succeeds, use `origin/<branch>`;
  - else no target.
- **A given target:** it is stored as `origin/<branch>` and must pass `git rev-parse --verify --quiet origin/<branch>` in that checkout. Otherwise `orch_run` throws before writing anything: `target <entry> not found in <key or "the working repo">: fetch it or fix the name`. An unknown key also throws.
- **Result text:** add a line for each repo, either `Diff target (<key or working repo>): origin/x` or `No diff target for <key>: drift is measured against the default branch`.
- Store the targets in `run.json` with the run.

**S5.** `orchestrate/repos.ts` (next to `worktreesOf`): add `pickDiffBase(c: { viaTarget?: string | null; viaHead?: string | null; viaName?: string | null; spawn?: string }): string | undefined`, returning the first value that isn't empty in that order.
- In `index.ts` `diffBase` (`:1043`), first try `git merge-base HEAD <run.targets?.[wt.key]>` when a target exists, then the existing order.
- The `gh` default-branch lookup stays lazy: it runs only when the target and `origin/HEAD` both give nothing.
- Update the doc comment.

**S6.** `orchestrate/README.md`: one line in the `run.json` layout about `targets`, and one sentence that drift and overlap are measured from the merge base with the run's target.

**S7.** `docs/workflow-improvements.md`:
- Add row D39 after D38, with the same columns: "Monitor false alarms: the porcelain first path lost its first letter (trimmed output and `slice(3)`), and drift was measured against `origin/HEAD` and not against the branch the PRs go into", with a **Done:** note naming `paths.ts parsePorcelainZ`, `repos.ts pickDiffBase` and `run.targets`.
- Add D39 to the Status line.
- Add an Effect measurement row: "drift and overlap events per orchestrated run | count `drift:`/`overlap:` lines in `orchestrate-events` messages of the orchestrator session | 0 for owned files".

### Stage 2: Waits
**S8.** `workflow/index.ts`: add `setWaiting(next: FlowState["waiting"])`.
- If `state.waiting?.askId` is set, call `endWaitAsk(state.waiting)`, delete the old id from `claimedWaits` and call `stopWaitTimer()`.
- Then assign `next`.
- Use it at `:2284`, `:2376`, `:2860`, `:3441` and `:1866`. The `:1866` site is already safe because of `:1855`; it goes through the helper so there is one place.
- No other code assigns a wait object to `state.waiting`. Clearing (`= undefined` in `clearWait` and similar) stays as it is.

**S9.** `workflow/asks.ts`:
- `WaitInfo` adds `waitKind?: "external"`.
- `waitPayload(id, w, detail?, checkStatus?)` puts `waitKind` and `checkStatus` into `wait`, `checkStatus` only when `w.check` is set.
- `restoreAsks` copies `waitKind` into `resendWait.wait`.
- Export the type `CheckStatus = "pending" | "stopped" | "broken" | "passed"`.

**S10.** `workflow/index.ts` `sendWaitAsk`: add an optional `checkStatus` parameter.
- The default is `w.checkPassed ? "passed" : "pending"`.
- Pass it through on the `tries + 1` re-send.
- `reaskWait(ctx, w, detail, checkStatus)` passes it on. The callers pass `"pending"` (`:2167`), `"stopped"` (`:2185`), `"broken"` (`:2199`) and `"passed"` (`:2214`).
- The restart path (`:4115`) uses the default.

**S11.** `workflow/index.ts` `wait_for_user` (`:2228`):
- Add `Type.Literal("external")` to `kind`. Its description: "external: nothing for a person; another package's PR, CI or a release; the check resumes it; needs a check".
- Without a check, refuse with `kind "external" needs a check. Nothing changed.`
- The autopilot branch (`:2272`) is skipped for `external`, so it pauses without `manual`.
- Store `waitKind: "external"` in `state.waiting`. Add the field to the type at `:176`.
- The verify and approve/act paths are unchanged.

**S12.** Persist `waitKind` across a resume:
- `workflow/plan-doc.ts:167` adds `waitKind?: "external"`;
- the writer at `index.ts:1570` writes it;
- the resume at `:1866` reads it back.

**S13.** `workflow/waits.ts`: add `waitLimitMs(claimed: boolean, w: { maxMs: number; claimedMaxMs: number }): number`.
- In `waitTick`, compute `const limit = waitLimitMs(waitClaimed(w), cfg.wait)` once and use it at `:2180`, `:2184` and `:2186`.
- In `workflow/config.ts`, add `claimedMaxMs: number` to the type (`:52`), the default `14_400_000` (`:191`), and the number check (`:294`).
- When the claim is lost (`askAnswer` → `local`), the limit falls back to `maxMs` from the same `waitTimerStart`, and the existing local notice branch fires on the next tick.

**S14.** `orchestrate/items.ts`:
- `Item` adds `waitKind?`, `checkStatus?` and `parked?: true`.
- In `openItem` (`:129-135`), copy `m.data.wait.waitKind` and `m.data.wait.checkStatus`. Set `parked` when the rule in Design holds.
- **Safety net:** next to the accept-request supersede (`:153`), when the new item is a `wait`, set `stale` on that sub's other live `wait` items. Add the comment `// safety net: the workflow ends the old ask itself (setWaiting)`.
- **Escalation reasons, replacing `:160`:**
  - parked: no escalation;
  - `stopped`: `the sub stopped checking "<check>"`;
  - `broken`: `its check can't run`;
  - `passed`: `the check passed; the sub waits for a person to resume it (autoResume is off)`;
  - otherwise: `a wait always needs a person`, as today.
- `tick` (`:181`): skip `parked` items.

**S15.** `orchestrate/index.ts` `askText` (`:770`): for a parked wait, send one line with no "escalated" or "Answer it with" text:
`[<sub>] waits (resumes by itself when its check passes: <check>): <reason>. Nothing to answer; to end it early, send it a message with orch_send.`
Waits that aren't parked keep today's text.

**S16.** `orchestrate/view.ts`:
- `Pending` adds `parked?: true`, and `pendingFromItems` passes it on.
- `pendingMark` shows a parked wait as `wait (resumes itself)`.
- `waitingForUser` stays as it is (escalated only).

**S17.** `orchestrate/brief.ts` `kickoffText` (`:224-227`): add a rule:
`- To wait on another package's PR, CI or a release, call wait_for_user with kind "external" and a read-only check (for a PR: gh pr list --base <target> --head <branch> --state merged ...). It does not go to the user. If the orchestrator sends you a message while you wait, act on it, then wait again or move on.`

**S18.** `orchestrate/README.md`: a short paragraph on parked waits. `docs/workflow-improvements.md`:
- Add row D40: "A wait set over an open wait never ended its ask (7 of 14 waits in run o11131503 stayed escalated), and every wait was escalated, also one on another package's merge", with a **Done:** note naming `setWaiting`, the `external` kind, `checkStatus`, `claimedMaxMs` and parking in `items.ts`.
- Add D40 to the Status line.
- Add an Effect measurement row: "escalations per orchestrated run, and parked waits that ended by their check | count `escalated` items and parked items closed by `ask-done` in `items.json` | 0 escalations for waits on other packages". Note in the row that it feeds A48.

### 6. Tests
**Stage 1:**
- `orchestrate/paths.test.ts`, `parsePorcelainZ`:
  - `" M unity/a.cs\0?? b.txt\0"` gives `["unity/a.cs","b.txt"]`;
  - a rename `"R  new.cs\0old.cs\0"` gives `["new.cs"]`;
  - a path with a space;
  - an empty input gives `[]`;
  - the drift fixture: `" M unity/Assets/_Project/Scripts/NewGameplay/Core/FailReason.cs\0"` parses to the full path, and `outsideOwned` with core's `owns` and `forbids` (copy the globs from that run's `run.json`) returns `[]`.
- `orchestrate/repos.test.ts`, `pickDiffBase`: the target wins; with no target `viaHead` is used, then `viaName`, then `spawn`; all empty gives `undefined`.
- Commands, expect all pass:
  `cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test *.test.ts`
- **Live check, run once and not committed:** a throwaway node script outside the repo. For `D:/works/annamites/wt/o11131503-core/city-bus-flow` and `.../o11131503-view/city-bus-flow`, it:
  - runs `git merge-base HEAD origin/feat/new-gameplay`, `git diff --name-only <base>...HEAD`, and `git status --porcelain=v1 -z` parsed with `parsePorcelainZ`;
  - applies `outsideOwned` with each sub's `owns`/`forbids` from that run's `run.json`;
  - intersects the two file lists.

  Expected: 0 files outside for both and an empty intersection. At planning time core had 4 files and view had 1. If a worktree is gone, say so in the report.

**Stage 2:**
- `workflow/asks.test.ts`:
  - `waitPayload` carries `waitKind` and `checkStatus`;
  - there is no `checkStatus` without a check;
  - `restoreAsks` keeps `waitKind`.
- `workflow/waits.test.ts` (or the file where `pollDecision` is tested), `waitLimitMs`:
  - claimed gives 4 h and unclaimed gives 1 h;
  - `pollDecision` with `elapsedMs` 90 min returns `"run"` under the claimed limit and `"stop"` under the unclaimed one (the claim-lost case).
- `workflow/config.test.ts`: `claimedMaxMs` defaults to 14 400 000, and a bad value falls back to it.
- Workflow wiring, in the test file that covers `wait_for_user`/`index.ts` behaviour, or as pure helpers taken out of the handlers if no such harness exists:
  - `wait_for_user` while a wait is set sends `workflow:ask-done` for the old id, then `workflow:ask` with a new id;
  - a stage `after:` wait over an open wait does the same;
  - `kind: "external"` without a check is refused;
  - `kind: "external"` under autopilot pauses (sets `state.waiting`) without `manual`;
  - a resume from a status record with `waitKind: "external"` sends a payload with `waitKind: "external"` and `checkStatus: "pending"`.
- `orchestrate/items.test.ts`:
  - an `external` + check + `pending` wait is parked: not escalated, and no reminder or escalation after `tick` over 31 min with the orchestrator idle;
  - `stopped`, `broken` and `passed` each escalate with their reason;
  - a wait with no `waitKind`, a manual `act` wait, and a wait with no check each escalate;
  - a parked item is in `liveItems(file, sub)`, which is what holds back `stalled`;
  - `idleAllowed("executing", { plan: false, ask: true, question: false, accept: false })` is false (a sub with a parked wait still has its ask open);
  - safety net: wait `:4` then wait `:5` leaves `:4` stale, and `waitingForUser` no longer lists it; a menu after a wait leaves the wait live.
- **Replay** (`orchestrate/items.test.ts`): build the run's view sequence in the test:
  - `ask 1`, `done 1`, `ask 2`, `ask 3`, `done 3`, `ask 4`, `ask 5`, `done 5`, `ask 6`, `ask 7`, `done 7`, `ask 8`, `ask 9`, `ask 10`, `done 10`, `ask 11`, `ask 12`, `done 12`, `ask 13`, `ask 14`, `done 14`;
  - each ask is a wait with `manual: true` and a check;
  - feed it through `openItem` and `close`.

  Expected:
  - Raw: 14 escalate actions, 0 live items at the end.
  - Upgraded (`waitKind: "external"`, `checkStatus: "pending"` added to each): 0 escalate actions, 0 live items at the end.
- `orchestrate/view.test.ts`: a parked wait gives `Pending.parked`, `pendingMark` `wait (resumes itself)`, and isn't counted in `waitingForUser`.
- `orchestrate/brief.test.ts`: `kickoffText` contains `kind "external"`.
- Commands, expect all pass:
  - `cd pi/agent/extensions/orchestrate && node --experimental-strip-types --test *.test.ts`
  - `cd pi/agent/extensions/workflow && node --experimental-strip-types --test *.test.ts`

### 7. Done when
- The acceptance in D5 holds: the drift fixture, the live check (0 drift, 0 overlap), and the raw and upgraded replays (14 escalations / 0 live; 0 escalations / 0 live).
- All orchestrate and workflow tests pass.
- `orch_run` prints the diff target for each repo and refuses a target that doesn't exist.
- A `wait_for_user` over an open wait ends the old ask.
- An `external` pending wait is parked; `stopped`, `broken`, `passed`, manual, unknown-kind and no-check waits escalate.
- `waitKind` survives a resume.
- D39 and D40 are in `docs/workflow-improvements.md`, with the Status line and Effect rows.

### 8. Risks, rollback, what not to touch
- **Risk:** `setWaiting` changes wait handling for every workflow session, not only orchestrated ones. For a local wait, the extra `ask-done` has no listener, so nothing changes.
- **Risk:** an orchestrator on old code that receives new payloads ignores the extra fields and escalates as today.
- **Risk:** a wrong `@{u}` target shows up in the `orch_run` result and can be overridden with `targets`.
- **Rollback:** revert each stage's commit. `run.targets` and the new item fields are optional, so old and new files stay readable both ways.
- **Don't touch:** `decide.ts`, `monitor.ts` `check()` logic, menu handling (`askMenu`), the reminder and escalation timings in `items.ts` for other kinds, and the city-bus-flow run files (read only).

### 9. Commits
1. **Stage 1:** `orchestrate: parse porcelain with -z and measure drift from the run's target branch`. Files: `orchestrate/paths.ts`, `paths.test.ts`, `repos.ts`, `repos.test.ts`, `index.ts`, `brief.ts`, `README.md`, `docs/workflow-improvements.md` (D39).
2. **Stage 2:** `workflow+orchestrate: a new wait ends the old ask; external waits are parked`. Files:
   - `workflow/index.ts`, `asks.ts`, `asks.test.ts`, `waits.ts`, its test, `config.ts`, `config.test.ts`, `plan-doc.ts`, and the workflow wiring tests;
   - `orchestrate/items.ts`, `items.test.ts`, `index.ts`, `view.ts`, `view.test.ts`, `brief.ts`, `brief.test.ts`, `README.md`;
   - `docs/workflow-improvements.md` (D40).

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 `orchestrate/paths.ts`: add `parsePorcelainZ(out: string): string[]`, a pure function.
- [ ] S2 `orchestrate/index.ts:47`: add `gitRaw(cwd, ...args)`, the same as `git()` but without `.trim()`. In `pollGit` (`:1086-1
- [ ] S3 `orchestrate/brief.ts` `Run`: add `targets?: Record<string, string>` with a doc comment ("the remote ref the packages' P
- [ ] S4 `orchestrate/index.ts` `orch_run` (`:1226`): add an optional parameter `targets: string[]`. Each entry is either `branch
- [ ] S5 `orchestrate/repos.ts` (next to `worktreesOf`): add `pickDiffBase(c: { viaTarget?: string | null; viaHead?: string | nul
- [ ] S6 `orchestrate/README.md`: one line in the `run.json` layout about `targets`, and one sentence that drift and overlap are 
- [ ] S7 `docs/workflow-improvements.md`:
- [ ] S8 `workflow/index.ts`: add `setWaiting(next: FlowState["waiting"])`.
- [ ] S9 `workflow/asks.ts`:
- [ ] S10 `workflow/index.ts` `sendWaitAsk`: add an optional `checkStatus` parameter.
- [ ] S11 `workflow/index.ts` `wait_for_user` (`:2228`):
- [ ] S12 Persist `waitKind` across a resume:
- [ ] S13 `workflow/waits.ts`: add `waitLimitMs(claimed: boolean, w: { maxMs: number; claimedMaxMs: number }): number`.
- [ ] S14 `orchestrate/items.ts`:
- [ ] S15 `orchestrate/index.ts` `askText` (`:770`): for a parked wait, send one line with no "escalated" or "Answer it with" text
- [ ] S16 `orchestrate/view.ts`:
- [ ] S17 `orchestrate/brief.ts` `kickoffText` (`:224-227`): add a rule:
- [ ] S18 `orchestrate/README.md`: a short paragraph on parked waits. `docs/workflow-improvements.md`:
