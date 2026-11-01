<!-- pi-workflow plan v1 flow=20261101-1649-make-the-failed-delete-sync-test-run-on-9a11 -->
## Plan: Make the failed-delete sync test run on every platform

### 1. Goal and non-goals
**Goal:** fix the one open finding from the PR #26 review. The sync test "a delete that fails is a warning, not an error" (`bin/sync.test.js:357`) always skips on Windows, so the warning path in `bin/import.js:131-137` is never tested here. After the fix the test runs and passes on Windows, Linux and macOS, with no skip. The final report reminds the user of the items left for later.

**Non-goals:**
- No change to `bin/import.js` or `bin/lib.js` unless the test shows a bug.
- Nothing from the item-7 list is done. The final report only reminds the user of it.

The other leftover, `returnToPlan` in `workflow/README.md`, is already fixed. A grep finds the name only in the history note of docs row A36.

### 2. User decisions
- D1. Fix the remaining findings, then remind the user of the items left for later.
- D2. Deliver it as before: a branch, a judge pass, and a merged PR.

### 3. Facts the executor needs
- `bin/sync.test.js:357-386`: the current test.
  - It uses `chmod` and a probe file, and skips when the probe can be deleted.
  - On Windows the probe can always be deleted, because `fs.unlinkSync` clears the read-only flag first.
- `bin/import.js:19` loads `fs` with `require('fs')`.
- Its only delete is at `bin/import.js:132`, `fs.unlinkSync(f)`, inside a `try`. The `catch` prints `  WARNING  could not delete ${k}: ${e.message}` and does `continue`, so `delete state[k]` doesn't run and the record is kept.
- `localForm` (`bin/import.js:104-112`) reads the local file before the delete. So the local `a.ts` must stay a normal, readable file.
- `run(env, script, ...args)` (`bin/sync.test.js:27-33`) calls `execFileSync(process.execPath, [path.join(env.repo, 'bin', script), ...args], { cwd: env.repo, env: { ...process.env, HOME: env.home, USERPROFILE: env.home }, encoding: 'utf8' })`.
- `syncedPair()` (`bin/sync.test.js:245-254`) returns `{ env, a, b, ma, mb }`, where `env.root` is the temp root.

### 4. Design
Make the delete fail by injecting the error instead of relying on file permissions.
- The test writes a CommonJS preload script to `path.join(env.root, 'fail-unlink.js')`. The script replaces `require('fs').unlinkSync` with a wrapper.
  - When `String(p).replace(/\\/g, '/')` ends with `extensions/demo/a.ts`, the wrapper throws `Object.assign(new Error('EPERM: operation not permitted (test)'), { code: 'EPERM' })`.
  - Every other path goes to the original function.
- The test runs `import.js` with the arguments `['--require', preload, path.join(env.repo, 'bin', 'import.js')]`, using the same `cwd`, `env` and `encoding` as `run`.
- `import.js` gets the same `fs` object from the module cache and looks up `unlinkSync` when it calls it, so the call hits the wrapper.
- This works the same on every platform, with no `chmod`, no root check and no skip.

Rejected options:
- `icacls` deny rules: Windows-only and hard to undo cleanly.
- Putting a folder where the file was: `localForm`'s `readFileSync` throws outside the `try` and crashes the import.

### 5. Steps
**S1.** Create the branch `fix/failed-delete-test` from `master`.

**S2.** Rewrite the test body at `bin/sync.test.js:357` and keep its name.
1. Call `syncedPair()`, then `fs.unlinkSync(ma)`.
2. Write the preload from section 4 to `path.join(env.root, 'fail-unlink.js')`.
3. Run `import.js` with `--require <preload>`, using `execFileSync` with the options of `run`.
   - Either call `execFileSync` directly, or give `run` an optional way to pass node arguments.
   - Existing callers of `run` must keep working unchanged.
4. Assert:
   - the output matches `/WARNING  could not delete extensions\/demo\/a\.ts/`
   - `fs.existsSync(a)` is true
   - `JSON.parse(read(path.join(env.repo, 'local', 'sync-state.json')))['extensions/demo/a.ts']` has `typeof` `'string'`
5. Remove the `chmod` code, the probe file, both `t.skip` calls and the `finally` block. The test callback no longer takes `t`.
6. Edit with a file-editing tool or a Node script, not a heredoc. Heredocs mangle backslashes and regex escapes. Delete any temporary script afterwards.

**S3.** Deliver: merge — the failed-delete test fix.

**S4.** Final report to the user:
- what changed and the test results
- that the `returnToPlan` README finding was already fixed
- the item-7 reminder:
  - the 44–47 KB `AGENTS.md` files in game-template and shiny-loop
  - ww-kanboard, and rotating its token, which is in git history
  - `video_frames`
  - `.bak` pruning
  - the worktree extension review
  - sessions cleanup (104 MB)
  - checking that `hermes-memory-config.json` is gone on CuongPT-dev
  - optionally, setting `startPhase: "off"` in `pi/agent/workflow.json`

### 6. Tests
- `bin/sync.test.js`, "a delete that fails is a warning, not an error":
  - **Input:** a synced pair whose mirror `a.ts` is deleted, and an import run where deleting `a.ts` fails.
  - **Expected:** the warning line is printed, the local `a.ts` still exists, and its record is kept. The test passes on Windows with no skip.
- Command (fast): `node --test bin/sync.test.js 2>&1 | grep -E "^ℹ (pass|fail|skipped)"` should print `pass 27`, `fail 0` and `skipped 0`.

### 7. Done when
- The failed-delete test runs and passes on Windows with no skip, and all 27 sync tests pass (D1).
- The judge passes and the PR is merged (D2).
- The final report includes the item-7 reminder (D1).

### 8. Risks, rollback, what not to touch
- **Risk:** the wrapper must match only the `a.ts` path. If it matched more, other deletes and `pruneEmptyParents` would fail too.
- **Rollback:** revert the merge commit.
- **Don't touch:**
  - `bin/import.js` and `bin/lib.js`, unless the test shows a bug
  - `pi/agent/mcp.json`
  - `auth.json`
  - sessions
  - `install/releases`

### 9. Commits
1. `sync: make the failed-delete test fail the delete on every platform`, in `bin/sync.test.js`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Create the branch `fix/failed-delete-test` from `master`.
- [ ] S2 Rewrite the test body at `bin/sync.test.js:357` and keep its name.
- [ ] S3 Deliver: merge — the failed-delete test fix.
- [ ] S4 Final report to the user:
