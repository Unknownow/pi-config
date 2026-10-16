/** Settings of the worktree extension, read from ~/.pi/agent/worktree.json. Every key is optional. */

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
}

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

export function loadConfig(agentDir: string, workingRepoParent: string): { cfg: WtConfig; warning?: string } {
	const base = defaults(workingRepoParent);
	const file = path.join(agentDir, "worktree.json");
	if (!fs.existsSync(file)) return { cfg: base };
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		return { cfg: base, warning: `worktree.json: bad JSON, using defaults (${(e as Error).message})` };
	}
	const { cfg, warnings } = mergeConfig(raw, base);
	return warnings.length ? { cfg, warning: `worktree.json: ${warnings.join("; ")}` } : { cfg };
}
