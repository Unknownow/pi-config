<!-- pi-workflow plan v1 flow=20261104-1529-readable-gd-progress-report-progress-md-0e52 -->
## Plan: Readable GD progress report (PROGRESS.md and IEC_Progress)

**Goal:** GD, PO, dev and art can see what is done and what is left on the first screen of `PROGRESS.md` and of the `IEC_Progress` tab. Every item has a real name, a link to its doc where there is one, and only the columns that matter for its tab. The format of `status --json` stays the same.

**Repos:**
- `game-template`, branch `flow/gd-readable-report`: all code and tests.
- `knowledge`: the playbook text.

maze-flow and shiny-loop get the change later through their normal update-from-template merge, which is not part of this flow. Their real data is used only to check the output; nothing is written to them.

**Decisions I made for the open questions** (tell me if any is wrong):
1. **Language:** `PROGRESS.md` follows `reportLanguage`, en or vi, with the same labels as the sheet.
2. **Doc change after done:** it is shown as a flag in "Needs attention" ("doc changed after done"). It does not change the item's status, because the item's status should only change when a person decides.
3. **Sheet colours:** the `Code.gs` change is accepted. Each game runs `writer update` once after its template update, and the playbook and the sync output say so.

### Steps

1. **Read the Android (version-control) tab as items.** In `scripts/lib/gd-items.mjs:83,119`, a row is in scope when its `Version` cell equals `versionName`. On the Android tab that cell holds `10.0`, and `1.0.0` appears only on the block's header row ("Version | 1.0.0 | 10.0"), so no row ever matches.
   - New rule: a row is in scope when it belongs to the block whose header row names `versionName`, up to the next header row.
   - Key the items by the feature name, as now.
   - Warn during sync when no block matches, instead of returning nothing without a message.
   - Test with a fixture copied from maze-flow `Android.tsv`: rows 31–54 become items and rows 3–27 don't.

2. **Show cell values as the sheet displays them.** The cause of `46117.0` (a date read as a number) and `1.0` (an integer read as a decimal) is still unverified: it is either `gd-xlsx.mjs:54-61` reading the raw value or the export itself.
   - First reproduce it with a small .xlsx fixture.
   - Then fix it where it starts, using the number format from `styles.xml`, or the display values in the export.
   - The change must also make GD ids `37`, not `37.0`.
   - Item keys must stay the same: add a test that reads old `items/10.0.yaml` data and finds no new, removed or changed items.

3. **Give detail-tab items real names** (`gd-items.mjs:103-104`):
   - when column 0 is a code or a date, the name is that code plus the tab's description column, picked by header;
   - Wording: `W001 "<v0>" → "<v10>"`;
   - Change note: `27/10 · Helpers: <change>`;
   - an optional `tabs.<tab>.nameColumns` setting in `docs/gd-sheet.json` covers sheets the rule gets wrong.

   Renaming an item must not mark it changed or `recheck`. Add a test for that.

4. **Clean up the links:**
   - `Code.gs:180-184` records each linked cell once;
   - `gd-docs.mjs` also removes duplicates from older index files;
   - each item gets a link to its doc: a feature row from its Doc cell in the current block, a change-note row from its Link column;
   - a feature row in the current block with no doc is flagged "no doc".

5. **Fix the misleading data:**
   - the `merged` flag is shown only when that part's own commit is merged;
   - the owner shown for each part comes from the right GD/Art/Dev column; on Assets the dev part is owned by "Art" today;
   - "doc changed after done" (decision 2) means the doc's `modifiedTime` is later than the time of the done event.

6. **Rewrite `gd-render.mjs` with the agreed layout:**
   - a header with the sync time, the sheet link and a legend;
   - Overview: tab × part, done or verified / needed, plus how many are left;
   - Needs attention: blocked, rejected, recheck, triage, stale, no doc, doc changed, each with its reason (the last event's evidence or note) and the date;
   - Waiting for confirmation, grouped by person and commit, with the item ranges joined (`levels-001…017`);
   - Recently done: 7 days of events;
   - per tab: open items first, only the part columns the tab uses, the item name linked to its doc, what GD asked (cut to about 90 characters), done and not-needed rows folded in `<details>`;
   - Linked docs: only the problems, with the full list folded;
   - Branches with no GD link.

   Labels come from `gd-i18n.mjs`. Add `render --print`: it writes the result to stdout, with no commit and no push.

7. **Change the `IEC_Progress` tab** (`gd-push.mjs` and `Code.gs:89-99`):
   - the summary rows at the top: Overview and Needs attention;
   - the item table below, with its header frozen, filters on and open items first;
   - columns: key, tab, item (linked), what GD asked, dev, art, gd, po, waiting for confirmation, last change, confirmed by and at, evidence;
   - status cells coloured by the Apps Script.

   Then update `gd-apps-script.test.mjs` and `gd-writer.test.mjs`. An old deployment that gets the new payload must still write the table, or fail with a message that says to run `writer update`.

8. **Update the docs:**
   - `game-template/AGENTS.md`: the GD section, on the PROGRESS layout, `render --print` and the need for `writer update`;
   - `knowledge/entries/eng/playbook/gd-checklist.md`, items 11 and 13;
   - the `gd-report` and `gd-sync` skills, only where they describe the report: `.agents` first, then copied byte for byte to `.claude`.

### Checks

- `node --test` on the GD test files: `scripts/gd-render`, `gd-items`, `gd-sheet`, `gd-docs`, `gd-apps-script`, `gd-writer`, `gd-sync`, `gd-sync-offline`, `gd-sync-version`, `gd-store-e2e` and `gd-flows` (`.test.mjs`). All must pass.
- New tests come from the fixtures in steps 1–7, using real maze-flow rows.
- **Real data:** copy `D:/projects/maze-flow/.gd` and `docs/gd-sheet.json` to a temp folder, then run `render --print` with the new code. Check:
  - the Android features appear;
  - no `46117.0` or `x.0` remains;
  - change-note and wording items have real names;
  - no row is linked from the same cell twice;
  - the 4 blocked items appear with their reasons;
  - "Waiting for confirmation" has at most 6 groups;
  - the first screen (header, Overview, Needs attention) is under 40 lines.

  I'll show you the result.
- **The sheet:** I can't redeploy a game's writer from here. After the merge, you or a dev run `writer update` and a sync on maze-flow and look at `IEC_Progress`.
- Run `judge` before the merge.

**Delivery:** pull requests to `game-template` and `knowledge`. Merge after the judge passes, with a merge commit and no squash. The games are not updated in this flow.

## Plan choices upheld by the arbiter
The judge is right about how the code behaves. `summaryRows` in `gd-push.mjs` writes at least 13 lines for maze-flow's 5 tabs: the overview title and column row, 5 tab rows and the total, a blank line, the attention title and header, at least one attention line, a blank line and the "Items" title. That puts the header at row 15 or lower. `Code.gs:117` freezes only when the header is in row 12 or above (`MAX_FROZEN_ROWS = 12`), so with real data nothing is frozen.

That doesn't make the plan miss its target, though. The fixed Goal is that the first screen of `IEC_Progress` shows what is done and what is left. "Header frozen" is only a detail in step 7, and the Checks don't mention it. Two of the judge's fixes would break the Goal: putting the summary from column O would push it off the first screen of a 13-column table, and `IEC_Summary` would take it out of `IEC_Progress`. The third fix ("frozen only when short") is already written down in `knowledge/entries/eng/playbook/gd-checklist.md` item 11: "the header frozen when the summary is short". The filter on the header still works (test "progress writes the summary above the table…", filter row = header row), so the table can still be sorted and filtered.

<!-- pi-workflow:status -->
## Outcome
2026-11-04T09:21:35.222Z — ok: knowledge: flow/gd-readable-report, 1 commit since the review base, PR #226 MERGED https://github.com/iecgames/knowledge/pull/226; game-template: flow/gd-readable-report, 10 commits since the review base, PR #224 MERGED https://github.com/iecgames/game-template/pull/224
