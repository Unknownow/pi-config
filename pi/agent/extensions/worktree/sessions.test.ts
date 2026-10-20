// node --experimental-strip-types --test sessions.test.ts
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { latestSession, newSessionFile } from "./sessions.ts";

test("newSessionFile writes a header-only session file", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"));
	const f = newSessionFile("D:/p/game", { create: () => ({ file: undefined, id: "abc", dir }), version: 3, now: () => new Date("2026-10-21T10:00:00.123Z") });
	assert.equal(path.basename(f), "2026-10-21T10-00-00-123Z_abc.jsonl");
	const lines = fs.readFileSync(f, "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	assert.deepEqual(JSON.parse(lines[0]), { type: "session", version: 3, id: "abc", timestamp: "2026-10-21T10:00:00.123Z", cwd: path.resolve("D:/p/game") });
	const g = newSessionFile("x", { create: () => ({ file: path.join(dir, "sub", "own.jsonl"), id: "q", dir }), version: 3 });
	assert.equal(g, path.join(dir, "sub", "own.jsonl"));
	assert.throws(() => newSessionFile("x", { create: () => ({ file: g, id: "q", dir }), version: 3 }));
});

test("latestSession picks the newest after the limit", () => {
	const l = [{ path: "a", modified: new Date(1000) }, { path: "b", modified: new Date(3000) }, { path: "c", modified: new Date(2000) }];
	assert.equal(latestSession(l, 0), "b");
	assert.equal(latestSession(l, 3000), null);
	assert.equal(latestSession([], 0), null);
});

// pi is only resolvable when the extension runs inside pi, so this round trip is skipped when the package is missing.
test("a header written for a real pi session loads in pi", async (t) => {
	let pi: any;
	try {
		pi = await import("@earendil-works/pi-coding-agent");
	} catch {
		return t.skip("pi package not resolvable from the test folder");
	}
	const { CURRENT_SESSION_VERSION, SessionManager } = pi;
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sess-cwd-"));
	const f = newSessionFile(cwd, {
		create: (c: string) => {
			const m = SessionManager.create(c);
			return { file: m.getSessionFile(), id: m.getSessionId(), dir: m.getSessionDir() };
		},
		version: CURRENT_SESSION_VERSION,
	});
	const head = JSON.parse(fs.readFileSync(f, "utf8").split(String.fromCharCode(10))[0]);
	assert.equal(head.version, CURRENT_SESSION_VERSION);
	assert.match(head.id, /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
	assert.equal(SessionManager.open(f).getCwd(), path.resolve(cwd));
});
