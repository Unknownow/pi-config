<!-- pi-workflow plan v1 flow=20261106-1627-set-the-server-time-remote-config-and-ga-c05d -->
## Plan: Set the server-time, remote-config and game-configs playbooks back to draft until their device checks pass

**Goal:** the knowledge entries `eng.playbook.server-time`, `eng.playbook.remote-config` and `eng.playbook.game-configs` go back to `status: draft`. They stay drafts until their human checks pass: S12 (server time cheat in the Editor or on a device), S28 (remote config on Android) and S20 (configs in the Editor and an IL2CPP build). Agents search only `verified` entries by default (`docs/entry-format.md:98`), so until then they won't present these as proven.

**Non-goals:**
- No change to the playbook content beyond one pitfall line per entry.
- No changes to game-template or unity-packages.
- No stage 4 (configs plus A/B).
- No change to the `moon-template-migration.md` rows. The device check status itself doesn't change here.

**User decisions**
- D1: set all three entries back to `draft` until S12, S28 and S20 pass. The user approved the recommendation with "go".

**Facts the executor needs**
- **Who stamped them:** the daily job's bot stamped all three entries `verified`, with `verified_by: cuongbpt-iec` and `verified_at: 2026-11-06`. For example, commit `f2bd981` changed only those front matter lines.
- **Validation:** a draft must not carry `verified_by` or `verified_at`, or validation fails (`knowledge/tools/validate/validate.mjs:395`).
- **Re-stamping:** the daily job re-stamps the entries of any merged PR unless the PR has the label `keep-draft`. The label list is at `tools/ci/daily.mjs:31,35` and the check at `:243`; the docs are at `docs/getting-started.md:241`. Without the label, the next run (08:10 Vietnam time) would set them back to verified.
- **Changing entries:** a normal PR that edits the entry file is allowed (`docs/getting-started.md:243`, knowledge `AGENTS.md` rule 2). Run `npm run check` before pushing.
- **Existing note:** `entries/eng/playbook/game-configs.md` already ends its Pitfalls with "This is not yet checked on a device: keep this entry a draft until the Android check of the first game that uses a config."

**Steps**
- **S1.** Start a new knowledge branch, `flow/playbooks-draft`, from `origin/main`. Check `git status` first. The local `flow/game-configs` branch is merged and gone.
- **S2.** Edit the front matter of `entries/eng/playbook/server-time.md`, `entries/eng/playbook/remote-config.md` and `entries/eng/playbook/game-configs.md`:
  - set `status: verified` to `status: draft`;
  - delete the `verified_by:` and `verified_at:` lines;
  - change nothing else in the front matter, and keep the line endings as they are.
- **S3.** Add one last Pitfalls bullet to `server-time.md` and `remote-config.md`, worded like the existing game-configs line:
  - server-time: "Not yet checked in a game's Editor or on a device: keep this entry a draft until the server time cheat check (badge, +1 day, Reset shift) passes."
  - remote-config: "Not yet checked on a device: keep this entry a draft until the Android check (first fetch logs `remote_config_fetch`, the cheat menu shows the applied ids) passes."
  - game-configs: extend its existing line to also name the Editor and IL2CPP check: Edit configs, New config, and `Library/Iec/configs.link.xml` listing the config types after an IL2CPP build.
- **S4.** Run `npm run check` in `knowledge/`. Expected: "All checks passed." and 0 errors.
- **S5.** Commit with the subject `playbooks: server-time, remote-config, game-configs back to draft until their device checks`. Push, then open the PR **with the label `keep-draft`**. The label must be on the PR before the merge; confirm it is there.
- **S6.** Get a judge PASS on the exact tree before the merge.
- **S7.** Deliver: merge the knowledge PR. Use a merge commit, not a squash.

**Tests**
- `npm run check` in `knowledge/` passes with 0 errors. Run it before pushing; it takes about 2 minutes.
- Grep: `grep -n "^status:\|^verified_" entries/eng/playbook/{server-time,remote-config,game-configs}.md` shows `status: draft` three times and no `verified_` lines.

**Done when**
- All three entries are `status: draft` on knowledge `main`, with no `verified_by` or `verified_at` lines.
- Each entry names the check that will verify it.
- The merged PR has the `keep-draft` label, so the daily job skips it.
- `npm run check` passes.

**Risks and what not to touch**
- **Missing label:** if the PR is merged without `keep-draft`, the next daily run re-verifies the entries. Fix it by adding the label to that PR and setting them back in a follow-up PR.
- **Turning them back to verified later:** once a check passes, set that entry back to verified with a normal PR without the label; the bot then stamps it.
- **Do not touch** other entries, `moon-template-migration.md`, the schema, or the tools.

**Commits:** one commit, `playbooks: server-time, remote-config, game-configs back to draft until their device checks`, changing the three files under `entries/eng/playbook/`.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Start a new knowledge branch, `flow/playbooks-draft`, from `origin/main`. Check `git status` first. The local `flow/game
- [ ] S2 Edit the front matter of `entries/eng/playbook/server-time.md`, `entries/eng/playbook/remote-config.md` and `entries/eng
- [ ] S3 Add one last Pitfalls bullet to `server-time.md` and `remote-config.md`, worded like the existing game-configs line:
- [ ] S4 Run `npm run check` in `knowledge/`. Expected: "All checks passed." and 0 errors.
- [ ] S5 Commit with the subject `playbooks: server-time, remote-config, game-configs back to draft until their device checks`. P
- [ ] S6 Get a judge PASS on the exact tree before the merge.
- [ ] S7 Deliver: merge the knowledge PR. Use a merge commit, not a squash.
