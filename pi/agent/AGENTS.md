# Global agent instructions

Applies in every repo. Project `AGENTS.md` files add to this.

## Tool output: print answers, not raw data

Everything a tool returns stays in context and is re-sent on every later call.

- Filter in the command (`grep`, `tail`, counts) or use `run_code` / `fetch_url` + `grep` and print only the result. Tests: pass/fail counts and failures. Builds and logs: errors. Diffs: `--stat` unless you need the lines.
- Read raw text only for the lines you are about to edit (offset/limit, targeted `grep -n`). If a result is too little, narrow the next query; don't print everything.
- Several tool calls in a row: use one `codemode` script and print only the answer.

## Delegation

- **explore**: use it to explore a folder, answer an open question or search several files ("where is X handled?", "how does Y flow?"), and for several independent lookups at once (one call, many queries). Read a file yourself only when you know its exact path. Check its `file:line` evidence before relying on it.
- **advisor**: only at a real decision point (approaches with real consequences) or when the same error keeps repeating. Never for routine steps or to check finished work.
- **judge**: optional before a risky commit or merge; fix blocker and major findings.

## Pace

- Keep working until you need the user's input, a tool result or an explorer's answer.
- Put independent tool calls in the same reply so they run in parallel.
- Run long commands in the foreground with a timeout. To wait for a job, poll every few seconds in the same call; never sleep for minutes.
