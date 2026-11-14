/** How relay starts a `pi` process (workers, critic, judge). `RELAY_PI_BIN` lets tests substitute a fake. */

import * as fs from "node:fs";
import * as path from "node:path";

/** Same resolution as Pi's subagent example: re-run the CLI script under the current runtime. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

/** The command and arguments that start pi with `args`. `RELAY_PI_BIN`: a .mjs/.js/.ts file runs under this runtime, anything else runs as a command. */
export function piCommand(args: string[], env: Record<string, string | undefined> = process.env): { command: string; args: string[] } {
	const bin = env.RELAY_PI_BIN;
	if (!bin) return piInvocation(args);
	if (/\.(mjs|js|ts)$/i.test(bin)) {
		const typed = /\.ts$/i.test(bin) ? ["--experimental-strip-types"] : [];
		return { command: process.execPath, args: [...typed, bin, ...args] };
	}
	return { command: bin, args };
}
