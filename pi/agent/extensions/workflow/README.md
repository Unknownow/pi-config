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
- **Turning steps back to manual:** set `"autoJudge": "ask"`, `"autoCommit": "ask"` (or `"commit"` /
  `"off"`), and `"planPrompt": true` for an Approve menu instead of the "say go" hint.

## What you see

A widget above the editor shows the pipeline with the active stage and its model, and one live row
per subagent: what it's doing right now, how many tools it has run, its tokens and the elapsed time.

```
flow  plan opus-5-5·high ▸ ● EXECUTE sonnet-5-5·medium ▸ judge opus-5-5·high ▸ commit
  ├ ⠇ explore  haiku-5-5  where is the save system serialized?  grep /Serialize/ in Scripts · 1 tool · 12k tok · 4s
  ├ ✓ explore  haiku-5-5  which scenes load the HUD prefab?  3 refs · 1 tool · 7s
  └ ⠇ advisor  opus-5-5   [error] NullReferenceException in SaveM…  read Scripts/SaveManager.cs:40-80 · 0s
```

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
| `/flow model <role> <provider/id[:thinking]>` | set a role's model and save it to workflow.json |
| `/flow reload` | re-read workflow.json |
| `pi --flow execute` | start a session in a given phase |

Subagents run `pi --no-extensions` and load only the extensions in `subagent.extensions` (the
claude-bridge provider). That way the pi-config sync and this extension don't run inside them. If a
role uses a provider from another extension, add it there.
