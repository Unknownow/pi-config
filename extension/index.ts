/**
 * pi-config sync extension
 *
 * Keeps this machine's Pi config in step with the pi-config repo, without
 * anyone remembering to run the scripts.
 *
 * The committed `master` of the repo is the only truth: `~/.pi/agent` mirrors it, and config that
 * pi changes on this machine is committed and pushed at once.
 *
 *   session start     under the lock, once per window: (1) repo-state guard, (2) export machine
 *                     changes not yet synced, commit and push them, (3) `git pull --ff-only`
 *                     (cannot fast-forward: fetch + `rebase origin/master`, guarded), (4) import
 *                     the committed HEAD, (5) restart notice when the import wrote anything
 *   config changes    watch ~/.pi/agent; export, commit, optionally push
 *   session shutdown  export machine -> repo, commit, optionally push (waits at most 10 s for the lock)
 *   /pi-config        status / sync / export / import / preview / pull / push, on demand
 *
 * Rules that apply to every automatic operation (startup, watcher, shutdown):
 *
 *   - Repo-state guard: sync runs only when the checkout is on branch `master` and no rebase, merge,
 *     cherry-pick or revert is in progress. Otherwise the window does no automatic sync, logs the
 *     reason once in local/sync.log, and `/pi-config status` shows it (extension/repo-state.ts).
 *   - Cross-window lock: `local/sync.lock` guards every git and sync step across pi windows. A
 *     waiting window polls for 60 s, then skips the run and logs it (extension/sync-lock.ts). The
 *     in-process `serial` queue stays; every window keeps its own watcher.
 *   - Commits touch only `pi/agent/` and read `chore(config): sync from <host>`. A rejected push does
 *     `git fetch`, then `git rebase origin/master` (no autostash, aborted on conflict), pushes once
 *     more, then imports. The rebase runs only when no tracked file differs from HEAD and every
 *     unpushed commit is a sync commit; otherwise it is skipped, logged, and `/pi-config status`
 *     lists the blocking files.
 *   - Import mirrors the committed HEAD, never the working tree (bin/import.js). Export never
 *     overwrites an uncommitted repo edit: it skips the file and logs `conflict <path>`.
 *   - `session_shutdown` and the watcher never fail on a stale `ctx`: UI calls are wrapped and an
 *     error is only logged; the sync work still runs.
 *
 * The extension lives inside the repo it syncs, so cloning the repo on another
 * machine brings the automation with it. Behaviour is configured in
 * `config/sync.json` (shared) and overridden per machine in `local/sync.json`.
 *
 * Nothing here ever touches auth.json — bin/export.js refuses to read it.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { committableMirror } from "./ready.ts";
import { rebaseBlock, repoState, SYNC_BRANCH, SYNC_COMMIT_PREFIX } from "./repo-state.ts";
import { startupSync } from "./startup.ts";
import { acquire, lockHolder, type Lock } from "./sync-lock.ts";

declare const __dirname: string;

// --------------------------------------------------------------------------
// Repo location
// --------------------------------------------------------------------------

/** This file sits at <repo>/extension/index.ts. PI_CONFIG_REPO wins if set. */
function resolveRepo(): string | null {
	const fromEnv = process.env.PI_CONFIG_REPO;
	if (fromEnv && fs.existsSync(path.join(fromEnv, "bin", "export.js"))) return path.resolve(fromEnv);
	try {
		const guess = path.resolve(__dirname, "..");
		if (fs.existsSync(path.join(guess, "bin", "export.js"))) return guess;
	} catch {
		// __dirname unavailable under some loaders — fall through
	}
	return null;
}

const REPO = resolveRepo();

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

interface SyncConfig {
	/** Import the committed repo config into ~/.pi/agent at session start when it differs. */
	autoImportOnStart: boolean;
	/** `git pull --ff-only` (else a guarded rebase onto origin/master) before importing. */
	pullOnStart: boolean;
	/** Export ~/.pi/agent into the repo when the session ends. */
	autoExportOnShutdown: boolean;
	/** Commit whatever the export changed. */
	autoCommit: boolean;
	/** Push the commit; a rejected push rebases onto the remote and retries once. */
	autoPush: boolean;
	/** Watch ~/.pi/agent during the session and sync shortly after the setup changes. */
	autoSyncOnChange: boolean;
	/** Quiet period after the last change before syncing, in milliseconds. */
	syncDebounceMs: number;
	/** Show notifications in the TUI. */
	notify: boolean;
	/** Per-command timeout for git and the sync scripts, in milliseconds. */
	timeoutMs: number;
}

const DEFAULTS: SyncConfig = {
	autoImportOnStart: true,
	pullOnStart: true,
	autoExportOnShutdown: true,
	autoCommit: true,
	autoPush: true,
	autoSyncOnChange: true,
	syncDebounceMs: 5000,
	notify: true,
	timeoutMs: 20000,
};

/** How long a window waits for the cross-window lock before it skips the run. */
const LOCK_WAIT_MS = 60_000;
/** The shutdown path waits less: pi is exiting. What export left on disk is picked up by the next startup. */
const LOCK_WAIT_SHUTDOWN_MS = 10_000;

function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function loadConfig(repo: string): SyncConfig {
	const shared = readJson(path.join(repo, "config", "sync.json")) ?? {};
	const local = readJson(path.join(repo, "local", "sync.json")) ?? {};
	return { ...DEFAULTS, ...shared, ...local } as SyncConfig;
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

/** Appends to <repo>/local/sync.log, which is gitignored. Never throws. */
function log(repo: string, line: string): void {
	try {
		const dir = path.join(repo, "local");
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(path.join(dir, "sync.log"), `${new Date().toISOString()}  ${line}\n`);
	} catch {
		// logging must never break a session
	}
}

/**
 * Show a message in the TUI. A `ctx` from a session that was replaced or reloaded is stale and
 * throws on use ("ctx is stale after session replacement or reload"): that is only logged, the
 * sync work goes on.
 */
function notifyUi(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (!ctx.hasUI) return;
		ctx.ui.notify(message, level);
	} catch (e) {
		if (REPO) log(REPO, `ui notify skipped: ${(e as Error).message}`);
	}
}

function say(ctx: ExtensionContext, cfg: SyncConfig, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (!cfg.notify) return;
	notifyUi(ctx, message, level);
}

// --------------------------------------------------------------------------
// Session state
// --------------------------------------------------------------------------

/**
 * True once an import has written to ~/.pi/agent during this session. Pi keeps
 * settings in memory and rewrites them on exit, so exporting after an import
 * would capture the stale in-memory copy and quietly revert what we just
 * pulled in. Skip the export instead and let the next session handle it.
 * (Pi merges only the settings it changed into the file's current content, so this is a
 * conservative rule: see README "Automatic sync", settings.json.)
 */
let importedThisSession = false;
/** session_start also fires for new/resume/fork; the startup work runs once. */
let startupDone = false;

export default function piConfigSync(pi: ExtensionAPI) {
	if (!REPO) {
		// No repo, no automation. Say nothing at load time; the command explains.
		pi.registerCommand("pi-config", {
			description: "pi-config sync (repo not found)",
			handler: async (_args, ctx) => {
				notifyUi(
					ctx,
					"pi-config repo not found. Set PI_CONFIG_REPO to the clone path, or load this extension from inside the repo.",
					"error",
				);
			},
		});
		return;
	}

	const repo = REPO;
	const localDir = path.join(repo, "local");

	// ----------------------------------------------------------------------
	// Shell helpers
	// ----------------------------------------------------------------------

	const cfg = loadConfig(repo);

	/** The lock this window holds while a job runs; every git and script step checks it first. */
	let held: Lock | null = null;
	function assertHeld(): void {
		if (held?.lost) throw new Error("lock lost");
	}

	async function git(...args: string[]) {
		assertHeld();
		return pi.exec("git", ["-C", repo, ...args], { timeout: cfg.timeoutMs });
	}

	/** Exit code of export.js when the deletions are over the safety cap. */
	const DELETE_CAP_EXIT = 2;
	function capWarning(ctx: ExtensionContext, stdout: string): void {
		const n = (stdout.match(/^\s*WOULD delete\s/gm) ?? []).length;
		say(ctx, cfg, `pi-config: export would delete ${n} file(s), over the safety cap — nothing deleted. See local/sync.log, then run: node bin/export.js --allow-deletes`, "warning");
	}

	async function runScript(script: string, ...args: string[]) {
		assertHeld();
		return pi.exec(process.execPath, [path.join(repo, "bin", script), ...args], {
			cwd: repo,
			timeout: cfg.timeoutMs,
		});
	}

	/**
	 * The path export.js owns — the `~/.pi/agent` mirror. Automatic commits stay
	 * inside it: edits to the extension, the scripts, config/sync.json or the
	 * README are deliberate work, and committing them behind your back on session
	 * exit would be rude.
	 */
	const SYNCED = ["pi"];

	/** `git add`/`git commit` reject a pathspec that matches nothing, so drop absent ones. */
	function syncedPathspec(): string[] {
		const present = SYNCED.filter((rel) => fs.existsSync(path.join(repo, rel)));
		return present.length > 0 ? present : SYNCED.slice(0, 1);
	}

	/** Changed paths relative to the repo root, optionally limited to `SYNCED`. */
	async function dirtyPaths(scope: "synced" | "all" = "synced"): Promise<string[]> {
		// -uall lists each new file, not its folder, so every file is checked on its own.
		// -z keeps paths unquoted; a rename lists its old path as a second entry, which is skipped.
		const args = scope === "synced" ? ["status", "--porcelain", "-z", "-uall", "--", ...syncedPathspec()] : ["status", "--porcelain", "-z", "-uall"];
		const { stdout, code } = await git(...args);
		if (code !== 0) return [];
		const entries = stdout.split("\0");
		const paths: string[] = [];
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (!entry) continue;
			paths.push(entry.slice(3));
			if (entry[0] === "R" || entry[0] === "C") i++;
		}
		return paths;
	}

	/**
	 * One sync operation at a time within this window. The watcher, the shutdown hook and the
	 * command can all fire together. Across windows the lock file does the same job.
	 */
	let queue: Promise<unknown> = Promise.resolve();
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn, fn);
		queue = run.catch(() => undefined);
		return run;
	}

	// ----------------------------------------------------------------------
	// Repo-state guard and cross-window lock
	// ----------------------------------------------------------------------

	/** Why automatic sync is off right now (null: it is on), and the reason last written to the log. */
	let guardReason: string | null = null;
	let guardLogged: string | null = null;

	/** The repo-state guard: null when sync may run, else the reason. Logs a changed reason once. */
	async function checkRepo(): Promise<string | null> {
		const { stdout, code } = await git("rev-parse", "--git-dir");
		const state = code === 0 ? repoState(path.resolve(repo, stdout.trim())) : ({ ok: false, reason: "not a git repository" } as const);
		guardReason = state.ok ? null : state.reason;
		if (guardReason !== guardLogged) {
			log(repo, guardReason ? `no automatic sync: ${guardReason}` : "repo state ok: automatic sync on");
			guardLogged = guardReason;
		}
		return guardReason;
	}

	/** Log what a job returned, except the guard's reason: checkRepo already logged it, once. */
	function logResult(label: string, result: string): void {
		if (!result.startsWith("no automatic sync")) log(repo, `${label}: ${result}`);
	}

	/**
	 * Run `fn` under the cross-window lock and, unless `guard` is false, the repo-state guard.
	 * A busy lock skips the run; a lost lock stops it before its next git step.
	 */
	function locked(label: string, waitMs: number, fn: () => Promise<string>, guard = true): Promise<string> {
		return serial(async () => {
			const lock = await acquire(localDir, { waitMs });
			if (!lock) {
				const holder = lockHolder(localDir);
				log(repo, `${label}: skipped, lock busy${holder ? ` (pid ${holder.pid ?? "?"}, heartbeat ${Math.round(holder.ageMs / 1000)}s ago)` : ""}`);
				return "skipped, lock busy (another pi window is syncing)";
			}
			held = lock;
			try {
				if (guard) {
					const blocked = await checkRepo();
					if (blocked) return `no automatic sync: ${blocked}`;
				}
				return await fn();
			} catch (e) {
				const message = (e as Error).message;
				if (lock.lost || message === "lock lost") {
					log(repo, `${label}: lock lost, stopped before the next git step`);
					return "lock lost: stopped";
				}
				throw e;
			} finally {
				held = null;
				lock.release();
			}
		});
	}

	// ----------------------------------------------------------------------
	// Operations
	// ----------------------------------------------------------------------

	interface ImportResult {
		written: number;
		note: string;
	}

	/** Import the committed HEAD -> machine, but only when a dry run says something would change. */
	async function importIfChanged(): Promise<ImportResult> {
		const preview = await runScript("import.js", "--dry-run");
		if (preview.code !== 0) {
			log(repo, `import dry-run failed: ${preview.stderr.trim()}`);
			return { written: 0, note: "import preview failed" };
		}
		if (!/^\s*WOULD\s/m.test(preview.stdout)) return { written: 0, note: "config already matches the repo" };

		const applied = await runScript("import.js");
		log(repo, `import:\n${applied.stdout.trim()}`);
		if (applied.code !== 0) return { written: 0, note: "import failed — see local/sync.log" };

		const written = (applied.stdout.match(/^\s*(write|delete)\s/gm) ?? []).length;
		if (written === 0) return { written: 0, note: "import changed nothing — see local/sync.log" };
		importedThisSession = true;
		stopWatcher();
		return { written, note: `imported ${written} file(s); restart Pi to apply` };
	}

	function restartNotice(ctx: ExtensionContext, written: number): void {
		say(ctx, cfg, `pi-config: imported ${written} file(s) from the repo — restart Pi to apply`, "warning");
	}

	/** Export machine -> repo, then commit and optionally push what changed. */
	async function exportAndCommit(ctx: ExtensionContext, opts: { commit: boolean; push: boolean }): Promise<string> {
		const exported = await runScript("export.js");
		log(repo, `export:\n${exported.stdout.trim()}`);
		if (exported.code === DELETE_CAP_EXIT) capWarning(ctx, exported.stdout);
		else if (exported.code !== 0) return "export failed — see local/sync.log";
		const skipped = (exported.stdout.match(/^\s*SKIPPED\s/gm) ?? []).length;
		if (skipped > 0) say(ctx, cfg, `pi-config: not syncing ${skipped} file(s) that look like secrets — see local/sync.log`, "warning");
		const conflicts = conflictsIn(exported.stdout);
		if (conflicts.length > 0) say(ctx, cfg, `pi-config: ${conflicts.length} file(s) edited in the repo and on this machine, not synced: ${conflicts.join(", ")}`, "warning");

		const { ready, kept } = committableMirror(repo, await dirtyPaths());
		// Files edited by hand in the repo are never committed here.
		const note = kept.length ? `; kept ${kept.length} hand edit(s), not committed: ${kept.join(", ")}` : "";
		if (ready.length === 0) {
			// Earlier auto-commits may still be waiting for a push.
			if (!opts.push) return `repo already up to date${note}`;
			const ahead = Number((await git("rev-list", "--count", `origin/${SYNC_BRANCH}..HEAD`)).stdout.trim()) || 0;
			if (ahead === 0) return `repo already up to date${note}`;
			const pushed = await push(ctx);
			const result = pushed ? `pushed ${ahead} pending commit(s)` : "push failed — see local/sync.log";
			say(ctx, cfg, `pi-config: ${result}`, pushed ? "info" : "error");
			return result + note;
		}
		if (!opts.commit) return `${ready.length} file(s) changed, left uncommitted: ${ready.join(", ")}${note}`;

		const pathspec = path.join(repo, "local", "commit-paths.txt");
		fs.writeFileSync(pathspec, ready.map((p) => `:(literal)${p}`).join("\n") + "\n");
		const add = await git("add", `--pathspec-from-file=${pathspec}`);
		log(repo, `add (${add.code}): ${add.stderr.trim() || "ok"}`);
		if (add.code !== 0) return "git add failed — see local/sync.log";

		const message = `${SYNC_COMMIT_PREFIX} ${os.hostname()}`;
		const commit = await git("commit", "-m", message, `--pathspec-from-file=${pathspec}`);
		log(repo, `commit (${commit.code}): ${commit.stdout.trim() || commit.stderr.trim()}`);
		if (commit.code !== 0) {
			// Leave nothing staged, or every later commit fails on the same files.
			await git("reset", "-q", `--pathspec-from-file=${pathspec}`);
			const why = (commit.stderr.trim() || commit.stdout.trim()).split(/\r?\n/)[0];
			return `git commit failed (${why}) — see local/sync.log`;
		}

		let result = `committed ${ready.length} change(s): ${ready.join(", ")}`;
		const pushed = opts.push ? await push(ctx) : true;
		if (opts.push) result += pushed ? " and pushed" : " — push failed, see local/sync.log";
		say(ctx, cfg, `pi-config: ${result}`, pushed ? "info" : "error");
		return result + note;
	}

	/** Paths of `conflict <path>  (...)` lines in export.js output. */
	function conflictsIn(stdout: string): string[] {
		return [...stdout.matchAll(/^\s*conflict\s+(\S.*?)\s{2}\(/gm)].map((m) => m[1]);
	}

	/**
	 * Push; if the other machine got there first, fetch and rebase onto origin/master (guarded, see
	 * rebaseOntoOrigin) and push once more. The rebase brings in the other machine's config, so
	 * import it here too — otherwise the next export would write this machine's older copy back over it.
	 */
	async function push(ctx: ExtensionContext): Promise<boolean> {
		const first = await git("push", "origin", SYNC_BRANCH);
		log(repo, `push (${first.code}): ${first.stderr.trim() || first.stdout.trim()}`);
		if (first.code === 0) return true;

		const rebased = await rebaseOntoOrigin();
		if (!rebased.ok) return false;
		const second = await git("push", "origin", SYNC_BRANCH);
		log(repo, `push retry (${second.code}): ${second.stderr.trim() || second.stdout.trim()}`);
		const imported = await importIfChanged();
		log(repo, `import after rebase: ${imported.note}`);
		if (imported.written > 0) restartNotice(ctx, imported.written);
		return second.code === 0;
	}

	/**
	 * Fetch and rebase the local branch onto origin/master. Allowed only when no tracked file differs
	 * from HEAD (so nothing needs an autostash) and every unpushed commit is one of the sync's own
	 * (so the replay cannot touch your work). A conflict is aborted and left to you. No autostash.
	 */
	async function rebaseOntoOrigin(): Promise<{ ok: boolean; note: string }> {
		const fetched = await git("fetch", "origin");
		log(repo, `fetch (${fetched.code}): ${fetched.stderr.trim() || fetched.stdout.trim() || "ok"}`);
		if (fetched.code !== 0) return { ok: false, note: "fetch failed (offline?) — see local/sync.log" };

		const status = await git("status", "--porcelain", "--untracked-files=no");
		const unpushed = await git("log", "--format=%s", `origin/${SYNC_BRANCH}..HEAD`);
		if (status.code !== 0 || unpushed.code !== 0) return { ok: false, note: "rebase skipped: could not read the repo state" };
		const block = rebaseBlock(status.stdout, unpushed.stdout.split(/\r?\n/).filter(Boolean));
		if (block) {
			const why = block.files.length ? `tracked file(s) differ from HEAD: ${block.files.join(", ")}` : `unpushed commit(s) that are not sync commits: ${block.foreign.join("; ")}`;
			log(repo, `rebase skipped: ${why}. The sync commit stays for the next sync.`);
			return { ok: false, note: `rebase skipped: ${why}` };
		}

		const rebase = await git("rebase", `origin/${SYNC_BRANCH}`);
		log(repo, `rebase (${rebase.code}): ${rebase.stdout.trim() || rebase.stderr.trim()}`);
		if (rebase.code !== 0) {
			const abort = await git("rebase", "--abort");
			if (abort.code === 0) log(repo, "rebase: conflict, aborted — resolve in the repo by hand");
			return { ok: false, note: "rebase conflict, aborted — see local/sync.log" };
		}
		return { ok: true, note: "rebased onto origin/master" };
	}

	/** `git pull --ff-only`; when it cannot fast-forward, the same guarded fetch + rebase as a rejected push. */
	async function pull(): Promise<{ ok: boolean; note: string }> {
		const before = (await git("rev-parse", "HEAD")).stdout.trim();
		const ff = await git("pull", "--ff-only");
		log(repo, `pull (${ff.code}): ${ff.stdout.trim() || ff.stderr.trim()}`);
		if (ff.code !== 0) {
			const rebased = await rebaseOntoOrigin();
			return rebased.ok ? rebased : { ok: false, note: `pull failed: ${rebased.note}` };
		}
		const after = (await git("rev-parse", "HEAD")).stdout.trim();
		return { ok: true, note: before === after ? "already up to date" : "pulled" };
	}

	/** Why the last startup skipped its import, shown in /pi-config status. */
	let startupNote: string | null = null;

	async function status(): Promise<string> {
		const guard = await checkRepo();
		const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || "(unknown)";
		const last = (await git("log", "-1", "--format=%h %s (%cr)")).stdout.trim() || "(no commits)";
		const changed = committableMirror(repo, await dirtyPaths("synced")).ready;
		const other = (await dirtyPaths("all")).filter((f) => !changed.includes(f));
		const preview = await runScript("import.js", "--dry-run");
		const previewLines = (preview.stdout.match(/^\s*WOULD\s+(.+)$/gm) ?? []).map((l) => l.trim());
		const wouldDelete = previewLines.filter((l) => /^WOULD delete /.test(l)).map((l) => l.replace(/^WOULD delete /, "").replace(/\s{2}\(.*$/, ""));
		const wouldChange = previewLines.filter((l) => !/^WOULD delete /.test(l));
		const exportPreview = await runScript("export.js", "--dry-run");
		const conflicts = conflictsIn(exportPreview.stdout);

		const holder = lockHolder(localDir);
		const lockLine = holder
			? `pid ${holder.pid ?? "?"}${holder.pid === process.pid ? " (this window)" : ""}, heartbeat ${Math.round(holder.ageMs / 1000)}s ago${holder.stale ? " (stale)" : ""}`
			: "free";

		const lines = [
			`repo        ${repo}`,
			`branch      ${branch}`,
			`repo state  ${guard ? `NO AUTOMATIC SYNC: ${guard}` : `ok (on ${SYNC_BRANCH}, nothing in progress)`}`,
			`lock        ${lockLine}`,
			`last commit ${last}`,
			`uncommitted ${changed.length ? changed.join(", ") : "none"}   (synced paths, auto-committed)`,
			`other edits ${other.length ? other.join(", ") : "none"}   (yours to commit)`,
			`conflicts   ${conflicts.length ? conflicts.join(", ") + "   (edited in the repo and on this machine; export skips them)" : "none"}`,
			`import would change: ${wouldChange.length ? wouldChange.join(" | ") : "nothing"}`,
			`import would delete: ${wouldDelete.length ? wouldDelete.join(", ") : "nothing"}`,
		];
		if (startupNote) lines.push(`startup     ${startupNote}`);

		// A rebase that was skipped leaves sync commits unpushed; say what blocks it.
		const unpushed = await git("log", "--format=%s", `origin/${SYNC_BRANCH}..HEAD`);
		const porcelain = await git("status", "--porcelain", "--untracked-files=no");
		if (unpushed.code === 0 && porcelain.code === 0) {
			const subjects = unpushed.stdout.split(/\r?\n/).filter(Boolean);
			const block = rebaseBlock(porcelain.stdout, subjects);
			if (block && subjects.length > 0) {
				const syncCommits = subjects.filter((s) => s.startsWith(SYNC_COMMIT_PREFIX)).length;
				lines.push(
					`sync paused ${block.files.length ? `blocking files: ${block.files.join(", ")}` : `${block.foreign.length} unpushed commit(s) that are not sync commits`}; ${syncCommits} unpushed sync commit(s)`,
					"            commit or discard your edits to resume sync",
				);
			}
		}
		lines.push(
			"",
			`autoImportOnStart=${cfg.autoImportOnStart}  pullOnStart=${cfg.pullOnStart}`,
			`autoExportOnShutdown=${cfg.autoExportOnShutdown}  autoCommit=${cfg.autoCommit}  autoPush=${cfg.autoPush}`,
			`autoSyncOnChange=${cfg.autoSyncOnChange}  watching=${watcher !== null}`,
		);
		return lines.join("\n");
	}

	// ----------------------------------------------------------------------
	// Change watcher
	// ----------------------------------------------------------------------

	const AGENT = path.join(os.homedir(), ".pi", "agent");
	const DENY_FILES = new Set(["auth.json", "trust.json", "models-store.json"]);
	const MIRROR_DIRS = new Set(["skills", "prompts", "themes", "extensions"]);
	const CONTEXT_FILES = new Set(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"]);
	/** Keep in sync with SECRET_NAME_PATTERNS in bin/lib.js. */
	const SECRET_NAMES = [/(^|[._-])(o?auth|credentials?|secrets?)([._-]|$)/i, /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/];

	/**
	 * A cheap pre-filter mirroring bin/lib.js `inventory()`, so session files and
	 * backups don't wake the exporter every turn. export.js stays the authority.
	 */
	function inScope(rel: string): boolean {
		const parts = rel.split(/[\\/]/).filter(Boolean);
		const name = parts[parts.length - 1] ?? "";
		if (!/\.(js|mjs|cjs|jsx|ts|tsx|md|sh|bat)$/i.test(name) && SECRET_NAMES.some((re) => re.test(name))) return false;
		if (name.startsWith(".") || name.includes(".bak-") || /\.(db|sqlite)(-shm|-wal)?$/.test(name)) return false;
		if (parts.length === 1) return (name.endsWith(".json") && !DENY_FILES.has(name)) || CONTEXT_FILES.has(name);
		if (parts[0] === "npm") return parts.length === 2 && name === "package.json";
		return MIRROR_DIRS.has(parts[0]) && !parts.includes("node_modules");
	}

	let watcher: fs.FSWatcher | null = null;
	let debounce: ReturnType<typeof setTimeout> | null = null;

	function startWatcher(ctx: ExtensionContext): void {
		if (watcher || !cfg.autoSyncOnChange || !fs.existsSync(AGENT)) return;
		try {
			watcher = fs.watch(AGENT, { recursive: true }, (_type, file) => {
				if (!file || !inScope(file.toString())) return;
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(() => {
					debounce = null;
					void syncOnChange(ctx);
				}, cfg.syncDebounceMs);
			});
			watcher.on("error", (e) => {
				log(repo, `watcher error: ${e.message}`);
				stopWatcher();
			});
			log(repo, `watching ${AGENT}`);
		} catch (e) {
			// recursive fs.watch is missing on old Node/Linux; shutdown export still covers it
			log(repo, `watcher unavailable: ${(e as Error).message}`);
			watcher = null;
		}
	}

	function stopWatcher(): void {
		if (debounce) clearTimeout(debounce);
		debounce = null;
		watcher?.close();
		watcher = null;
	}

	async function syncOnChange(ctx: ExtensionContext): Promise<void> {
		// Same reasoning as the shutdown hook: after an import, Pi's view is stale.
		if (importedThisSession) return;
		try {
			const result = await locked("on change", LOCK_WAIT_MS, () => exportAndCommit(ctx, { commit: cfg.autoCommit, push: cfg.autoPush }));
			logResult("on change", result);
		} catch (e) {
			log(repo, `on change failed: ${(e as Error).message}`);
		}
	}

	// ----------------------------------------------------------------------
	// Automatic sync
	// ----------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		if (startupDone || event.reason !== "startup") return;
		startupDone = true;

		try {
			const result = await locked(
				"startup",
				LOCK_WAIT_MS,
				async () => {
					const outcome = await startupSync(
						{
							guard: checkRepo,
							exportAndCommit: async () => {
								// The pre-commit hook in .githooks refuses commits that hold credentials.
								if (fs.existsSync(path.join(repo, ".githooks", "pre-commit"))) await git("config", "core.hooksPath", ".githooks");
								return exportAndCommit(ctx, { commit: cfg.autoCommit, push: cfg.autoPush });
							},
							pull: pull,
							importIfChanged,
							restartNotice: (written) => restartNotice(ctx, written),
							log: (line) => log(repo, line),
						},
						cfg,
					);
					startupNote = outcome.importSkipped ?? null;
					if (outcome.importSkipped) say(ctx, cfg, `pi-config: ${outcome.importSkipped}`, "warning");
					return outcome.ran ? "startup done" : "no automatic sync";
				},
				false,
			);
			logResult("session_start", result);
			// After the import, so its own writes don't trigger a sync.
			if (!importedThisSession) startWatcher(ctx);
		} catch (e) {
			log(repo, `session_start failed: ${(e as Error).message}`);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopWatcher();
		if (!cfg.autoExportOnShutdown) return;
		if (importedThisSession) {
			log(repo, "session_shutdown: skipped export (this session imported; in-memory settings are stale)");
			return;
		}
		try {
			const result = await locked("session_shutdown", LOCK_WAIT_SHUTDOWN_MS, () => exportAndCommit(ctx, { commit: cfg.autoCommit, push: cfg.autoPush }));
			logResult("session_shutdown", result);
		} catch (e) {
			log(repo, `session_shutdown failed: ${(e as Error).message}`);
		}
	});

	// ----------------------------------------------------------------------
	// /pi-config
	// ----------------------------------------------------------------------

	const SUBCOMMANDS = [
		{ value: "status", label: "status - repo, branch, lock, conflicts, drift" },
		{ value: "sync", label: "sync - export, commit, push (same as pi-config.bat sync)" },
		{ value: "export", label: "export - machine -> repo, commit" },
		{ value: "import", label: "import - committed repo -> machine" },
		{ value: "preview", label: "preview - what import would change" },
		{ value: "pull", label: "pull - git pull --ff-only (else guarded rebase)" },
		{ value: "push", label: "push - export, commit, push" },
	];

	pi.registerCommand("pi-config", {
		description: "Sync Pi config with the pi-config repo",
		getArgumentCompletions: (prefix) => {
			const matches = SUBCOMMANDS.filter((c) => c.value.startsWith(prefix.trim()));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase() || "status";
			try {
				switch (sub) {
					case "status":
						notifyUi(ctx, await status(), "info");
						return;
					case "preview": {
						const { stdout } = await runScript("import.js", "--dry-run");
						notifyUi(ctx, stdout.trim() || "nothing to do", "info");
						return;
					}
					case "import":
						notifyUi(ctx, await locked("/pi-config import", LOCK_WAIT_MS, async () => (await importIfChanged()).note), "info");
						return;
					case "export":
						notifyUi(ctx, await locked("/pi-config export", LOCK_WAIT_MS, () => exportAndCommit(ctx, { commit: cfg.autoCommit, push: false })), "info");
						return;
					case "sync":
					case "push":
						notifyUi(ctx, await locked(`/pi-config ${sub}`, LOCK_WAIT_MS, () => exportAndCommit(ctx, { commit: true, push: true })), "info");
						return;
					case "pull":
						notifyUi(ctx, await locked("/pi-config pull", LOCK_WAIT_MS, async () => (await pull()).note), "info");
						return;
					default:
						notifyUi(ctx, `Unknown: ${sub}. Try: ${SUBCOMMANDS.map((c) => c.value).join(", ")}`, "warning");
				}
			} catch (e) {
				log(repo, `/pi-config ${sub} failed: ${(e as Error).message}`);
				notifyUi(ctx, `pi-config ${sub} failed: ${(e as Error).message}`, "error");
			}
		},
	});
}
