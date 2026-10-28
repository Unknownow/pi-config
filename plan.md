<!-- pi-workflow plan v1 flow=20261028-1705-ssh-and-github-account-cleanup-work-on-h-36fa -->
## Plan: SSH and GitHub account cleanup (work on HTTPS via gh, SSH only for Unknownow)

### 1. Goal and non-goals

**Goal:** After this plan, this machine works as follows:
- Work repos (`iecgames`) authenticate only over HTTPS, through `gh` as `cuongbpt-iec`.
- The only GitHub SSH identity is Unknownow, through the `github-personal` host alias and `~/.ssh/id_ed25519_unknownow`.
- The old work key and the orphan Unknownow key are gone, both on disk and on GitHub.
- GitLab traces are removed.
- Commits under `D:/personal/` and in `D:/projects/pi-config` use `Cuong Bui <cuong.bpt82@gmail.com>`. Everything else keeps the work identity.
- `gh` holds both accounts, with `cuongbpt-iec` active.

**Non-goals:**
- Plan 2: the template repos. Only the empty folder `D:/personal/` is created here.
- Marking `game-studio-unity` as a template repository.
- Changing the global `[url "https://github.com/"] insteadOf` or `[credential]` sections in `~/.gitconfig`.
- Touching the `google_compute_engine*` files.
- Any tracked file in pi-config. This includes `docs/workflow-improvements.md`, because this isn't a workflow extension change.

### 2. User decisions
- D1: Work uses only GitHub CLI (`gh`) as `cuongbpt-iec`. All old SSH keys for work are deleted.
- D2: The new SSH key is for Unknownow only: `~/.ssh/id_ed25519_unknownow` (already created by the user and registered on Unknownow).
- D3: Remove everything GitLab-related.
- D4: Keep the GCP key files (`google_compute_engine*`). The user accepted "the rest is ok".
- D5: The key cleanup is its own plan, before the template repos.
- D6: Switch the 11 work repos' SSH remotes to HTTPS and verify them before deleting keys.
- D7: Delete the work key from `cuongbpt-iec` and the orphan key (`cuongbpt.pub`) from Unknownow on GitHub, and delete them locally.
- D8: The `github-personal` alias points to `~/.ssh/id_ed25519_unknownow`. The `Host github.com` block is removed.
- D9: The personal folder is `D:/personal/`. Repos there get the identity through `includeIf gitdir`.
- D10: The personal identity is `Cuong Bui <cuong.bpt82@gmail.com>`.
- D11: `pi-config` stays in `D:/projects/` and gets a per-repo identity with that name and email.
- D12: Unknownow is added as a second `gh` account, and `cuongbpt-iec` stays active.
- D13: The user creates GitHub repos in the web UI. `Unknownow/game-studio-base` and `Unknownow/game-studio-unity` exist, are public and are empty. They're used in plan 2.
- D14 (plan 2, recorded only): the repo names are `game-studio-base` and `game-studio-unity`; checks use Python 3.11+ with TOML; the licence is MIT with copyright "Cuong Bui" plus the Donchitos NOTICE; base ships the Claude Code add-on (option A); the UPM package is `com.unknownow.studio-tools`.

### 3. Facts the executor needs
- `~/.ssh/config:6-11`: the `# Company account` comment plus the `Host github.com` block using `IdentityFile ~/.ssh/id_ed25519`. Remove it.
- `~/.ssh/config:13-19`: the `Host github-personal` block. Line 18 is `IdentityFile ~/.ssh/cuongbpt`; change it to `~/.ssh/id_ed25519_unknownow`.
- `~/.ssh/config:1-4`: the header comment. Rewrite it to say: work uses HTTPS through `gh`; SSH is only for Unknownow; keep the `IdentitiesOnly` explanation.
- `~/.gitconfig:1-3`: the global `[user]` is `cuongbpt` / `cuongbpt@ieccorp.vn`. Keep it.
- `~/.gitconfig:16-21`: the credential helpers are `gh auth git-credential`. Keep them.
- `~/.gitconfig:22-24`: `[url "https://github.com/"] insteadOf = git@github.com:` and `insteadOf = ssh://git@github.com/`. Keep them. Because of this rule, work SSH remotes already resolve to HTTPS today, so deleting the key can't break them.
- `~/.ssh/` currently holds `config`, `cuongbpt.pub` (no private key), `google_compute_engine`, `.ppk`, `.pub`, `id_ed25519`, `id_ed25519.pub`, `id_ed25519_unknownow`, `id_ed25519_unknownow.pub`, `known_hosts`, `known_hosts.old`.
- `~/.ssh/known_hosts` has 4 lines, 1 starting with `gitlab.com`. `~/.ssh/known_hosts.old` has 2 lines, 1 starting with `gitlab.com`.
- `id_ed25519.pub` is registered on `cuongbpt-iec`. `cuongbpt.pub` and `id_ed25519_unknownow.pub` are registered on Unknownow, which has 5 keys in total; the other 3 must not be touched.
- `gh` 2.102.0. `cuongbpt-iec` is logged in (keyring), active, with scopes `admin:public_key, gist, read:org, repo, workflow`. So no scope refresh is needed for it. Unknownow isn't logged in yet.
- SSH remotes to change (remote name = current URL):
  - `origin` = `git@github.com:iecgames/<repo>.git` in `D:/projects/` `arrow-block-out`, `ball-sort-color`, `bus-fever-party-teardown`, `custom-cloud-build`, `find-items`, `moon-template`, `puzzoo-ku`, `unity-empty-project`, `upm-registry`
  - `template` = `git@github.com:iecgames/game-template.git` in `D:/projects/maze-flow` and `D:/projects/shiny-loop`
  - The other remotes in those repos are HTTPS or local paths. Leave them alone.
- `D:/projects/pi-config` origin is `git@github-personal:Unknownow/pi-config.git`.
- Key listing: `gh api user/keys` (GET) returns `[{id, key, title, ...}]` for the authenticated account. `gh ssh-key delete <id> --yes` deletes one. To act as Unknownow, set `GH_TOKEN` from `gh auth token -u Unknownow` inside the same command. **Never print the token.**

### 4. Design
Not applicable: this is machine configuration only, with no new components.

### 5. Steps

**S1.** Wait: the user runs `gh auth login -h github.com -s admin:public_key`, logs in as Unknownow in the browser, then runs `gh auth switch -u cuongbpt-iec` (check: gh auth status --hostname github.com 2>&1 | grep "Logged in to github.com account Unknownow")

**S2.** Confirm the starting state:
- `gh auth status --active` shows `cuongbpt-iec`.
- The Unknownow entry in `gh auth status` lists `admin:public_key` among its token scopes. If not, stop and ask the user to run `gh auth switch -u Unknownow`, `gh auth refresh -s admin:public_key`, then `gh auth switch -u cuongbpt-iec`.

**S3.** Back up the files edited later into the new folder `~/ssh-cleanup-backup-2026-10-28/`, which is outside `~/.ssh` so the final listing stays clean: `~/.ssh/config`, `~/.ssh/known_hosts`, `~/.ssh/known_hosts.old`, `~/.gitconfig`. **Do not** back up any private key, because D1 and D7 want them gone.

**S4.** Switch the 11 work remotes in §3 to HTTPS with `git remote set-url`:
- `origin` → `https://github.com/iecgames/<repo>.git`
- `template` → `https://github.com/iecgames/game-template.git`

After each change, `git -C <repo> ls-remote <remote> HEAD` must succeed. If one fails, report that repo and its error, restore that remote's old URL, and continue with the rest.

**S5.** Delete the work key on `cuongbpt-iec`, with the active account:
- List the keys with `gh api user/keys`.
- Find the single entry whose `key` equals the first two space-separated fields of `~/.ssh/id_ed25519.pub` (type plus base64), and delete it with `gh ssh-key delete <id> --yes`.
- If no entry matches, report "not registered" and continue. If more than one matches, stop and ask.

**S6.** Delete the orphan key on Unknownow (`GH_TOKEN` for Unknownow, set inline and never echoed):
- List the keys.
- Check that an entry equal to `~/.ssh/id_ed25519_unknownow.pub` exists. If not, stop: the new key isn't registered, and deleting the old one would lock the user out.
- Delete only the entry equal to `~/.ssh/cuongbpt.pub`, with the same matching rules as S5.
- List again: there must be 4 keys, including the new one.

**S7.** Delete the local files `~/.ssh/id_ed25519`, `~/.ssh/id_ed25519.pub` and `~/.ssh/cuongbpt.pub`. Remove every line starting with `gitlab.com` from `~/.ssh/known_hosts` and `~/.ssh/known_hosts.old`, keeping all other lines unchanged. Afterwards, `known_hosts` has 3 lines and `known_hosts.old` has 1.

**S8.** Rewrite `~/.ssh/config` per §3:
- Remove the comment and `Host github.com` block at lines 6-11.
- Set the `github-personal` `IdentityFile` to `~/.ssh/id_ed25519_unknownow`, keeping `HostName github.com`, `User git` and `IdentitiesOnly yes`.
- Update the header comment, keeping the usage comment `git@github-personal:Unknownow/repo.git`.

The resulting block must be exactly:
```
Host github-personal
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_unknownow
    IdentitiesOnly yes
```

**S9.** Set up the git identities:
- Create `~/.gitconfig-personal` containing `[user]` `name = Cuong Bui` and `email = cuong.bpt82@gmail.com`.
- Append this to the end of `~/.gitconfig`, leaving every existing line as is:
  ```
  [includeIf "gitdir/i:D:/personal/"]
  	path = ~/.gitconfig-personal
  ```
- Set `user.name "Cuong Bui"` and `user.email cuong.bpt82@gmail.com` in `D:/projects/pi-config`'s local repo config (`git config` without `--global`).
- Create the empty folder `D:/personal/`.

**S10.** Run the checks in §6 and report each command with its output in the final message. Delivery has nothing to commit, so this report is the evidence. Leave the S3 backup folder in place.

### 6. Tests
There's no code and no test suite, so these are the verification commands. Each must match:
- `ssh -T git@github-personal` → contains `Hi Unknownow!`. Exit code 1 is normal for GitHub.
- `git -C D:/projects/pi-config ls-remote origin HEAD` → one line containing a hash and `HEAD`.
- `git -C D:/projects/moon-template ls-remote origin HEAD` → one line with a hash. `git -C D:/projects/moon-template remote get-url origin` → `https://github.com/iecgames/moon-template.git`.
- `git -C D:/projects/maze-flow remote get-url template` → `https://github.com/iecgames/game-template.git`.
- `gh auth status --active` → `cuongbpt-iec`. `gh auth status` also lists Unknownow.
- `git -C D:/projects/pi-config config user.email` → `cuong.bpt82@gmail.com`.
- Folder rule:
  - Run `git init` on a temporary `D:/personal/_idcheck`.
  - `git -C D:/personal/_idcheck config user.email` → `cuong.bpt82@gmail.com`, and `user.name` → `Cuong Bui`.
  - `git -C D:/projects/moon-template config user.email` → `cuongbpt@ieccorp.vn`.
  - Delete `D:/personal/_idcheck`; `D:/personal/` stays and is empty.
- `ls ~/.ssh` → exactly `config`, `google_compute_engine`, `google_compute_engine.ppk`, `google_compute_engine.pub`, `id_ed25519_unknownow`, `id_ed25519_unknownow.pub`, `known_hosts`, `known_hosts.old`.
- `grep -c gitlab ~/.ssh/known_hosts ~/.ssh/known_hosts.old` → 0 for both.
- The fetched contents of `https://github.com/Unknownow.keys` → 4 keys, including the `id_ed25519_unknownow.pub` key and not the `cuongbpt.pub` key.
- `git -C D:/projects/pi-config status --porcelain` → no tracked changes caused by this plan.

### 7. Done when
- All 11 work remotes in §3 are HTTPS, and each passed `ls-remote` (or a failure is reported with its error).
- The `id_ed25519` key is no longer on `cuongbpt-iec`. The `cuongbpt.pub` key is no longer on Unknownow, and the new key and the other 3 Unknownow keys remain.
- `~/.ssh` contains exactly the files listed in §6, with no `gitlab.com` known_hosts lines.
- `ssh -T git@github-personal` greets Unknownow, and pushes and fetches in `pi-config` work again.
- Identities: `D:/personal/**` and `pi-config` get `Cuong Bui <cuong.bpt82@gmail.com>`; other repos keep the work identity.
- `gh` has both accounts, and `cuongbpt-iec` is active.
- No tracked file in pi-config has changed.

### 8. Risks, rollback, and what not to touch
- **Wrong key deleted on GitHub.** Match the full key type plus base64 only, never the title. Stop on more than one match. Check the new Unknownow key exists before deleting the orphan. A key deleted by mistake can be added back from the user's local `.pub`, except the work key, which S7 deletes. So do S5 before S7 and stop if S5 is ambiguous.
- **`ssh -T` fails after S8.** Restore `~/.ssh/config` from the S3 backup and report it. The new key isn't touched by any step.
- **Token leak.** Never print `gh auth token` output or any `GH_TOKEN` value, and don't write it to a file.
- **`.gitconfig` damage.** Only append in S9. If `git config --global --list` fails afterwards, restore from the S3 backup.
- **Rollback:** the files in `~/ssh-cleanup-backup-2026-10-28/` are restored to their original places. Remotes are set back with `git remote set-url` to the URLs listed in §3.
- **Do not touch:**
  - `google_compute_engine*`
  - the `github.com` lines in `known_hosts`
  - `~/.gitconfig` `[user]`, `[credential ...]`, `[url ...]` and the other existing sections
  - the non-SSH remotes in the work repos
  - the 3 other Unknownow keys
  - the `game-studio-*` GitHub repos
  - any tracked file in pi-config

### 9. Commits
None. Every change is in machine config (`~/.ssh`, `~/.gitconfig`, `~/.gitconfig-personal`), untracked repo config (`.git/config`) or GitHub account settings. There's nothing to commit, push or merge in pi-config. The §6 report is the delivery evidence.

<!-- pi-workflow:status -->
## Checklist
- [ ] S1 Wait: the user runs `gh auth login -h github.com -s admin:public_key`, logs in as Unknownow in the browser, then runs `g
- [ ] S2 Confirm the starting state:
- [ ] S3 Back up the files edited later into the new folder `~/ssh-cleanup-backup-2026-10-28/`, which is outside `~/.ssh` so the 
- [ ] S4 Switch the 11 work remotes in §3 to HTTPS with `git remote set-url`:
- [ ] S5 Delete the work key on `cuongbpt-iec`, with the active account:
- [ ] S6 Delete the orphan key on Unknownow (`GH_TOKEN` for Unknownow, set inline and never echoed):
- [ ] S7 Delete the local files `~/.ssh/id_ed25519`, `~/.ssh/id_ed25519.pub` and `~/.ssh/cuongbpt.pub`. Remove every line startin
- [ ] S8 Rewrite `~/.ssh/config` per §3:
- [ ] S9 Set up the git identities:
- [ ] S10 Run the checks in §6 and report each command with its output in the final message. Delivery has nothing to commit, so th
