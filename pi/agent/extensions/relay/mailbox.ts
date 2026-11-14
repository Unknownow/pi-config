/** JSONL mailboxes with byte cursors (outbox: worker -> lead; inbox: lead -> worker). Unreadable lines are skipped. */

import * as fs from "node:fs";
import * as path from "node:path";

export type OutMsg =
	| { type: "ask"; id: string; question: string }
	| { type: "approval"; id: string; category: string; item: string; why: string }
	| { type: "done"; summary: string }
	| { type: "note"; text: string };
export type InMsg = { type: "answer"; replyTo: string; text: string } | { type: "approve" | "refuse"; replyTo: string; reason: string };

export const newMsgId = () => `m${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

export function append(file: string, msg: object): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, `${JSON.stringify(msg)}\n`);
}

/** Complete lines from byte `offset`; the new offset ends after the last full line (a half-written tail waits). */
export function readFrom<T = unknown>(file: string, offset: number, onBad?: (line: string) => void): { msgs: T[]; offset: number } {
	let buf: Buffer;
	try {
		buf = fs.readFileSync(file);
	} catch {
		return { msgs: [], offset };
	}
	if (offset > buf.length) offset = 0;
	const end = buf.lastIndexOf(0x0a);
	if (end < offset) return { msgs: [], offset };
	const msgs: T[] = [];
	for (const line of buf.subarray(offset, end + 1).toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			msgs.push(JSON.parse(line) as T);
		} catch {
			onBad?.(line);
		}
	}
	return { msgs, offset: end + 1 };
}

export const loadCursor = (file: string): number => {
	try {
		const n = Number(fs.readFileSync(`${file}.cursor`, "utf8"));
		return Number.isFinite(n) && n >= 0 ? n : 0;
	} catch {
		return 0;
	}
};
export const saveCursor = (file: string, n: number): void => {
	fs.writeFileSync(`${file}.cursor`, String(n));
};

/** New messages since the saved cursor; moves the cursor. */
export function takeNew<T = unknown>(file: string, onBad?: (line: string) => void): T[] {
	const r = readFrom<T>(file, loadCursor(file), onBad);
	saveCursor(file, r.offset);
	return r.msgs;
}

/** The first message answering `replyTo` (worker side: scans the whole inbox). */
export function findReply(file: string, replyTo: string): InMsg | undefined {
	return readFrom<InMsg>(file, 0).msgs.find((m) => m.replyTo === replyTo);
}

export const outboxPath = (jobDir: string) => path.join(jobDir, "outbox.jsonl");
export const inboxPath = (jobDir: string) => path.join(jobDir, "inbox.jsonl");
