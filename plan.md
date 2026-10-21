<!-- pi-workflow plan v1 flow=20261021-0910-close-the-open-worktree-findings-k5-cont-44bb -->
## Plan: Close the open worktree findings (K5 contract, parent-of-link guard, plain remote delete, clean/done messages)

### 1. Goal and non-goals
**Goal.** Close the six open minor findings from the worktree/workflow work:
- Make the worktree extension's import of the workflow shell parser part of the workflow's public contract (K5).
- Make the shared-file guard refuse recursive deletes of a folder that holds a link.
- Delete remote branches without any force flag, still only when the remote tip is unchanged.
- In `/wt clean`, still ask the remote-branch question after the local cleanup is declined.
- Fix the misleading `set kept:` message in `/wt done`.
- Document that `/wt clean` also removes idle empty workspaces.

**Non-goals.**
- No change to `workflow/delivery.ts`, `push-guard.ts`, `commit-guard.ts`, `subagent.ts`, the Unity guard rules, the `vscode/` bridge protocol or the `workflow-state` format.
- No force push anywhere, and no new "keep"/"fresh" flag in `.pi-set.json`.
- No change to workflow behaviour; only the workflow README gains one contract line.
- No new backlog row in `docs/workflow-improvements.md`.

### 2. User decisions
- D1. The `readonly-bash.ts` import becomes contract entry **K5** in the workflow README. The workflow still never names the worktree extension.
- D2. `/wt clean` keeps removing idle, empty pool workspaces (they count as `delivered`). This is documented in the worktree README; no keep flag.
- D3. The shared-file guard also refuses recursive deletes of any folder that contains a link (`rm -rf .`, `Remove-Item -Recurse <repo>`, `rm -rf *`).
- D4. Remote branch deletion uses a plain `git push origin --delete <branch>` with no force or lease flag. It runs only after `git ls-remote` shows the remote tip still equals the checked tip.
- D5. When the user declines the local cleanup in `/wt clean`, the remote-branch question is still asked. The leftover sweep does not start.
- D6. `/wt done` shows `set kept:` only when the set was really kept: an error, or a cancelled removal.
- D7. Nothing is added to `docs/workflow-improvements.md`, because there is no workflow behaviour change.
- D8. Earlier constraints still hold: the dependency is one-way and enforced by both `boundary.test.ts` files; no force push; master is protected; the workflow commits.

### 3. Facts the executor needs
- `workflow/README.md:198`: the K4 line (`**K4. \`workflow:status\` event.**`) is the last contract entry. K5 goes on the line after it.
- `worktree/README.md:147`: the "Relationship to the workflow extension" paragraph, with the sentence "The one code import is the shell parser `workflow/readonly-bash.ts`, used by the Unity guard."
- `worktree/README.md:99`: the `/wt clean` paragraph in Cleanup. It contains "and expired backup refs. Sets that are kept…" and "…offered in a second, separate confirmation and deleted with `git push origin --delete`."
- `worktree/README.md:152-160`: the Limits list. Line 158 is "- `node_modules` is shared with the original; …".
- `worktree/shared-guard.ts`:
  - `:15` defines `insidePath(p, dir)`; `:13-14` define `slash` and `fold`; `BS` is `String.fromCharCode(92)`.
  - `:49` holds `if (RECURSIVE_DELETE.test(text))`.
  - `:50-56` is the per-link loop: tokenize at `:53` (`text.split(/[\s"'`;|&()]+/)`), refuse at `:55`.
  - `inRepo(l)` (`:40`) gives the link path inside its repo, for example `node_modules` or `.pi/git`.
  - `o.cwd`, `o.setRoot` and `o.linked` are absolute paths.
- `worktree/shared-guard.test.ts`:
  - `:16` is the test `"recursive deletes of a link are refused"`, and `:25` is `assert.equal(bash("rm -rf dist"), null);`.
  - The fixture `o` has `cwd: "D:/wt/w1/game"`, `setRoot: "D:/wt/w1"`, and `linked` containing `D:/wt/w1/game/node_modules` and `D:/wt/w1/game/.pi/git`.
- `worktree/clean.ts`:
  - `:227-236` is `deleteRemotes(git, items)`. `:231` currently runs `git push --force-with-lease=refs/heads/<b>:<tip> origin --delete <b>`.
  - It returns `{ done, failed }` lines formatted as `origin/<b> in <basename(main)>`.
  - `RemoteItem` is `{ main, branch, tip }`.
- `worktree/clean.test.ts:158-167` already checks three cases against a real bare origin:
  - a moved tip (`tip: "1".repeat(40)`) fails and the branch stays on origin;
  - a normal delete succeeds;
  - a missing branch `wt/none` fails.
- `worktree/index.ts`:
  - `cleanCmd` is at `:437`. `:458` reads `if (flow.status === "no-ui" || flow.status === "cancelled") return ctx.ui.notify(flow.text, "info");` and `:459` is `startSweep(ctx, cfg, flow.leftovers);`.
  - `:461` sets `out = [flow.text]`, then comes the remote block gated on `ctx.hasUI`.
  - `cleanFlow` (`clean.ts:207`) returns `{ status: "cancelled", text: "Cancelled.", leftovers: [] }`.
- `worktree/index.ts`: `doneCmd` is at `:710`. `:743` reads `nctx.ui.notify(r.removed ? r.text : \`set kept: ${r.text}\`, r.error ? "error" : "info");`.
  - `r` comes from `removeFlow` (`RemoveOutcome`, `manage.ts:383-417`). Cancel returns `text: "Cancelled."` with `error: false` (`manage.ts:405,413`).
  - A successful removal whose folder still holds plain files returns `removed: false, error: false` (`manage.ts:296`).
- Pitfall: backslashes in heredocs and in tool-written text have been eaten before. In new TS, prefer `BS`/`String.fromCharCode(92)` or check the written bytes. Always run `index.test.ts`, which is the only parse check of `index.ts`.

### 4. Design
No new components. Two contract changes:
- K5 (README only).
- `deleteRemotes` keeps its signature `deleteRemotes(git: Git, items: RemoteItem[]): Promise<{ done: string[]; failed: string[] }>`; only the git calls change.

There is a small race window between `ls-remote` and the plain delete, because a push could land in between. This is accepted: the window is a few seconds, and the user confirmed the list just before.

Alternative rejected: keep `--force-with-lease`. It closes the race, but the plan bans any force flag on a push (D4).

### 5. Steps
**S1.** `workflow/README.md:198`. After the K4 line, add one contract entry:
- Text, exactly: `- **K5. Shell parser.** \`readonly-bash.ts\` exports \`parseCommands\`, \`KEYWORDS\` and \`WRAPPERS\`. Other extensions may import these three; changing their names, signatures or meaning is a contract change.`
- It must not name worktree or `wt` (the workflow boundary test bans `"wt/`, `.pi-set.json` and similar strings).
- In `worktree/README.md:147`, change "`workflow/readonly-bash.ts`, used by the Unity guard" to "`workflow/readonly-bash.ts` (K5), used by the Unity guard".
- No code change; `worktree/boundary.test.ts` stays as it is.

**S2.** `worktree/shared-guard.ts`, in the `RECURSIVE_DELETE` branch, after the per-link loop at `:50-56`: add a second check for a folder that holds a link.
- Tokenize the same text the same way as `:53` (raw tokens, no stripping). Skip empty tokens and tokens that start with `-`.
- Map wildcard tokens to their folder: a token that is exactly `*` or `**` means `.`, and a token ending in `/*` or `/**` means the part before it. Any other token containing `*`, such as `*.log`, is taken literally, so it matches no folder.
- Resolve the token against `o.cwd` with `path.join`, or keep it as-is when `path.isAbsolute`.
- If some link `l` in `o.linked` satisfies `insidePath(l, resolved)`, return this message:

  `` `${raw} holds ${inRepo(l)}, a link to the original repo; deleting it recursively could delete the original's files. Ask the user to run /wt unlink ${inRepo(l)} first (or /wt remove for the whole set).` ``

  The tests match `/holds/` and `/holds node_modules/`.
- The existing per-link message at `:55` stays first and unchanged.
- Model it on the existing loop at `:50-56` and on `insidePath` at `:15`.

**S3.** `worktree/clean.ts:227-236`, `deleteRemotes`. For each item, in order:
1. Run `git ls-remote --heads origin refs/heads/<branch>` in `i.main`.
2. Non-zero exit: push to `failed` the line `origin/<b> in <repo>: <first line of stderr or stdout>` and continue.
3. Take the first whitespace-separated field of the trimmed output as the current tip.
   - Empty: fail with `origin/<b> in <repo>: no longer on origin`.
   - Different from `i.tip`: fail with `origin/<b> in <repo>: moved since the check; kept`.
4. Otherwise run `git push origin --delete <branch>` with no other flag. Success goes to `done` with the existing format; failure keeps the existing failure format.

Update the doc comment at `:226` to say it checks the tip with `ls-remote` and pushes without any force flag.

**S4.** `worktree/index.ts:458-459`, `cleanCmd`.
- Return early only for `flow.status === "no-ui"`.
- For `"cancelled"`, don't call `startSweep`. Fall through so `out` starts as `["Cancelled."]` (that is `flow.text`) and the remote block runs and asks its own confirmation.
- Every other status keeps calling `startSweep(ctx, cfg, flow.leftovers)` as now.
- The final notify shows `out.joined` as before.

**S5.** `worktree/index.ts:743`, `doneCmd` `after` callback. Compute `kept = r.error || r.text === "Cancelled."`.
- If `kept`, show `` `set kept: ${r.text}` ``.
- Else if `r.removed`, show `r.text`.
- Otherwise show `r.text` followed by a new line and `(folder kept: it still holds files)`.
- The level stays `r.error ? "error" : "info"`. The `catch` at `:745` is unchanged.

**S6.** `worktree/README.md` text updates:
- Cleanup `/wt clean` paragraph (`:99`):
  - (a) After "and expired backup refs.", add a sentence saying that an idle workspace with no work counts as `delivered`, so `/wt clean` also removes unused pool workspaces, and that `/wt new` (or `+ new workspace` in `/wt use`) makes a new one when needed.
  - (b) Replace "deleted with `git push origin --delete`" with wording that covers four points: the second confirmation is asked also when the first was declined; the delete is a plain `git push origin --delete` with no force flag; it runs only while `git ls-remote` still shows the tip that was checked; a branch that moved is kept.
- Limits list, before the `node_modules is shared` line (`:158`): add "- The shared-file guard refuses recursive deletes of a link and of any folder that holds one (`rm -rf .`, `Remove-Item -Recurse <repo>`); it cannot see paths built at run time (variables, scripts)."

### 6. Tests
**`worktree/shared-guard.test.ts`, test `"recursive deletes of a link are refused"` (`:16`).** Before the `rm -rf dist` line, add:

| Command passed to `bash(...)` | Expected |
|---|---|
| `rm -rf .` | matches `/holds node_modules/` |
| `Remove-Item -Recurse -Force D:/wt/w1/game` | matches `/holds/` |
| `rm -rf ../game` | matches `/holds/` |
| `rm -rf *` | matches `/holds/` |
| `rm -rf .pi` | matches `/holds \.pi\/git/` |
| `rm -rf src` | `null` |
| `rm -rf *.log` | `null` |

The existing assertions stay and must still pass, including `ls node_modules → null`, `rm node_modules/.cache → null` and `rm -rf dist → null`.

**`worktree/clean.test.ts:158-167`.** No change needed. The moved-tip case must now fail through the `ls-remote` check (the branch is still on origin), the normal delete must succeed, and `wt/none` must fail with "no longer on origin". Add `assert.match(stale.failed[0], /moved since the check/)` and `assert.match(bad.failed[0], /no longer on origin/)`.

**S4 and S5** are covered by the parse check `index.test.ts` only; they are not exercised in a live pi session.

**Commands:**
- `cd pi/agent/extensions/worktree && node --experimental-strip-types --test *.test.ts && node --test vscode/request.test.js` → `ℹ fail 0` both times; worktree about 155 tests, 1 skipped.
- `cd pi/agent/extensions/workflow && node --experimental-strip-types --test *.test.ts` → `ℹ fail 0`; this includes `boundary.test.ts` with the new README line.

### 7. Done when
- The workflow README lists K5. The worktree README cites K5. Both boundary tests pass, and the workflow side still never names the worktree extension (D1, D8).
- `rm -rf .`, `rm -rf *`, `rm -rf ../game`, `rm -rf .pi` and `Remove-Item -Recurse -Force <repo>` inside a set with links are refused. `rm -rf src`, `rm -rf *.log` and `rm -rf dist` are allowed (D3).
- `deleteRemotes` uses no force or lease flag. It deletes only when `ls-remote` shows the checked tip; a moved or missing branch is reported as failed and kept (D4).
- `/wt clean`: after declining the local cleanup, the remote-branch question is still asked and no sweep starts (D5).
- `/wt done` prints `set kept:` only on an error or a cancel, and otherwise adds "(folder kept: it still holds files)" when the folder stayed (D6).
- The README documents that `/wt clean` removes idle empty workspaces, the plain remote delete, and the guard limit (D2).
- `docs/workflow-improvements.md` is unchanged (D7). All test commands report `fail 0`.

### 8. Risks, rollback, what not to touch
**Risks.**
- The folder-holds-link check may refuse a legitimate delete whose token resolves to a parent of a link, for example `rm -rf D:/wt`. This is intended: the message points to `/wt unlink` and `/wt remove`.
- Tokens that are plain words, such as `rm`, resolve to `<cwd>/rm` and match nothing.
- The `ls-remote`/delete race window is accepted (§4).

**Rollback.** Revert the two commits.

**Do not touch.**
- `workflow/delivery.ts`, `push-guard.ts`, `commit-guard.ts`, `subagent.ts`, the Unity guard rules, `vscode/` and the `workflow-state` format.
- Any workflow `.ts` file.
- `docs/workflow-improvements.md`.
- No `reset --hard`, no new `branch -D` cases, and no force push.

### 9. Commits
- `docs(workflow): document readonly-bash exports as contract K5` (`workflow/README.md`)
- `fix(worktree): guard folders holding links, plain remote delete, clean/done messages` (`worktree/shared-guard.ts`, `worktree/shared-guard.test.ts`, `worktree/clean.ts`, `worktree/clean.test.ts`, `worktree/index.ts`, `worktree/README.md`)

## Amendment 1 (arbiter)
**S2 (replaces the tokenizing rule of S2; the message, wildcard mapping, path resolution and `insidePath` test stay as written).** `worktree/shared-guard.ts`, `sharedProblem`, inside the `RECURSIVE_DELETE` branch, after the unchanged per-link loop at `:50-56`:
- Split `text` into segments on `/[;&|\n]+/`. Only segments that match `RECURSIVE_DELETE` are checked.
- In each such segment, split tokens with the same separator regex as `:53`. Find the first delete verb: `rm`, `rmdir`, `Remove-Item`, `rimraf` or `del`, case-insensitive for `Remove-Item`, `rmdir` and `del`. Wrappers before it, like `sudo` or `xargs`, are fine. Only the tokens after the verb are delete arguments.
- Skip empty tokens, tokens that start with `-`, and the `cmd` switches `/s`, `/q` (any case) after `rmdir` and `del`. Then apply the existing wildcard mapping (`*`/`**` → `.`, trailing `/*` or `/**` removed, other `*` tokens taken literally), resolve against `o.cwd`, and run the `insidePath(link, resolved)` test.
- On a hit, return the same `holds` message as in S2.
- Why: only the delete's own arguments can name the folder being deleted. A `cd`, `find .` or `Get-ChildItem .` elsewhere in the command must not trigger the guard.
- Accepted limit, already covered by the S6 Limits line about paths built at run time: a `cd` before the delete is not tracked, so `cd .. && rm -rf game` is not caught.

**Tests (added to the S2 test block in `worktree/shared-guard.test.ts`, test `"recursive deletes of a link are refused"`).** Keep every new `holds` assertion and every existing one. Add:
- `assert.equal(bash("cd .. && rm -rf dist"), null)`
- `assert.equal(bash("find . -name x; rm -rf dist"), null)`
- `assert.equal(bash("cd D:/wt/w1/game && rm -rf dist"), null)`
- `assert.equal(bash("Remove-Item -Recurse build; Get-ChildItem ."), null)`
- `assert.match(bash("cd src && rm -rf .") ?? "", /holds/)`: `.` is a delete argument and resolves to cwd, which is accepted (the guard does not track `cd`).
- `assert.match(bash("rmdir /s /q .") ?? "", /holds/)`

Run the plan's same test commands; both must report `fail 0`.

<!-- pi-workflow:status -->
## Checklist
- [x] S1 `workflow/README.md:198`. After the K4 line, add one contract entry:
- [x] S2 `worktree/shared-guard.ts`, in the `RECURSIVE_DELETE` branch, after the per-link loop at `:50-56`: add a second check fo
- [x] S3 `worktree/clean.ts:227-236`, `deleteRemotes`. For each item, in order:
- [x] S4 `worktree/index.ts:458-459`, `cleanCmd`.
- [x] S5 `worktree/index.ts:743`, `doneCmd` `after` callback. Compute `kept = r.error || r.text === "Cancelled."`.
- [x] S6 `worktree/README.md` text updates:
## Outcome
2026-10-21T02:17:44.127Z — ok: committed (2 commits), push skipped: master is protected
