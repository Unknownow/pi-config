# Global agent instructions

Applies in every repo. Project `AGENTS.md` files add to this.

## Tool output: filter in the tool, read only what you need

Everything a tool returns stays in context and is re-sent on every later call, so print answers,
not raw data.

- **Filter or summarize in the tool.** Put the filter in the command (`grep`, `tail`, counts), or
  use `run_code` to run JavaScript over output or a file and print only the result. For web pages
  use `fetch_url`, then `grep` or `read` the saved file. Tests: pass/fail counts and
  the failures only. Builds and logs: errors only. Diffs: `--stat` unless you need the lines.
- **Several tool calls in a row? Use one `codemode` script.** It calls tools as `tools.<name>(args)`,
  can run them in parallel, and only what it prints reaches you: chain grep → read → summarize, or
  run the plan's file checks, in one call. Calls are real and not undone if the script fails, so
  edits in scripts follow the same plan scope rules. Single reads and edits: call the tool directly.
- **Read raw text only for the lines you are about to edit**, with offset/limit or a targeted
  `grep -n`. Don't dump whole files, long diffs or full logs "to have a look".
- **Too little?** Narrow the next query; don't fall back to printing everything.
- **Keep working, in parallel.** Don't stop between steps: keep going until you need the user's input, a tool's result or an explorer's answer. Put independent tool calls in the same reply so they run in parallel (several reads, a test run next to an explore, several explore queries or test tasks in one call); wait only for results the next step needs.
- **No long fixed sleeps.** Run long commands in the foreground with a timeout. To wait for a background job or the Unity Editor, poll in the same call every few seconds until it is done; never sleep for minutes.

## Code search: explore for open questions, read known files yourself

Read files you already know directly, with the normal tools: `run_code`, `grep`, `read`. Use the
`explore` tool for open questions and multi-file searches ("how does X flow through the code?",
"where is Y handled?", several independent lookups at once, for example across repos), and when a
search timed out or returned too much to narrow down. It runs a cheap model that decides for itself
how much to read, and answers with a short answer plus `file:line` evidence.

Each `explore` call names its `reason`. Check the evidence before relying on it, and read the exact
lines yourself when you are about to write a plan or an edit from them.

## Advisor: only at real decision points

The advisor reads the whole session transcript, so each call costs about as much as the session
so far. Call it only when choosing between approaches with real consequences, or when the same
error keeps repeating. Not for routine steps, small or low-risk changes, or to check finished
work: the judge reviews the diff.
