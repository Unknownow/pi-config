<!-- pi-workflow plan v1 flow=20261031-2354-remove-dead-config-leftovers-c869 -->
## Plan: Remove dead config leftovers

1. **Goal and non-goals**
   - Goal: remove the leftovers of extensions that are no longer installed, both from the repo and from this machine. Leftovers:
     - `hermes-memory-config.json` (repo and local)
     - `~/.pi/context-mode/`
     - `~/.pi/agent/projects-memory/`
     - the `*.bak-*` files in `~/.pi/agent`
   - Non-goals:
     - The `knowledge` block in `workflow.json`.
     - ww-kanboard and `mcp.json`.
     - Automatic pruning of `.bak` files.
     - Any change to extension code or READMEs.
     - Sessions.
     - The other machine (CuongPT-dev).

2. **User decisions**
   - D1: Cut the dead items first. The deeper trim (test phase, `video_frames`, overlapping reports) is left for later.
   - D2: The ww-kanboard removal is deferred. Leave `mcp.json` untouched.
   - D3: The `knowledge` block in `workflow.json` stays until the user says whether that server is coming back.
   - D4: Show the exact paths to the user before deleting anything outside the repo.
   - D5: When the flow ends, repeat the report of what's installed and the open trimming candidates.

3. **Facts the executor needs**
   - The sync never deletes on either side. A file removed locally stays in the repo until it is `git rm`'d (`bin/lib.js:10-11`, `bin/import.js:9`, `bin/export.js:9`). So the file must be removed in both places, or the next export or import brings it back.
   - The repo mirrors `~/.pi/agent` under `pi/agent`. The only tracked dead file is `pi/agent/hermes-memory-config.json`.
   - `.bak-` files are created by `bin/import.js:87-89` and excluded from sync (`bin/lib.js:101-108`, `extension/index.ts:364`). There are currently 48 of them in `C:/Users/unkno/.pi/agent/`.
   - `C:/Users/unkno/.pi/agent/projects-memory/` contains only the empty folder `puzzoo-ku/skills/`.
   - `C:/Users/unkno/.pi/context-mode/` (28 MB, holding `content/` and `sessions/`) is outside the mirror and is not loaded by any configured extension. The remaining `context-mode` mentions are history notes in `pi/agent/extensions/sandbox/README.md:3,12,14` and `docs/workflow-improvements.md:62`. Leave those as they are.
   - Nothing in the working tree references hermes or projects-memory (`git grep` is clean).
   - The current branch is `master` with a clean tree. `master` is protected, so work on a `flow/` branch.

4. **Design:** none. Files are only deleted.

5. **Steps**
   - **S1.** Create the branch `flow/remove-dead-config` from `master`.
   - **S2.** List every path you will delete outside the repo and get the user's OK before deleting (D4):
     - `C:/Users/unkno/.pi/agent/hermes-memory-config.json`
     - `C:/Users/unkno/.pi/context-mode/` with its size
     - `C:/Users/unkno/.pi/agent/projects-memory/`
     - each `C:/Users/unkno/.pi/agent/*.bak-*` file by name

     Use `wait_for_user` to get the OK. Delete only the listed paths. If the user removes something from the list, skip it.
   - **S3.** Run `git rm pi/agent/hermes-memory-config.json` in the repo.
   - **S4.** Delete the local `C:/Users/unkno/.pi/agent/hermes-memory-config.json`. Without this, the sync extension's next export would add it back to the repo.
   - **S5.** Delete `C:/Users/unkno/.pi/context-mode/` recursively.
   - **S6.** Delete `C:/Users/unkno/.pi/agent/projects-memory/` recursively.
   - **S7.** Delete the files matching `C:/Users/unkno/.pi/agent/*.bak-*`. Only files that match this exact pattern at the top level of that folder may be deleted.
   - **S8.** Deliver: merge the repo change from S3. The local deletions are not in git.
   - **S9.** At the end, tell the user:
     - The other machine still has `hermes-memory-config.json` and its export may add it back, so they need to delete it there too.
     - The installed-items report and the open trimming candidates, repeated from the discussion (D5).

6. **Tests:** there are no code changes, so no new tests. Run these checks:
   - `git ls-files | grep -c hermes` returns `0`.
   - `ls C:/Users/unkno/.pi/context-mode C:/Users/unkno/.pi/agent/projects-memory C:/Users/unkno/.pi/agent/hermes-memory-config.json` reports "No such file" for all three.
   - `ls C:/Users/unkno/.pi/agent/*.bak-* 2>/dev/null | wc -l` returns `0`.
   - `node bin/sync.test.js` (fast) still passes.
   - `node bin/import.js --dry-run` does not list `hermes-memory-config.json`.

7. **Done when**
   - `pi/agent/hermes-memory-config.json` is removed from the repo, and the removal is merged to `master`.
   - The local hermes file, `~/.pi/context-mode/`, `~/.pi/agent/projects-memory/` and all `~/.pi/agent/*.bak-*` files are gone, and only after the user approved the list.
   - `workflow.json`, `mcp.json`, `settings.json`, the extensions and the sessions are unchanged.
   - The final message contains the installed-items report and the reminder about the other machine.

8. **Risks, rollback, what not to touch**
   - Risk: the other machine re-exports the hermes file. That needs a manual delete there; it isn't fixable from here.
   - Rollback: run `git revert` for the repo file. The local deletions can't be undone, which is why S2 asks for approval.
   - Don't touch:
     - `auth.json`, `trust.json`, `models-store.json`
     - `mcp.json` and its `.bak` source of truth (only the `.bak` copies go)
     - `sessions/`, `bin/`, `npm/node_modules`, `install/`, `live/`, `workflow/`
     - the history mentions of context-mode in the READMEs and docs

9. **Commits**
   - `chore(config): remove leftover hermes-memory config`: `pi/agent/hermes-memory-config.json` (deleted).

## Amendment 1 (executor: autopilot)
OK to delete (irreversible): ~/.pi/agent/hermes-memory-config.json; ~/.pi/context-mode/ (28 MB); ~/.pi/agent/projects-memory/ (3 hermes sqlite lock files + empty puzzoo-ku/skills); and 48 top-level ~/.pi/agent/*.bak-* files (AGENTS.md x3, mcp.json x1, settings.json x37, workflow.json x7) (step S2, approve)


<!-- pi-workflow:status -->
## Checklist
- [x] S1 Create the branch `flow/remove-dead-config` from `master`.
- [x] S2 List every path you will delete outside the repo and get the user's OK before deleting (D4):
- [x] S3 Run `git rm pi/agent/hermes-memory-config.json` in the repo.
- [x] S4 Delete the local `C:/Users/unkno/.pi/agent/hermes-memory-config.json`. Without this, the sync extension's next export wo
- [x] S5 Delete `C:/Users/unkno/.pi/context-mode/` recursively.
- [x] S6 Delete `C:/Users/unkno/.pi/agent/projects-memory/` recursively.
- [x] S7 Delete the files matching `C:/Users/unkno/.pi/agent/*.bak-*`. Only files that match this exact pattern at the top level 
- [x] S8 Deliver: merge the repo change from S3. The local deletions are not in git.
- [x] S9 At the end, tell the user:
## Outcome
2026-10-31T16:56:13.506Z — ok: master, 2 commits since the review base, PR #20 MERGED https://github.com/Unknownow/pi-config/pull/20
