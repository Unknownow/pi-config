/**
 * Which mirror changes may be committed automatically. export.js and import.js record a
 * hash of each mirror file as it last moved (`local/sync-state.json`, see bin/lib.js). A
 * file that still matches its record is a machine change: safe to commit. A file that does
 * not match was edited in the repo by hand, so it stays uncommitted. A file missing from the
 * repo is committable only when export marked its record \`{ deleted: true }\`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export type SyncRecord = Record<string, string | { deleted: true }>;

export function readSyncState(repo: string): SyncRecord {
	try {
		return JSON.parse(fs.readFileSync(path.join(repo, "local", "sync-state.json"), "utf8"));
	} catch {
		return {}; // no record yet: nothing is ready to commit
	}
}

/** Split changed repo paths (e.g. `pi/agent/extensions/x/index.ts`) into ready to commit and kept. */
export function committableMirror(repo: string, paths: string[], state = readSyncState(repo)): { ready: string[]; kept: string[] } {
	const ready: string[] = [];
	const kept: string[] = [];
	for (const p of paths) {
		const rel = p.replace(/^pi\/agent\//, "");
		const file = path.join(repo, p);
		const recorded = state[rel];
		// A missing file is committable only when export deleted it on purpose (it marked the record deleted).
		const matches = !fs.existsSync(file)
			? typeof recorded === "object" && recorded !== null && recorded.deleted === true
			: typeof recorded === "string" && createHash("sha256").update(fs.readFileSync(file)).digest("hex") === recorded;
		(matches ? ready : kept).push(p);
	}
	return { ready, kept };
}
