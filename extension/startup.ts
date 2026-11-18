/**
 * The startup sequence of a window, as a pure function over its steps so the order can be tested.
 * The caller runs it once per window, under the cross-window lock:
 *
 *   1. the repo-state guard (master, no rebase/merge/cherry-pick/revert in progress)
 *   2. export machine changes not yet synced, commit and push them (per autoCommit / autoPush)
 *   3. only with pullOnStart: pull; when it cannot fast-forward the caller's guarded rebase path
 *      runs, and when that fails the import is skipped
 *   4. only with autoImportOnStart: import
 *   5. the restart notice, when the import wrote anything
 */

export interface StartupDeps {
	/** The reason sync is not allowed, or null. */
	guard(): Promise<string | null>;
	exportAndCommit(): Promise<string>;
	pull(): Promise<{ ok: boolean; note: string }>;
	importIfChanged(): Promise<{ written: number; note: string }>;
	restartNotice(written: number): void;
	log(line: string): void;
}

export interface StartupResult {
	/** False when the guard blocked the whole run. */
	ran: boolean;
	/** Why the import did not run, when the pull failed. */
	importSkipped?: string;
	written: number;
}

export async function startupSync(deps: StartupDeps, cfg: { pullOnStart: boolean; autoImportOnStart: boolean }): Promise<StartupResult> {
	const blocked = await deps.guard();
	if (blocked) {
		deps.log(`startup: no automatic sync: ${blocked}`);
		return { ran: false, written: 0 };
	}
	deps.log(`startup: ${await deps.exportAndCommit()}`);

	if (cfg.pullOnStart) {
		const pulled = await deps.pull();
		deps.log(`startup pull: ${pulled.note}`);
		if (!pulled.ok) {
			const why = `import skipped: ${pulled.note}`;
			deps.log(`startup: ${why}`);
			return { ran: true, importSkipped: why, written: 0 };
		}
	}
	if (!cfg.autoImportOnStart) return { ran: true, written: 0 };

	const imported = await deps.importIfChanged();
	deps.log(`startup import: ${imported.note}`);
	if (imported.written > 0) deps.restartNotice(imported.written);
	return { ran: true, written: imported.written };
}
