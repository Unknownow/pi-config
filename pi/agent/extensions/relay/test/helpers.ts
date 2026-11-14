// Temp repos for tests.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const tmpDir = (p = "relay-t-") => fs.mkdtempSync(path.join(os.tmpdir(), p));

export function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repo on `main` with one commit per file in `files`, and (with `remote`) a bare origin it was pushed to. */
export function makeRepo(files: Record<string, string> = { "a.txt": "a1\na2\na3\n", "b.txt": "b\n" }, remote = false): { dir: string; bare?: string } {
	const dir = tmpDir();
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "core.autocrlf", "false");
	git(dir, "config", "user.name", "t");
	git(dir, "config", "user.email", "t@t");
	for (const [f, c] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
		fs.writeFileSync(path.join(dir, f), c);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	if (!remote) return { dir };
	const bare = tmpDir("relay-bare-");
	git(bare, "init", "-q", "--bare", "-b", "main");
	git(dir, "remote", "add", "origin", bare);
	git(dir, "push", "-q", "-u", "origin", "main");
	return { dir, bare };
}

export const cleanup = (...dirs: (string | undefined)[]) => {
	for (const d of dirs) if (d) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
};
