/** Runs git and gh without a shell; never throws. The one process runner every relay module uses (and tests replace). */

import { execFile } from "node:child_process";

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}
export interface RunOpts {
	env?: Record<string, string>;
	input?: string;
}
export type Run = (cmd: "git" | "gh", args: string[], cwd: string, opts?: RunOpts) => Promise<RunResult>;

export const run: Run = (cmd, args, cwd, opts) =>
	new Promise((resolve) => {
		const p = execFile(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts?.env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
			const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
			resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
		});
		if (opts?.input !== undefined) p.stdin?.end(opts.input);
	});

/** stdout of a git command, trimmed; throws with git's message when it fails. */
export async function gitOut(r: Run, cwd: string, args: string[], opts?: RunOpts): Promise<string> {
	const res = await r("git", args, cwd, opts);
	if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${(res.stderr || res.stdout).trim().slice(0, 500)}`);
	return res.stdout.trim();
}

/** A fallback author for commits relay makes when the repo has no identity configured. */
export async function identityEnv(r: Run, cwd: string): Promise<Record<string, string>> {
	const name = (await r("git", ["config", "user.name"], cwd)).stdout.trim();
	const email = (await r("git", ["config", "user.email"], cwd)).stdout.trim();
	const env: Record<string, string> = {};
	if (!name) Object.assign(env, { GIT_AUTHOR_NAME: "relay", GIT_COMMITTER_NAME: "relay" });
	if (!email) Object.assign(env, { GIT_AUTHOR_EMAIL: "relay@localhost", GIT_COMMITTER_EMAIL: "relay@localhost" });
	return env;
}
