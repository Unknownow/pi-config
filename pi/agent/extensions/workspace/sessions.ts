/** Session files for launching and moving: the header-only file of a new session, a custom entry appended to one, and the newest session of a folder. */

import { randomUUID } from "node:crypto";
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

/**
 * Appends a custom entry (like pi's `appendCustomEntry`) to a session file no pi process has open: a header-only file or a fresh
 * fork. Its parent is the file's last entry, so it becomes the leaf the session opens on.
 */
export function appendCustomEntry(file: string, customType: string, data: unknown, now: () => Date = () => new Date()): void {
	const ids = new Set<string>();
	let parentId: string | null = null;
	for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as { type?: unknown; id?: unknown };
			if (e.type !== "session" && typeof e.id === "string") {
				ids.add(e.id);
				parentId = e.id;
			}
		} catch {
			// a torn line is not an entry
		}
	}
	let id = randomUUID().slice(0, 8);
	while (ids.has(id)) id = randomUUID().slice(0, 8);
	fs.appendFileSync(file, `${JSON.stringify({ type: "custom", customType, data, id, parentId, timestamp: now().toISOString() })}\n`);
}

