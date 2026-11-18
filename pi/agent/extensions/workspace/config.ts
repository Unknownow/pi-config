/** Settings of the workspace extension, read from ~/.pi/agent/workspace.json (else the old worktree.json). Every key is optional. */

import * as fs from "node:fs";
import * as path from "node:path";

export interface WtConfig {
	root: string;
	branchPrefix: string;
	launch: "window" | "tab" | "none";
	piCommand: string;
	link: string[];
	copy: string[];
	unityGuard: boolean;
	vscode: boolean;
	autoUpdate: boolean;
	/** `/folders add` inside a set attaches the repo's worktree in the set. */
	addFolderWorktree: boolean;
	rebaseUnpushed: boolean;
	/** Days a backup ref of a discarded workspace is kept; 0 keeps them forever. */
	backupDays: number;
	/** Rules files (AGENTS.md, CLAUDE.md) of added folders: "paths" lists them in the prompt, "full" loads their text. */
	addedFolderRules: "paths" | "full";
}

export const CONFIG_FILE = "workspace.json";
/** The file's name before the extension was renamed; read when workspace.json is missing. */
export const OLD_CONFIG_FILE = "worktree.json";

export const DEFAULT_LINK = [".pi/git", ".pi/npm", "node_modules"];
export const DEFAULT_COPY = ["unity/Assets/IecGenerated", "unity/Assets/IecGenerated.meta"];

const slash = (p: string) => p.replace(/\\/g, "/");

export function defaults(workingRepoParent: string): WtConfig {
	return {
		root: `${slash(workingRepoParent).replace(/\/+$/, "")}/wt`,
		branchPrefix: "wt/",
		launch: "window",
		piCommand: "",
		link: [...DEFAULT_LINK],
		copy: [...DEFAULT_COPY],
		unityGuard: true,
		vscode: true,
		autoUpdate: true,
		addFolderWorktree: true,
		rebaseUnpushed: true,
		backupDays: 30,
		addedFolderRules: "paths",
	};
}

const strings = (v: unknown): string[] | null =>
	Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;

/** Merge parsed JSON over the defaults; returns the config and the problems found. */
export function mergeConfig(raw: unknown, base: WtConfig): { cfg: WtConfig; warnings: string[] } {
	const cfg = { ...base };
	const warnings: string[] = [];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { cfg, warnings: ["not a JSON object"] };
	const o = raw as Record<string, unknown>;
	if (typeof o.root === "string" && o.root) cfg.root = slash(o.root).replace(/\/+$/, "");
	if (typeof o.branchPrefix === "string") cfg.branchPrefix = o.branchPrefix;
	if (typeof o.piCommand === "string") cfg.piCommand = o.piCommand;
	if (typeof o.unityGuard === "boolean") cfg.unityGuard = o.unityGuard;
	if (o.autoUpdate !== undefined) {
		if (typeof o.autoUpdate === "boolean") cfg.autoUpdate = o.autoUpdate;
		else warnings.push("autoUpdate must be true or false");
	}
	if (o.addFolderWorktree !== undefined) {
		if (typeof o.addFolderWorktree === "boolean") cfg.addFolderWorktree = o.addFolderWorktree;
		else warnings.push("addFolderWorktree must be true or false");
	}
	if (o.rebaseUnpushed !== undefined) {
		if (typeof o.rebaseUnpushed === "boolean") cfg.rebaseUnpushed = o.rebaseUnpushed;
		else warnings.push("rebaseUnpushed must be true or false");
	}
	if (o.backupDays !== undefined) {
		if (typeof o.backupDays === "number" && Number.isFinite(o.backupDays) && o.backupDays >= 0) cfg.backupDays = o.backupDays;
		else warnings.push("backupDays must be a number of days, 0 or more");
	}
	if (o.addedFolderRules !== undefined) {
		if (o.addedFolderRules === "paths" || o.addedFolderRules === "full") cfg.addedFolderRules = o.addedFolderRules;
		else warnings.push(`addedFolderRules must be "paths" or "full"`);
	}
	if (o.vscode !== undefined) {
		if (typeof o.vscode === "boolean") cfg.vscode = o.vscode;
		else warnings.push("vscode must be true or false");
	}
	if (o.launch !== undefined) {
		if (o.launch === "window" || o.launch === "tab" || o.launch === "none") cfg.launch = o.launch;
		else warnings.push(`unknown launch ${JSON.stringify(o.launch)}, using "window"`);
	}
	for (const key of ["link", "copy"] as const) {
		if (o[key] === undefined) continue;
		const list = strings(o[key]);
		if (list) cfg[key] = list;
		else warnings.push(`${key} must be a list of strings`);
	}
	return { cfg, warnings };
}

/**
 * The config of `agentDir`: workspace.json, else worktree.json (then `notice` asks to rename it; the caller shows it once),
 * else the defaults.
 */
export function loadConfig(agentDir: string, workingRepoParent: string): { cfg: WtConfig; warning?: string; notice?: string } {
	const base = defaults(workingRepoParent);
	let name = CONFIG_FILE;
	let notice: string | undefined;
	if (!fs.existsSync(path.join(agentDir, name)) && fs.existsSync(path.join(agentDir, OLD_CONFIG_FILE))) {
		name = OLD_CONFIG_FILE;
		notice = `workspace: read ${OLD_CONFIG_FILE}; rename it to ${CONFIG_FILE} (in ${slash(agentDir)})`;
	}
	const file = path.join(agentDir, name);
	if (!fs.existsSync(file)) return { cfg: base };
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return { cfg: base, warning: `${name}: bad JSON, using defaults (${(e as Error).message})`, ...(notice ? { notice } : {}) };
	}
	const { cfg, warnings } = mergeConfig(raw, base);
	return { cfg, ...(warnings.length ? { warning: `${name}: ${warnings.join("; ")}` } : {}), ...(notice ? { notice } : {}) };
}
