/**
 * pi-config sync extension
 *
 * Keeps this machine's Pi config in step with the pi-config repo, without
 * anyone remembering to run the scripts.
 *
 *   session start     optional `git pull --ff-only`, then import repo -> machine
 *   config changes    watch ~/.pi/agent; export, commit, optionally push
 *   session shutdown  export machine -> repo, commit, optionally push
 *   /pi-config        status / sync / export / import / preview / pull / push, on demand
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
	/** Import repo config into ~/.pi/agent at session start when it differs. */
	autoImportOnStart: boolean;
	/** `git pull --ff-only` before importing. Off by default: it touches the network. */
	pullOnStart: boolean;
	/** Export ~/.pi/agent into the repo when the session ends. */
	autoExportOnShutdown: boolean;
	/** Commit whatever the export changed. */
	autoCommit: boolean;
	/** Push the commit. Off by default: publishing is the user's call. */
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
	pullOnStart: false,
	autoExportOnShutdown: true,
	autoCommit: true,
	autoPush: false,
	autoSyncOnChange: true,
	syncDebounceMs: 5000,
	notify: true,
	timeoutMs: 20000,
};

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

function say(ctx: ExtensionContext, cfg: SyncConfig, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (!cfg.notify || !ctx.hasUI) return;
	ctx.ui.notify(message, level);
}

// --------------------------------------------------------------------------
// Session state
// --------------------------------------------------------------------------

/**
 * True once an import has written to ~/.pi/agent during this session. Pi keeps
 * settings in memory and rewrites them on exit, so exporting after an import
 * would capture the stale in-memory copy and quietly revert what we just
 * pulled in. Skip the export instead and let the next session handle it.
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
				ctx.ui.notify(
					"pi-config repo not found. Set PI_CONFIG_REPO to the clone path, or load this extension from inside the repo.",
					"error",
				);
			},
		});
		return;
	}

	const repo = REPO;

	// ----------------------------------------------------------------------
	// Shell helpers
	// ----------------------------------------------------------------------

	const cfg = loadConfig(repo);

	async function git(...args: string[]) {
		return pi.exec("git", ["-C", repo, ...args], { timeout: cfg.timeoutMs });
	}

	async function runScript(script: string, ...args: string[]) {
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
		const args = scope === "synced" ? ["status", "--porcelain", "--", ...syncedPathspec()] : ["status", "--porcelain"];
		const { stdout, code } = await git(...args);
		if (code !== 0) return [];
		return stdout
			.split(/\r?\n/)
			.map((l) => l.slice(3).trim())
			.filter(Boolean);
	}

	async function isGitRepo(): Promise<boolean> {
		const { code } = await git("rev-parse", "--git-dir");
		return code === 0;
	}

	/**
	 * One sync operation at a time. The watcher, the shutdown hook and the
	 * command can all fire together, and two exports racing into one git index
	 * produce half-staged commits.
	 */
	let queue: Promise<unknown> = Promise.resolve();
	function serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = queue.then(fn, fn);
		queue = run.catch(() => undefined);
		return run;
	}

	// ----------------------------------------------------------------------
	// Operations
	// ----------------------------------------------------------------------

	/** Import repo -> machine, but only when a dry run says something would change. */
	async function importIfChanged(ctx: ExtensionContext): Promise<string> {
		const preview = await runScript("import.js", "--dry-run");
		if (preview.code !== 0) {
			log(repo, `import dry-run failed: ${preview.stderr.trim()}`);
			return "import preview failed";
		}
		if (!/^\s*WOULD\s/m.test(preview.stdout)) return "config already matches the repo";

		const applied = await runScript("import.js");
		log(repo, `import:\n${applied.stdout.trim()}`);
		if (applied.code !== 0) return "import failed — see local/sync.log";

		importedThisSession = true;
		const written = (applied.stdout.match(/^\s*write\s/gm) ?? []).length;
		say(ctx, cfg, `pi-config: imported ${written} file(s) from the repo — restart Pi to apply`, "warning");
		return `imported ${written} file(s); restart Pi to apply`;
	}

	/** Export machine -> repo, then commit and optionally push what changed. */
	async function exportAndCommit(ctx: ExtensionContext, opts: { commit: boolean; push: boolean }): Promise<string> {
		const exported = await runScript("export.js");
		log(repo, `export:\n${exported.stdout.trim()}`);
		if (exported.code !== 0) return "export failed — see local/sync.log";

		const changed = await dirtyPaths();
		if (changed.length === 0) {
			// Earlier auto-commits may still be waiting for a push.
			if (!opts.push) return "repo already up to date";
			const ahead = Number((await git("rev-list", "--count", "@{u}..HEAD")).stdout.trim()) || 0;
			if (ahead === 0) return "repo already up to date";
			const push = await git("push");
			log(repo, `push (${push.code}): ${push.stderr.trim() || push.stdout.trim()}`);
			const result = push.code === 0 ? `pushed ${ahead} pending commit(s)` : "push failed — see local/sync.log";
			say(ctx, cfg, `pi-config: ${result}`, push.code === 0 ? "info" : "error");
			return result;
		}
		if (!opts.commit) return `${changed.length} file(s) changed, left uncommitted: ${changed.join(", ")}`;

		const pathspec = syncedPathspec();
		const add = await git("add", "--", ...pathspec);
		log(repo, `add (${add.code}): ${add.stderr.trim() || "ok"}`);
		if (add.code !== 0) return "git add failed — see local/sync.log";

		const message = `chore(config): sync from ${os.hostname()}`;
		const commit = await git("commit", "-m", message, "--", ...pathspec);
		log(repo, `commit (${commit.code}): ${commit.stdout.trim() || commit.stderr.trim()}`);
		if (commit.code !== 0) return "git commit failed — see local/sync.log";

		let result = `committed ${changed.length} change(s): ${changed.join(", ")}`;
		if (opts.push) {
			const push = await git("push");
			log(repo, `push (${push.code}): ${push.stderr.trim() || push.stdout.trim()}`);
			result += push.code === 0 ? " and pushed" : " — push failed, see local/sync.log";
		}
		say(ctx, cfg, `pi-config: ${result}`, "info");
		return result;
	}

	async function pull(): Promise<string> {
		const { code, stdout, stderr } = await git("pull", "--ff-only");
		log(repo, `pull (${code}): ${stdout.trim() || stderr.trim()}`);
		if (code !== 0) return "pull failed (diverged or offline) — see local/sync.log";
		return stdout.includes("Already up to date") ? "already up to date" : "pulled";
	}

	async function status(): Promise<string> {
		const branch = (await git("rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() || "(unknown)";
		const last = (await git("log", "-1", "--format=%h %s (%cr)")).stdout.trim() || "(no commits)";
		const changed = await dirtyPaths("synced");
		const other = (await dirtyPaths("all")).filter((f) => !changed.includes(f));
		const preview = await runScript("import.js", "--dry-run");
		const wouldChange = (preview.stdout.match(/^\s*WOULD\s+(.+)$/gm) ?? []).map((l) => l.trim());

		const lines = [
			`repo        ${repo}`,
			`branch      ${branch}`,
			`last commit ${last}`,
			`uncommitted ${changed.length ? changed.join(", ") : "none"}   (synced paths, auto-committed)`,
			`other edits ${other.length ? other.join(", ") : "none"}   (yours to commit)`,
			`import would change: ${wouldChange.length ? wouldChange.join(" | ") : "nothing"}`,
			"",
			`autoImportOnStart=${cfg.autoImportOnStart}  pullOnStart=${cfg.pullOnStart}`,
			`autoExportOnShutdown=${cfg.autoExportOnShutdown}  autoCommit=${cfg.autoCommit}  autoPush=${cfg.autoPush}`,
			`autoSyncOnChange=${cfg.autoSyncOnChange}  watching=${watcher !== null}`,
		];
		return lines.join("\n");
	}

	// ----------------------------------------------------------------------
	// Change watcher
	// ----------------------------------------------------------------------

	const AGENT = path.join(os.homedir(), ".pi", "agent");
	const DENY_FILES = new Set(["auth.json", "trust.json", "models-store.json"]);
	const MIRROR_DIRS = new Set(["skills", "prompts", "themes", "extensions"]);

	/**
	 * A cheap pre-filter mirroring bin/lib.js `inventory()`, so session files and
	 * backups don't wake the exporter every turn. export.js stays the authority.
	 */
	function inScope(rel: string): boolean {
		const parts = rel.split(/[\\/]/).filter(Boolean);
		const name = parts[parts.length - 1] ?? "";
		if (name.startsWith(".") || name.includes(".bak-") || /\.(db|sqlite)(-shm|-wal)?$/.test(name)) return false;
		if (parts.length === 1) return name.endsWith(".json") && !DENY_FILES.has(name);
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
			const result = await serial(() => exportAndCommit(ctx, { commit: cfg.autoCommit, push: cfg.autoPush }));
			log(repo, `on change: ${result}`);
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
			if (!(await isGitRepo())) {
				log(repo, "session_start: not a git repo, skipping");
				return;
			}
			await serial(async () => {
				if (cfg.pullOnStart) {
					const pulled = await pull();
					if (pulled !== "already up to date") say(ctx, cfg, `pi-config: ${pulled}`, "info");
				}
				if (cfg.autoImportOnStart) await importIfChanged(ctx);
			});
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
			if (!(await isGitRepo())) return;
			const result = await serial(() => exportAndCommit(ctx, { commit: cfg.autoCommit, push: cfg.autoPush }));
			log(repo, `session_shutdown: ${result}`);
		} catch (e) {
			log(repo, `session_shutdown failed: ${(e as Error).message}`);
		}
	});

	// ----------------------------------------------------------------------
	// /pi-config
	// ----------------------------------------------------------------------

	const SUBCOMMANDS = [
		{ value: "status", label: "status - repo, branch, drift" },
		{ value: "sync", label: "sync - export, commit, push (same as pi-config.bat sync)" },
		{ value: "export", label: "export - machine -> repo, commit" },
		{ value: "import", label: "import - repo -> machine" },
		{ value: "preview", label: "preview - what import would change" },
		{ value: "pull", label: "pull - git pull --ff-only" },
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
						ctx.ui.notify(await serial(status), "info");
						return;
					case "preview": {
						const { stdout } = await runScript("import.js", "--dry-run");
						ctx.ui.notify(stdout.trim() || "nothing to do", "info");
						return;
					}
					case "import":
						ctx.ui.notify(await serial(() => importIfChanged(ctx)), "info");
						if (importedThisSession) stopWatcher();
						return;
					case "export":
						ctx.ui.notify(await serial(() => exportAndCommit(ctx, { commit: cfg.autoCommit, push: false })), "info");
						return;
					case "sync":
					case "push":
						ctx.ui.notify(await serial(() => exportAndCommit(ctx, { commit: true, push: true })), "info");
						return;
					case "pull":
						ctx.ui.notify(await serial(pull), "info");
						return;
					default:
						ctx.ui.notify(`Unknown: ${sub}. Try: ${SUBCOMMANDS.map((c) => c.value).join(", ")}`, "warning");
				}
			} catch (e) {
				log(repo, `/pi-config ${sub} failed: ${(e as Error).message}`);
				ctx.ui.notify(`pi-config ${sub} failed: ${(e as Error).message}`, "error");
			}
		},
	});
}
