# workflow

Each kind of work gets its own model. Every model and thinking level is set in `~/.pi/agent/workflow.json`.

```
you -> plan (Opus 5.5, high) -> approve -> execute (Sonnet 5.5, medium) -> judge (Opus 5.5) -> commit
                                              |-- explore (Haiku 5.5, parallel): file:line only
                                              `-- advisor (Opus 5.5): reads the full transcript
escalation (manual): /flow escalate -> Fable 5.1 (high), /flow back
context guard:       compacts at ~140k tokens on every model, after the run settles
```

| Role | Runs as | When |
|---|---|---|
| `plan` | main session model; edit/write off | new sessions start here (`startPhase`) |
| `execute` | main session model | after you approve the plan |
| `explore` | `explore` tool, parallel sub-`pi` processes | the executor fans out reads/greps |
| `advisor` | `advisor` tool, sub-`pi` with the whole transcript | choosing an approach, after an error repeats (auto-nudged after `repeatedErrorThreshold` failures), before "done" |
| `judge` | `judge` tool, sub-`pi` with the git diff | the diff is ready; when a run ends with an unreviewed diff it asks (`autoJudge`) |
| `escalate` | main session model | `/flow escalate` |

## Hands-off run

You discuss the plan with the planner. When you're happy, say **"go"**. It also accepts "ok go",
"lgtm", "do it", "ship it" and other short approvals; see `approvePattern`. Everything after that
runs on its own:

```
"go" -> execute (Sonnet) -> judge (auto) -> FAIL: fix and judge again (max 3 rounds)
                                         -> PASS: commit -> push the current branch
```

- **Push guard:** it never pushes `protectedBranches` (`main`, `master`) or a detached HEAD. It
  commits there and tells you. It never force-pushes or uses `--no-verify`, and stops if a hook fails.
- **Where it stops for you:** when the judge fails `maxJudgeRounds` times in a row, or something errors.
- **Judge rounds after the first** review only what changed since the last round: a fresh judge gets
  that round's findings, the changes since, and the names of every file in the change, at
  `judge.recheckThinking` (medium). Calling it again with no changes returns the last result. It
  falls back to a full review after a commit, rebase or branch switch, or when the changes since are
  over `judge.recheckMaxShare` (half) of the whole diff. A change over
  `judge.finalFullReviewOverChars` (80,000 characters) that passes a re-review gets one final full
  review; the judge tool's `full: true` forces one. `"judge": { "recheck": false }` turns it off.
- **Turning steps back to manual:** set `"autoJudge": "ask"`, `"autoCommit": "ask"` (or `"commit"` /
  `"off"`), and `"planPrompt": true` for an Approve menu instead of the "say go" hint.

## What you see

A widget above the editor shows the pipeline with the active stage, its model and the tokens each
stage has used, and one live row per subagent: what it's doing right now, how many tools it has run,
its tokens and the elapsed time.

```
flow  plan opus-5-5·high 48k ▸ ● EXECUTE sonnet-5-5·medium 1.2M ▸ judge opus-5-5·high ▸ commit · Σ 1.3M
  ├ ⠇ explore  haiku-5-5  where is the save system serialized?  grep /Serialize/ in Scripts · 1 tool · 12k tok · 4s
  ├ ✓ explore  haiku-5-5  which scenes load the HUD prefab?  3 refs · 1 tool · 7s
  └ ⠇ advisor  opus-5-5   [error] NullReferenceException in SaveM…  read Scripts/SaveManager.cs:40-80 · 0s
```

Token counts update in real time, including the message still streaming. A stage counts the main
session's messages sent while it was active plus the subagents run during it (explore and advisor
count toward the stage that called them, judge runs toward `judge`). The figure is each message's
`totalTokens` (input + output + cache read/write) summed, so long contexts add up fast. The widget
counts the current flow; `/flow status` lists the whole session. Both survive a restart.

When a flow ends, a summary card goes into the transcript. It is display-only and never sent to the
model. A flow ends when the commit step finishes, when the judge passes and nothing gets committed, or
when the automatic judge loop stops after `maxJudgeRounds` failures. Then the widget starts again
from zero:

```
✓ flow done · committed and pushed · 1.2M tokens · 12m04s
  plan     █░░░░░░░░░░░░░░░░░░░    48k   4%  opus-5-5 48k
  execute  █████████████████░░░   1.0M  87%  sonnet-5 920k · explore ×6 120k
  judge    ██░░░░░░░░░░░░░░░░░░    90k   8%  judge ×1 90k
  commit   █░░░░░░░░░░░░░░░░░░░    20k   2%  sonnet-5 20k
```

The outcome says whether the commit really landed (HEAD moved) and whether it was pushed (nothing
ahead of upstream). `/flow tokens` shows the same card for the flow in progress.

When escalated, the phase's node turns yellow and shows `fable-5-1·high ↑`. The explore, advisor and
judge rows in the transcript stream the same rows while they run. Then they collapse to the result:
explore shows only its rows, advisor shows an 8-line preview, and judge shows its findings colored by
severity. Expand a row to see everything. Finished rows stay in the widget for 15 seconds after the
next run starts.

## Commands

| Command | Does |
|---|---|
| `/flow` | status: phase, the model for each role, config path |
| `/flow plan` / `execute` / `off` | switch phase (`off` leaves the model alone) |
| `/flow approve` | approve the plan: switch to execute and start (also offered when a plan ends) |
| `/flow escalate` (`fable`) / `/flow back` (`opusplan`) | manual escalation and return |
| `/flow judge` | review the current diff now |
| `/flow tokens` | token breakdown of the current flow so far |
| `/flow model <role> <provider/id[:thinking]>` | set a role's model and save it to workflow.json |
| `/flow reload` | re-read workflow.json |
| `pi --flow execute` | start a session in a given phase |

Subagents run `pi --no-extensions` and load only the extensions in `subagent.extensions` (the
claude-bridge provider). That way the pi-config sync and this extension don't run inside them. If a
role uses a provider from another extension, add it there.
