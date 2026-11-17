# Shared code

Code that more than one extension uses. The folder has no `index.ts`, so pi does not load it as an extension; the extensions import its files directly. It imports nothing from any extension (`boundary.test.ts`, subfolders included: a `../` import must resolve inside `shared/`), so the agents, workflow and worktree extensions can each work without the others.

| File | What | Used by |
|---|---|---|
| `readonly-bash.ts` | Shell parser (`parseCommands`, `KEYWORDS`, `WRAPPERS`, `unwrapCommand`) and the read-only command policy (`commandReadOnlyProblem`, `readOnlyProblem`, `UNITY_PLAN_ALLOW`). | workflow, agents (runner guard), worktree (Unity guard) |
| `readonly-tools.ts` | Read-only tool gate: `PLAN_TOOLS` (reading tools by name), `planToolRefused`, `phaseToolRefusal`, `planToolProblem` (bash text and run_code JavaScript checks). | workflow (discuss and plan phase) |
| `repos.ts` | Repo roots of a command (`repoTexts`, `repoKey`, `uniqueRoots`, worktree and `--add-dir` parsing). Tested with the push guard in `repos.test.ts`. | workflow, agents |
| `tokens.ts` | Token counts: raw and cost-weighted (`countTokens`, `DEFAULT_TOKEN_WEIGHTS`), the per-kind counts and their formatting. | workflow, agents |
| `runs.ts` | Run cards: one row per sub-agent run (`newRun`, `applyEvent`, `endRun`, `runLine`, `shortModel`). | agents (tool rows), workflow (widget, via `FlowRun`) |
| `roles.ts` | Role specs `provider/id[:thinking]` (`parseRoleSpec`, `describeRole`, `THINKING_LEVELS`), the model list, Tab completions and the model picker. | `/agents model`, `/flow model` |
| `notify.ts` | Desktop notification command per platform (`notifyCommand`). | workflow |
| `dock.ts` | The dock: one `dock` widget below the editor with two columns. `layoutDock` (pure layout), `attachDock` (owner: subscribes to `dock:lines`, draws, repaints), `publishDock` / `unpublishDock` (producers). | worktree (left: `wt-sessions`), relay (right: `relay`) |
| `claims.ts` | The claim pattern over the event bus (`emitClaims`, `gatherClaims`): listeners call `claim(promise)` during the emit; the first non-null answer wins. | workflow (`workflow:folder-add`), relay (worktree events), agents (`agents:judge-call`) |
| `findings.ts` | Reviewer findings: `parseFindings`, `judgeVerdict`, `isClean`, `blockingFindings`, `findingsBlock`. | workflow, relay, agents |
| `session-folders.ts` | Readers of the `session-folders` entry: `foldersForCwd(branch, cwd)` (newest entry, only when it names the cwd) and `newestFolders(branch)` (newest entry for any cwd), `FOLDERS_ENTRY`, `SessionFoldersData`. | agents (relay and worktree to follow) |
| `git/merge-gate.ts` | The judge gate for merges, protected pushes and publishing (`gateCheck`, `recordJudged`, `noMerge`, `midFlowMergeProblem`, …). One copy of the workflow and relay versions. | none yet (workflow and relay switch later) |
| `git/push-guard.ts` | The git command guard (`pushProblem`, `shellProblem`, `mergeTarget`, …), with the optional force-with-lease `lease` of a delivery step. | none yet |
| `git/repo-diff.ts` | Per-repo diff with untracked files (`collectRepoDiff`), the default review base (`defaultReviewBase`: merge-base with the origin default branch), citation helpers (`uncitedFiles`, `citeNames`, …). | agents (judge tool) |

## Dock contracts and owner election

`pi.events` `dock:lines` `{v:1, key, side:"left"|"right", lines:string[]}`: the producer `key` shows `lines` on that side; empty `lines` removes it; an unknown `v` is ignored. `dock:hello` `{v:1}`: a new owner attached; `publishDock` producers publish their current lines again. Producers publish full lines; only the dock truncates (with `…`).

Owner election: `globalThis[Symbol.for("pi.dock")]` holds `{id, release}` of the current owner, so each extension's own copy of `dock.ts` agrees. The latest extension with a UI (`ctx.hasUI`) to call `attachDock` (at `session_start`) calls the previous owner's `release` (it clears that owner's widget and listeners), becomes owner and emits `dock:hello`. The owner calls its `release` at `session_shutdown` (also removing its entry), so `/reload` leaves one widget. An extension without a UI only publishes. The owner sets `setWidget("dock", factory, {placement:"belowEditor"})` when lines exist, clears it when both sides are empty, and calls `tui.requestRender()` on every `dock:lines`.

Layout (`width` = terminal width): right empty: left lines full width. Left empty: right lines in a column of `min(longest, width)` flush right. Both: `R = min(longest right, 60, floor((width-2)/2))`, `L = width - R - 2`, rows = the longer side, left padded to `L`, right column flush right; if `width < 100` or `L < 40` the left block, then the right block (right-aligned), are stacked. Every line is truncated to its column.

Changing an export's name, signature or meaning changes every extension that uses it; run all their tests.

Tests: `node --experimental-strip-types --test *.test.ts git/*.test.ts`

## Completions

`completions.ts` holds the helpers every slash command uses for `getArgumentCompletions`: a table of `{value, description, arg?, next?}` per command, `subcommandCompletions` (prefix filter; the value ends in a space when something follows), `isKnown`, `safe` (a completion function never throws). `roleCompletions` in `roles.ts` completes role, model and thinking level for `/flow model`, `/agents model` and `/relay model`.
