/** Session files for launching and moving: the header-only file of a new session and the newest session of a folder. */

import * as fs from "node:fs";
import * as path from "node:path";

export interface NewSessionDeps {
	/** `SessionManager.create(cwd)` reduced to what is needed. */
	create: (cwd: string) => { file: string | undefined; id: string; dir: string };
	version: number;
	now?: () => Date;
}

/** Write a session file holding only its header and return its path. pi stores a session lazily, so this makes `pi --session <file>` find it. */
export function newSessionFile(cwd: string, deps: NewSessionDeps): string {
	const m = deps.create(cwd);
	const now = (deps.now ?? (() => new Date()))().toISOString();
	const file = m.file ?? path.join(m.dir, `${now.replace(/[:.]/g, "-")}_${m.id}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const header = { type: "session", version: deps.version, id: m.id, timestamp: now, cwd: path.resolve(cwd) };
	fs.writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: "wx" });
	return file;
}

export interface SessionLite {
	path: string;
	modified: Date;
}

/** The newest listed session modified after `after` (epoch ms), or null. */
export function latestSession(list: SessionLite[], after: number): string | null {
	let best: SessionLite | null = null;
	for (const s of list) if (s.modified.getTime() > after && (!best || s.modified > best.modified)) best = s;
	return best?.path ?? null;
}
