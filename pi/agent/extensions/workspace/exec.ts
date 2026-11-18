/** Runs a program without `pi.exec`, for code that runs after `ctx.switchSession()`, when the captured `pi` is stale. */

import { execFile } from "node:child_process";
import type { GitResult } from "./git-ops.ts";

/** A function like `Git`/`Gh` for `cmd`; never throws: a missing program or a timeout is a failed result. */
export function execRunner(cmd: string, timeout: number): (cwd: string, args: string[]) => Promise<GitResult> {
	return (cwd, args) =>
		new Promise((resolve) => {
			try {
				execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
					if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
					const code = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
					resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || err.message });
				});
			} catch (e) {
				resolve({ code: 1, stdout: "", stderr: (e as Error).message });
			}
		});
}
