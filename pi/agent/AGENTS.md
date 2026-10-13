# Global agent instructions

Applies in every repo. Project `AGENTS.md` files add to this.

## Tool output: filter in the tool, read only what you need

Everything a tool returns stays in context and is re-sent on every later call, so print answers,
not raw data.

- **Filter or summarize in the tool.** Put the filter in the command (`grep`, `tail`, counts), or
  use context-mode: `ctx_execute` / `ctx_execute_file` to run code over output or a file and print
  only the result, `ctx_batch_execute` for several commands at once. Tests: pass/fail counts and
  the failures only. Builds and logs: errors only. Diffs: `--stat` unless you need the lines.
- **Several tool calls in a row? Use one `codemode` script.** It calls tools as `tools.<name>(args)`,
  can run them in parallel, and only what it prints reaches you: chain grep → read → summarize, or
  run the plan's file checks, in one call. Calls are real and not undone if the script fails, so
  edits in scripts follow the same plan scope rules. Single reads and edits: call the tool directly.
- **Read raw text only for the lines you are about to edit**, with offset/limit or a targeted
  `grep -n`. Don't dump whole files, long diffs or full logs "to have a look".
- **Too little?** Narrow the next query; don't fall back to printing everything.
- On Windows `ctx_batch_execute` and `ctx_execute` with `language: shell` run PowerShell; for bash
  use the `bash` tool, or `tools.bash` from a `codemode` script.

## Advisor: only at real decision points

The advisor reads the whole session transcript, so each call costs about as much as the session
so far. Call it only when choosing between approaches with real consequences, or when the same
error keeps repeating. Not for routine steps, small or low-risk changes, or to check finished
work: the judge reviews the diff.
