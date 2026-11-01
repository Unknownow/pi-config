<!-- pi-workflow plan v1 flow=20261101-1736-new-pi-sessions-start-with-the-flow-off-1e67 -->
## Plan: New Pi sessions start with the flow off, and the merged changes go live

### 1. Goal and non-goals
**Goal:**
- A new Pi session opens with the flow off: `"startPhase": "off"` in `pi/agent/workflow.json`.
- The live install at `C:/Users/unkno/.pi/agent` gets the repo's current setup: PRs #21–#27 plus this change.
- The final report reminds the user of the items left for later.

**Non-goals:**
- `"returnTo"` stays `"discuss"`.
- The built-in default in `pi/agent/extensions/workflow/config.ts:163` stays `"discuss"`.
- No code changes.
- Nothing from the left-for-later list is done.

### 2. User decisions
- D1. New sessions start with the flow off: `"startPhase": "off"` in `pi/agent/workflow.json`.
- D2. `"returnTo"` stays `"discuss"`: when a flow ends, Pi goes back to discuss.
- D3. The code default in `workflow/config.ts` stays `discuss`. Only the user's config changes.
- D4. Delivered as before: a branch, a judge pass, a merged PR.
- D5. Run `node bin/import.js --dry-run` first and show the user the result. After the user's OK, run `node bin/import.js`. The user then restarts Pi.
- D6. At the end, remind the user of the items left for later.

### 3. Facts the executor needs
- **The config:** `pi/agent/workflow.json:33` is `"startPhase": "discuss",` and `pi/agent/workflow.json:38` is `"returnTo": "discuss",`.
- **How a new session picks its phase:** `pi/agent/extensions/workflow/index.ts:3662-3671`.
  - On a new session (not a resume or reload), the start phase is the `--flow` flag if set, otherwise `cfg.startPhase`.
  - With `"off"`, only `updateStatus` runs.
  - A resumed session keeps its saved phase. That is expected.
- **Allowed values:** `"off"` is valid; `workflow/config.ts:261` checks the allowed values.
- **The live install is stale:**
  - The live `workflow.json` hash (`cefd712f…`) equals its record in `local/sync-state.json`, so nobody edited it on this machine.
  - `local/sync.log` ends with "23 kept (edited in the repo)". Those 23 are `extensions/workflow/*`, `AGENTS.md` and `workflow.json`.
  - `C:/Users/unkno/.pi/agent/extensions/agents/` does not exist yet.
- **What `bin/import.js` does** (`bin/import.js:1-17`):
  - It copies `<repo>/pi/agent/*` to `~/.pi/agent/*`.
  - It backs up every overwritten file to `<name>.bak-<timestamp>`.
  - It deletes only files that are recorded in sync state and unedited on this machine.
  - More than 20 deletions, or more than 25% of the recorded files, need `--allow-deletes`. Without it, nothing is deleted and the exit code is 2.
  - `--dry-run` writes nothing.
- **Git:** `local/*` is git-ignored (`.gitignore:13`), so the approval file in S4 is never committed.

### 4. Design
Not needed: this is a config value and a sync run.

### 5. Steps
**S1.** Create the branch `flow/start-flow-off` from `master`.
- In `pi/agent/workflow.json:33`, change `"startPhase": "discuss"` to `"startPhase": "off"`. Change nothing else; line 38 `"returnTo": "discuss"` stays.
- Keep the file's formatting: 2-space indent and a trailing newline.
- Check that the file still parses as JSON.

**S2.** Deliver: merge — `startPhase: "off"` in `pi/agent/workflow.json`.

**S3.** From `D:/works/pi-config`, on `master` after the merge is pulled, run `node bin/import.js --dry-run`.
- Show the user:
  - every file it would write;
  - every file it would delete, by exact path;
  - every "keep … edited on this machine" line;
  - the summary line.
- Never pass `--allow-deletes` or `--force`.
- If the dry run says the deletions are over the cap, stop and report.

**S4.** Wait: the user reviews the S3 dry-run list and approves it by creating the empty file `D:/works/pi-config/local/import-approved.txt` (check: test -f D:/works/pi-config/local/import-approved.txt)
- Call `wait_for_user` with `kind: "approve"`, `manual: true` and `step: "S4"`.
- The executor must never create this file itself.

**S5.** From `D:/works/pi-config`, run `node bin/import.js` with no flags, then delete `local/import-approved.txt`. Confirm all of these:
- the import's exit code is 0;
- the live `C:/Users/unkno/.pi/agent/workflow.json` contains `"startPhase": "off"` and `"returnTo": "discuss"`;
- `C:/Users/unkno/.pi/agent/extensions/agents/index.ts` exists.

Report any WARNING lines from the import.

**S6.** Verify: restart Pi in any folder and open a new session — look for: the status bar shows no flow phase, tools such as edit run without plan-phase refusals, and `/flow discuss` still starts a flow.

**S7.** Final report to the user:
- What changed: the one config line, and the files the import wrote, backed up and deleted.
- That the user must restart Pi.
- The left-for-later list:
  - the 44–47 KB `AGENTS.md` files in game-template and shiny-loop;
  - ww-kanboard: `pi/agent/mcp.json` is empty, and the token is in git history (commits b2d7e22, b9f5058, 9b208fe) and should be rotated;
  - `video_frames`;
  - pruning the `.bak` files (this import adds more);
  - the worktree extension review;
  - cleaning up sessions (104 MB);
  - checking that `hermes-memory-config.json` is gone on CuongPT-dev;
  - moving `view.ts` out of `workflow/`;
  - running the same import on CuongPT-dev and checking it after its next start;
  - the `publish.test.ts` failure, which predates this work.

### 6. Tests
- No code changed, so there are no new unit tests.
- **JSON check:** `node -e "JSON.parse(require('fs').readFileSync('pi/agent/workflow.json','utf8'))"` exits 0.
- **Sync suite (fast):** `node --test bin/sync.test.js 2>&1 | grep -E "^ℹ (pass|fail|skipped)"` prints pass 27, fail 0, skipped 0.
- **After S5:** `grep -n '"startPhase"\|"returnTo"' C:/Users/unkno/.pi/agent/workflow.json` shows `"off"` and `"discuss"`.

### 7. Done when
- `pi/agent/workflow.json` has `"startPhase": "off"` and `"returnTo": "discuss"`, and `workflow/config.ts` is unchanged (D1, D2, D3).
- The judge passed and the PR is merged (D4).
- The dry run was shown, the user approved it, the import ran with exit code 0, and the live `workflow.json` has `"startPhase": "off"` (D5).
- The final report includes the left-for-later list (D6).

### 8. Risks, rollback, what not to touch
- **Risk:** the import overwrites live files while this session runs. The running session keeps its loaded code until Pi restarts, which is expected.
- **Rollback:** revert the merge commit. Live files have `.bak-<timestamp>` backups next to them.
- **Don't touch:**
  - `workflow/config.ts`
  - `"returnTo"`
  - `pi/agent/mcp.json`, `auth.json`, `trust.json`, `models-store.json`
  - sessions and `install/releases`
  - `--allow-deletes` and `--force`: never use them

### 9. Commits
1. `config: start new Pi sessions with the flow off` (`pi/agent/workflow.json`)

<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create the branch `flow/start-flow-off` from `master`.
- [x] S2 Deliver: merge — `startPhase: "off"` in `pi/agent/workflow.json`.
- [x] S3 From `D:/works/pi-config`, on `master` after the merge is pulled, run `node bin/import.js --dry-run`.
- [x] S4 Wait: the user reviews the S3 dry-run list and approves it by creating the empty file `D:/works/pi-config/local/import-a
- [x] S5 From `D:/works/pi-config`, run `node bin/import.js` with no flags, then delete `local/import-approved.txt`. Confirm all 
- [x] S7 Final report to the user:
## For you after the flow
- S6 Verify: restart Pi in any folder and open a new session — look for: the status bar shows no flow phase, tools such as ed
## Outcome
2026-11-01T10:39:19.083Z — ok: master, 2 commits since the review base, PR #28 MERGED https://github.com/Unknownow/pi-config/pull/28 · 1 human check(s) for you (see the card)
