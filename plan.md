<!-- pi-workflow plan v1 flow=20261101-1604-fix-the-open-findings-from-the-pi-setup-f65a -->
## Plan: Fix the open findings from the Pi setup flow

### 1. Goal and non-goals
**Goal:** fix every open minor finding left from the "trim and speed up the Pi setup" flow, each with a test or a recorded contract. Nothing else changes behaviour. End with a report that reminds the user of item 7.

**Non-goals (item 7, later):**
- the 44–47 KB `AGENTS.md` files in game-template and shiny-loop
- ww-kanboard / `mcp.json` and rotating its token
- `video_frames`
- `.bak` pruning
- the worktree review
- cleaning up sessions
- `hermes-memory-config.json` on CuongPT-dev
- changing `startPhase`
- moving `view.ts` out of `workflow/`

### 2. User decisions
- D1. Fix all open findings in one flow and merge them, then remind the user of the item-7 list.
- D2. One branch, one PR, one commit per function.
- D3. `agents/` keeps importing `workflow/view.ts`. The import is recorded in the workflow README "Public contract"; the code does not move.
- D4. The knowledge helpers (`toolPrefix`, `WRITE_TOOLS`, `roleTools`, `forwardedServers`), `knowledgeTools` and `PACE` move into `agents/`. `workflow` re-exports them.
- D5. The plan-wait retry flag resets when a plan's wait checks are clean, not each time a new full plan arrives.
- D6. One docs row, B15 ("follow-up fixes"), plus the Status line and an Effect-measurement row.

### 3. Facts the executor needs
- `FlowView.addFinished`, `pi/agent/extensions/workflow/view.ts:444-448`, calls `add`. `add` (`view.ts:474-493`) only sets `sub.runs ||= 1` and `bySub.runs ||= 1`, so every finished sub-agent shows as `×1`.
  - Model to follow: `view.ts:396-399`, which raises `sub.runs++` and `bySub.runs++` with the key `modelKey(run.model)`.
  - `shortModel` is at `view.ts:160`.
- The `agents/` imports from `workflow/`:
  - `agents/index.ts:26` `FlowView, RunView, shortModel` from `../workflow/view.ts`
  - `agents/index.ts:27` `forwardedServers, roleTools` from `../workflow/knowledge.ts`
  - `agents/index.ts:28` `knowledgeTools` from `../workflow/prompts.ts`
  - `agents/index.ts:29` `uniqueRoots` from `../workflow/repos.ts`
  - `agents/prompts.ts:3` `PACE` from `../workflow/prompts.ts`
  - `agents/render.ts:6` `RunView, runLine` from `../workflow/view.ts`
  - `agents/runner-guard.ts:11-12` `commandReadOnlyProblem, KEYWORDS, parseCommands, unwrapCommand` from `readonly-bash.ts`, and `repoKey` from `repos.ts`
- The knowledge helpers live in `workflow/knowledge.ts:20-46`: `toolPrefix`, `WRITE_TOOLS`, `roleTools`, `forwardedServers`.
  - `KnowledgeConfig` already lives in `agents/types.ts:12`.
  - `workflow/prompts.ts:4` imports `toolPrefix` from `./knowledge.ts`.
  - `knowledgeTools` is `workflow/prompts.ts:210-212`, and `PACE` is `workflow/prompts.ts:7-8`.
- The README "Public contract" is `workflow/README.md:221-231`, items K1–K6. K5 names `parseCommands`, `KEYWORDS` and `WRAPPERS` only.
- `sessionFolders`, `agents/index.ts:123-136`, takes the newest `session-folders` entry without comparing its `cwd`.
  - The entry format is `{ v: 1, cwd: "<forward slashes>", folders: [...] }` (`workflow/index.ts:355`).
  - The workflow already compares `cwd` at `workflow/index.ts:360`.
- Plan-menu branch, `workflow/index.ts:3000-3030`:
  - `planWaitRetried` is set at 3013 and reset only in `setPhase` (535).
  - `blocked` comes from `approvalBlock` (3020); the menu leaves out Approve when it is set (3028), and no notice is shown.
  - Model for the notice: `index.ts:642-644`, `workflow: can't approve: ${blocked}.`
- `const APPROVED` at `workflow/index.ts:206` is never used.
- `JUDGE_MAJOR_ONLY` is added inline at `workflow/index.ts:1836` (`testJudge`).
  - `agent-end.ts` holds pure helpers like this one, tested in `agent-end.test.ts`.
  - `agent-end.ts` may import from `./prompts.ts`. Check that this makes no import cycle; if it does, pass the text in as a parameter.
- Sync:
  - `bin/import.js:125-139` deletes with `fs.unlinkSync` inside `try`, and on error prints `  WARNING  could not delete ${k}: ${e.message}` and continues.
  - `MACHINE_KEYS = ['lastChangelogVersion']` (`bin/lib.js:144`) is removed by `scrub` for `settings.json`.
  - Test helpers: `setup`, `run`, `syncedPair`, `read`, `write` at `bin/sync.test.js:13-36` and `245-254`.
  - Model test: `'import deletes a JSON file that Pi reformatted'` at `bin/sync.test.js:332`.
- `docs/workflow-improvements.md`: the next free B ID is B15. The Status line is line 5 and the "Effect measurement" table starts near line 140.

### 4. Design
There are no new components. A few pure helpers are pulled out so they can be tested:
- `judgeAddenda(minorRounds: number): string` in `workflow/agent-end.ts`. It returns `"\n" + JUDGE_MAJOR_ONLY` when `minorRounds > 0`, else `""`.
- `foldersForCwd(entries: unknown[], cwd: string): string[]` in a new `agents/session-folders.ts`.
  - It takes the last entry with `customType === "session-folders"`.
  - It returns that entry's string `folders` only when `data.cwd === cwd.replace(/\\/g, "/")`, else `[]`.
  - The existence check (`fs.statSync`) stays in `agents/index.ts`.
- New `agents/knowledge.ts` holds `toolPrefix`, `WRITE_TOOLS`, `roleTools` and `forwardedServers`.
  - `workflow/knowledge.ts` re-exports them with `export { … } from "../agents/knowledge.ts"`, so every current workflow import keeps working.
  - `knowledgeTools` and `PACE` move to `agents/prompts.ts`; `workflow/prompts.ts` re-exports both.
- README contract: K5 also names `commandReadOnlyProblem` and `unwrapCommand`.
  - New K7: `repos.ts` exports `uniqueRoots` and `repoKey`.
  - New K8: `view.ts` exports `FlowView`, `RunView`, `runLine` and `shortModel`, used by `agents/` for its run cards.

Rejected:
- Moving `view.ts` into `agents/` (D3): it is large and holds flow token logic.
- Resetting the retry flag on every full plan (D5): it loops.

### 5. Steps
**S1.** `workflow/view.ts:444` `addFinished`: before calling `add`, raise the run count by one for the role and for its model.
- Role: `this.flow[this.stage].subs[role] ??= { tokens: zero(), runs: 0 }`, then `runs++`.
- Model: `(sub.byModel ??= {})[modelKey(shortModel(model))] ??= { tokens: zero(), runs: 0 }`, then `runs++`.
- Model it on `view.ts:396-399`.
- `add` stays as it is. Its `||= 1` is a no-op once the count is ≥ 1.
- Add a test to `view.test.ts`.

**S2.** Move the knowledge helpers and the prompt pieces.
- Create `agents/knowledge.ts` with `toolPrefix`, `WRITE_TOOLS`, `roleTools` and `forwardedServers`, moved verbatim with their doc comments. It imports `KnowledgeConfig` from `./types.ts`.
- `workflow/knowledge.ts`: delete those definitions and re-export the three exported functions.
- Move `knowledgeTools` and `PACE` to `agents/prompts.ts`, and re-export both from `workflow/prompts.ts`.
  - `workflow/prompts.ts` keeps using `PACE` in its own templates, so it must also import it locally.
  - `agents/prompts.ts` must no longer import from `../workflow/`.
- Point `agents/index.ts:27-28` at `./knowledge.ts` and `./prompts.ts`.
- Update `workflow/README.md` "Public contract": extend K5 and add K7 and K8 as in Design.

**S3.** `agents/index.ts:123` `sessionFolders`: use `foldersForCwd(ctx.sessionManager.getBranch(), ctx.cwd)` from the new `agents/session-folders.ts`, then keep the existing filter for folders that exist.
- The new file gets a test, `agents/session-folders.test.ts`.
- Update `agents/README.md` in one line: folders count only from the entry for the current working folder.

**S4.** `workflow/index.ts` plan branch (around 3008-3030):
- Right after `planWaitNow` is computed, set `planWaitRetried = false` when `planWaitNow.length === 0`.
- When `blocked` is set and `cfg.planPrompt` is on, call `ctx.ui.notify(\`workflow: can't approve: ${blocked}.\`, "warning")` before `askUser`.
- Delete `const APPROVED` (line 206).

**S5.** Add `judgeAddenda` to `workflow/agent-end.ts` and use it at `index.ts:1836` in place of the inline expression. Add a test to `agent-end.test.ts`.

**S6.** `bin/sync.test.js`: add two tests (section 6). If either one shows a bug, fix it in `bin/import.js` or `bin/lib.js` with the smallest possible change, and say so in the commit message.

**S7.** `docs/workflow-improvements.md`:
- Row B15 after the last B row: "Follow-up fixes from the trim flow: sub-agent run counts, the agents→workflow import contract, session folders keyed by cwd, the can't-approve notice, plan-wait retry reset, the `judgeAddenda` test". Mark it **Done**.
- Add B15 to the Status line.
- Effect-measurement row: "B15 | Run counts on flow cards | the `×N` of explore on a flow with several explores | N matches the calls".
- This goes in the same commit as S1.

**S8.** Deliver: merge — open-finding fixes.

**S9.** Final report to the user: each step and its tests, then the item-7 reminder (every non-goal listed in section 1).

### 6. Tests
- `workflow/view.test.ts`, "addFinished counts each finished run":
  - Call `addFinished("explore", "claude-bridge/claude-haiku-5-5", usage)` twice.
  - Expect `flow[stage].subs.explore.runs === 2`.
  - Expect the single `byModel` entry's `runs === 2`.
- `agents/session-folders.test.ts`:
  - Entries `[{type:"custom",customType:"session-folders",data:{v:1,cwd:"D:/a",folders:["D:/x"]}}]`:
    - with cwd `D:\a`, expect `["D:/x"]`
    - with cwd `D:/b`, expect `[]`
  - `[]` → `[]`.
  - Two entries: the last one wins.
- `workflow/agent-end.test.ts`, "judge addenda after a minor round": `judgeAddenda(0) === ""`; `judgeAddenda(1)` includes `only blocker and major`.
- `bin/sync.test.js`, "import deletes settings.json that differs only in a scrubbed machine key":
  1. Local `settings.json` is `{"lastChangelogVersion":"1","a":1}`, plus 8 filler files (as at :332).
  2. Export.
  3. Locally, set `lastChangelogVersion` to `"2"`.
  4. Delete the mirror's `settings.json` and import.
  5. Expect the local `settings.json` to be gone.
- `bin/sync.test.js`, "a delete that fails is a warning, not an error":
  1. `syncedPair()`, then delete `ma`.
  2. Make the delete fail:
     - Windows: `fs.chmodSync(a, 0o444)`
     - otherwise: `fs.chmodSync(dirname(a), 0o555)`, and skip when `process.getuid?.() === 0`
  3. Run `import.js`. It must not throw: `execFileSync` throws on a nonzero exit.
  4. Expect the output to match `/WARNING  could not delete extensions\/demo\/a\.ts/`.
  5. Expect `local/sync-state.json` to still have a string record for `extensions/demo/a.ts`.
  6. Restore the permissions in `finally`.
  - If neither way fails the unlink on this host, skip the test with a reason. Don't drop it.
- Commands, from `D:/works/pi-config`, all fast:
  - `node --experimental-strip-types --test pi/agent/extensions/agents/*.test.ts pi/agent/extensions/workflow/*.test.ts 2>&1 | grep -E "^ℹ (pass|fail)|^✖ "` → only `publish.test.ts` fails (it already fails on `master`). The count goes up by the new tests, from 657 today.
  - `node --test bin/sync.test.js` → 27 pass (or 26 pass and 1 skipped).
  - `node --experimental-strip-types --test extension/ready.test.ts` → 6 pass.
  - Load check: import `workflow/index.ts` and `agents/index.ts` with a Proxy `pi`. Resolve the pi packages from `C:/Users/unkno/.pi/agent/install/releases/1.4.0/node_modules`, as in the earlier smoke script. Both must load without throwing. Write the script in the repo root and delete it afterwards.
- Grep check: `grep -n 'from "../workflow' pi/agent/extensions/agents/*.ts` shows only `readonly-bash.ts`, `repos.ts` and `view.ts`.

### 7. Done when
- Every open finding is fixed and tested (D1).
- `agents/` imports only `readonly-bash.ts`, `repos.ts` and `view.ts` from `workflow/`, and the README contract K5, K7 and K8 lists them (D3, D4).
- The plan-wait retry flag resets on clean checks (D5).
- Docs row B15, the Status line and the Effect-measurement row are present (D6).
- All the tests in section 6 pass apart from the existing `publish.test.ts` failure.
- The judge passes, and the one PR is merged (D2).
- The final report includes the item-7 reminder (D1).

### 8. Risks, rollback, what not to touch
- **Risks:**
  - The re-exports could create an import cycle (`agents/prompts.ts` ↔ `workflow/prompts.ts`). `agents/` must never import back from `workflow/prompts.ts` or `workflow/knowledge.ts`.
  - Getting the chmod-based unlink failure to work on Windows.
- **Rollback:** revert the merge commit.
- **Do not touch:**
  - `pi/agent/mcp.json`, `auth.json`, `trust.json`, `models-store.json`
  - sessions and `install/releases`
  - the `worktree/` extension
  - the repo-root `AGENTS.md`
  - `video_frames`
  - the guards' refusal rules

### 9. Commits
1. `workflow: count runs of finished sub-agents` — `workflow/view.ts`, `workflow/view.test.ts`, `docs/workflow-improvements.md`
2. `agents: own the knowledge helpers and PACE; document the workflow imports` — `agents/knowledge.ts`, `agents/prompts.ts`, `agents/index.ts`, `workflow/knowledge.ts`, `workflow/prompts.ts`, `workflow/README.md`
3. `agents: take session folders only from the entry for this working folder` — `agents/session-folders.ts`, `agents/session-folders.test.ts`, `agents/index.ts`, `agents/README.md`
4. `workflow: can't-approve notice, plan-wait retry reset, drop APPROVED, judgeAddenda` — `workflow/index.ts`, `workflow/agent-end.ts`, `workflow/agent-end.test.ts`
5. `sync: tests for a scrubbed-key delete and a failed delete` — `bin/sync.test.js` (plus `bin/import.js` or `bin/lib.js` only if a test shows a bug)

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `workflow/view.ts:444` `addFinished`: before calling `add`, raise the run count by one for the role and for its model.
- [x] S2 Move the knowledge helpers and the prompt pieces.
- [x] S3 `agents/index.ts:123` `sessionFolders`: use `foldersForCwd(ctx.sessionManager.getBranch(), ctx.cwd)` from the new `agent
- [x] S4 `workflow/index.ts` plan branch (around 3008-3030):
- [x] S5 Add `judgeAddenda` to `workflow/agent-end.ts` and use it at `index.ts:1836` in place of the inline expression. Add a tes
- [x] S6 `bin/sync.test.js`: add two tests (section 6). If either one shows a bug, fix it in `bin/import.js` or `bin/lib.js` with
- [x] S7 `docs/workflow-improvements.md`:
- [x] S8 Deliver: merge — open-finding fixes.
- [x] S9 Final report to the user: each step and its tests, then the item-7 reminder (every non-goal listed in section 1).
## Outcome
2026-11-01T09:08:34.096Z — ok: master, 7 commits since the review base, PR #26 MERGED https://github.com/Unknownow/pi-config/pull/26
