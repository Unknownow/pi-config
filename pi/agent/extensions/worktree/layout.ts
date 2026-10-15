/** Pure helpers: names, paths, the --add-dir value and the terminal launch command. No I/O. */

import type { WtConfig } from "./config.ts";

export const BRANCH_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export function checkName(name: string): string | null {
	if (!name) return "give a name: /wt new <name>";
	if (!BRANCH_RE.test(name)) return `bad name "${name}": use a-z, 0-9, ., _, - (max 40, starting with a letter or digit)`;
	if (name.endsWith(".") || name.endsWith(".lock") || name.includes("..")) return `bad name "${name}" for a git branch`;
	return null;
}

export function rootProblem(root: string): string | null {
	if (!/^([a-zA-Z]:)?\//.test(root.replace(/\\/g, "/"))) return `root "${root}" must be an absolute path`;
	if (/[\s;]/.test(root)) return `root "${root}" must not contain spaces or ";"`;
	return null;
}

export const setRootOf = (cfg: WtConfig, name: string) => `${cfg.root}/${name}`;
export const branchOf = (cfg: WtConfig, name: string) => `${cfg.branchPrefix}${name}`;
export const baseName = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() ?? "";
export const targetOf = (cfg: WtConfig, name: string, repoTop: string) => `${setRootOf(cfg, name)}/${baseName(repoTop)}`;

export const addDirValue = (folders: string[], platform: NodeJS.Platform) =>
	folders.join(platform === "win32" ? ";" : ":");

const backslashes = (p: string) => p.split("/").join(String.fromCharCode(92));

export type LaunchSpec = { file: string; args: string[] } | { print: string };

export interface LaunchOpts {
	platform: NodeJS.Platform;
	launch: WtConfig["launch"];
	wtPath: string | null;
	piCommand: string;
	cwd: string;
	name: string;
	folders: string[];
}

export function launchSpec(o: LaunchOpts): LaunchSpec {
	const flag = o.folders.length ? ["--add-dir", addDirValue(o.folders, o.platform)] : [];
	if (o.platform !== "win32" || o.launch === "none") {
		const dirs = flag.length ? ` --add-dir '${flag[1]}'` : "";
		return { print: `cd ${o.cwd} && ${o.piCommand || "pi"}${dirs}` };
	}
	if (o.wtPath) {
		// Windows Terminal reads ";" as its own command separator, so a literal one is escaped.
		const wtFlag = flag.length ? ["--add-dir", flag[1].replace(/;/g, "\\;")] : [];
		return {
			file: o.wtPath,
			args: ["-w", o.launch === "tab" ? "0" : "new", "new-tab", "-d", o.cwd, "--title", `pi ${o.name}`, o.piCommand, ...wtFlag],
		};
	}
	return { file: "cmd.exe", args: ["/c", "start", `pi ${o.name}`, "/D", backslashes(o.cwd), backslashes(o.piCommand), ...flag] };
}
