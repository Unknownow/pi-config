<!-- pi-workflow plan v1 flow=20261017-0048-record-the-plan-check-reminder-and-push-e8d9 -->
## Plan: Record the plan_check reminder and push-downgrade finding in the workflow backlog, and add a rule to keep it current

### 1. Goal and non-goals
**Goal:**
- `docs/workflow-improvements.md` records the `plan_check` reminder as done (D4).
- It records the misleading "not pushed" commit report as an idea (D5), and adds measurement rows for both.
- Its Status line is updated.
- The doc gets a "Keeping this file current" section.
- A new repo-root `AGENTS.md` holds the same keep-current rule, so every agent session in this repo loads it.

**Non-goals:**
- No code changes, and no implementation of D5.
- No rewording of existing rows, ratings, the "Suggested order" or "Not verified" sections.
- No refresh of drifted line numbers in existing rows.

### 2. User decisions
- D1: Add the `plan_check` reminder (commit `6df1ae0`) to the backlog doc as a done item.
- D2: Add the push-downgrade report problem as an idea only. Do not implement it.
- D3: Keep the doc up to date. The rule lives both in the doc and in a new repo-root `AGENTS.md`.
- D4: The flow's delivery is commit + push.

### 3. Facts the executor needs
- F1: The doc is `docs/workflow-improvements.md` (126 lines).
  - Line 5 is the Status line: `Status: A3, A5, B7, B9, C2, C4, D2 and D3 are implemented; A1 is rejected; the rest are ideas only. Found by …`
  - Line 7 is `## How to read the ratings`.
- F2: Section D starts at `docs/workflow-improvements.md:62`. Its table header (line 64) is `| # | Finding | Benefit | Effort | Risk | Check first |`. The last row is D3 at line 68, followed by a blank line and `## Effect measurement` (line 70).
  - Done rows follow the pattern at line 67 (D2): finding text, then `**Done:** …` inside the Finding cell.
  - Benefit uses High/Medium/Low plus an axis (T)/(K). See the legend at lines 9-15.
- F3: The measurement table header is at line 80: `| # | Metric | How to measure | Keep if |`. Its last rows are D1-D3 at lines 107-109, and the D3 row is the last one. Line 103 has the n/a row style: `| C5, C6 | n/a | Leave as is | n/a |`.
- F4: Facts for the D4 row:
  - The only instruction to tick steps is one bullet in the execute prompt, `pi/agent/extensions/workflow/prompts.ts:79`.
  - `plan_check` is registered at `index.ts:1458`.
  - The judge gets the ticks as "claims, not proof" (`index.ts:816`).
  - The fix is `openStepsReminder` in `plan-doc.ts`, called from the `judge` tool's `execute` in `index.ts`, in commit `6df1ae0`.
- F5: Facts for the D5 row:
  - `prepareDelivery` (`index.ts:2472-2497`) turns `push` into `commit` when the branch is protected or HEAD is detached. It only shows `ctx.ui.notify("…committing without pushing", "warning")` (`index.ts:2479-2480`).
  - `protectedBranches` defaults to `["main", "master"]` (`config.ts:178`) and is set in `pi/agent/workflow.json:65-68`.
  - The commit instruction adds the push sentence only when the mode isn't `commit` (`delivery.ts:84`). So the commit step reports "the instruction covered only the commit" and doesn't know why.
- F6: The repo root `D:\works\pi-config` has no `AGENTS.md` or `CLAUDE.md`. The workflow extension loads project `AGENTS.md`/`CLAUDE.md` files (README `pi/agent/extensions/workflow/README.md:278`). The global `AGENTS.md` says "Project `AGENTS.md` files add to this."

### 4. Design
None. This is a docs-only change.

### 5. Steps
**S1.** `docs/workflow-improvements.md:5`, Status line: replace `A3, A5, B7, B9, C2, C4, D2 and D3 are implemented` with `A3, A5, B7, B9, C2, C4, D2, D3 and D4 are implemented`. Keep the rest of the line as it is.

**S2.** `docs/workflow-improvements.md`: insert a new section between the Status line (line 5) and `## How to read the ratings` (line 7), with blank lines around it. Heading: `## Keeping this file current`. Body, 3 bullets:
- Any change to `pi/agent/extensions/workflow/` that implements, rejects or adds a backlog item updates, in the same commit:
  - the item's row (a `**Done:**` or `**Rejected:**` note with the commit or file names),
  - the Status line,
  - the item's row in the "Effect measurement" table.
- A new finding gets the next free ID in its section (A, B, C or D). Rows are never renumbered.
- Line numbers in rows point at the commit named in the Status line and will drift. Fix them only when a row is edited.

**S3.** Section D table: append a D4 row after the D3 row (after line 68), using the column order in F2.
- **Finding:** the executor often skips `plan_check`, so the plan card stays at "0 of N done" although the work is finished. The only instruction is one bullet in the execute prompt (`prompts.ts:79`). Nothing reminds the executor later, and the judge treats ticks as claims (`index.ts:816`). Then `**Done:**`: when `judge` runs in the execute phase with steps of the current stage unticked, its result ends with `Open steps not ticked: S2, S3. Tick the finished ones with \`plan_check\`.` (`openStepsReminder` in `plan-doc.ts`, commit `6df1ae0`). It is non-blocking and never auto-ticks.
- **Benefit:** `Low (progress shown matches the work)`
- **Effort:** `S`
- **Risk:** `Low.`
- **Check first:** `None.`

**S4.** Section D table: append a D5 row after D4.
- **Finding:** on a protected branch (`main`, `master`, `config.ts:178`) or a detached HEAD, `prepareDelivery` (`index.ts:2472-2497`) turns a `push` delivery into `commit`. It shows only a short UI notice. The commit instruction then has no push sentence (`delivery.ts:84`), so the commit step reports that it didn't push because "the instruction covered only the commit", which looks like a bug. The idea: state the reason in the commit instruction or in the flow's final report, e.g. "push skipped: `master` is protected". No `**Done:**` note.
- **Benefit:** `Low (clearer report)`
- **Effort:** `S`
- **Risk:** `Low.`
- **Check first:** `None.`

**S5.** Measurement table: after the D3 row (line 109), add two rows in the column order of line 80:
- `| D4 | Share of flows whose final \`status.json\` has every step ticked | Count over recent plan folders before and after \`6df1ae0\` | Most flows end fully ticked; no extra judge rounds |`
- `| D5 | n/a | Report wording only | n/a |`

**S6.** New file `AGENTS.md` at the repo root (`D:\works\pi-config\AGENTS.md`). Use a heading `# Project instructions` and one short section `## Workflow extension backlog` with 2 bullets:
- When a change to `pi/agent/extensions/workflow/` implements, rejects or adds an item of `docs/workflow-improvements.md`, update that file in the same commit: the item's row, the Status line and the "Effect measurement" row. The rules are in its section "Keeping this file current".
- A new idea or finding found while working on the extension is added as a new row with the next free ID, as an idea only, unless the user asked to implement it.

Keep it under 15 lines and in plain sentences, matching the style of the global `AGENTS.md`.

**S7.** Run the checks in section 6.

### 6. Tests
There are no code tests, because this change has no code. Run these from the repo root:
- `grep -c "^| D[45] |" docs/workflow-improvements.md` should print `4` (2 backlog rows + 2 measurement rows).
- `grep -n "D3 and D4 are implemented" docs/workflow-improvements.md` should match line 5.
- `grep -n "^## Keeping this file current" docs/workflow-improvements.md` should give exactly 1 match, before `## How to read the ratings`.
- `test -f AGENTS.md && grep -c "workflow-improvements.md" AGENTS.md` should print `1` or more.
- Every new table row should have the same number of `|` as its table header: 7 in section D, 5 in the measurement table. Count them with `awk -F'|' '/^\| D[45] \|/{print NF-1}' docs/workflow-improvements.md`, which should print `6`, `6`, `4`, `4` in that order.
- `git diff --stat` should show only `docs/workflow-improvements.md` and `AGENTS.md`.

### 7. Done when
- The Status line lists D4 as implemented.
- Section D has a D4 row (done, with commit `6df1ae0`) and a D5 row (idea only), both in the existing row format.
- The measurement table has D4 and D5 rows.
- The doc has a "Keeping this file current" section placed before "How to read the ratings".
- The repo-root `AGENTS.md` exists and holds the keep-current rule pointing to the doc.
- Only `docs/workflow-improvements.md` and `AGENTS.md` changed. Other rows and sections are byte-for-byte unchanged.

### 8. Risks, rollback, and what not to touch
- **Risk:** a malformed table row breaks Markdown rendering. The pipe-count check in section 6 catches this.
- **Risk:** the new `AGENTS.md` is loaded into every session in this repo. Keeping it short keeps that cost small.
- **Rollback:** revert the commits.
- **Do not touch:**
  - any code under `pi/agent/extensions/workflow/`
  - `pi/agent/workflow.json`
  - the global `C:\Users\unkno\.pi\agent\AGENTS.md`
  - existing rows A1-D3, "Suggested order", "Not verified"

### 9. Commits
- `docs: workflow backlog adds D4 (plan_check reminder) and D5 (push downgrade report)`: `docs/workflow-improvements.md`
- `docs: AGENTS.md rule to keep the workflow backlog current`: `AGENTS.md`

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 `docs/workflow-improvements.md:5`, Status line: replace `A3, A5, B7, B9, C2, C4, D2 and D3 are implemented` with `A3, A5
- [ ] S2 `docs/workflow-improvements.md`: insert a new section between the Status line (line 5) and `## How to read the ratings` 
- [ ] S3 Section D table: append a D4 row after the D3 row (after line 68), using the column order in F2.
- [ ] S4 Section D table: append a D5 row after D4.
- [ ] S5 Measurement table: after the D3 row (line 109), add two rows in the column order of line 80:
- [ ] S6 New file `AGENTS.md` at the repo root (`D:\works\pi-config\AGENTS.md`). Use a heading `# Project instructions` and one s
- [ ] S7 Run the checks in section 6.
