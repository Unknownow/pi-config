/**
 * agents.json lives next to workflow.json in ~/.pi/agent. Missing keys fall back to DEFAULTS and
 * unknown keys are ignored; `/flow model explore|advisor|runner ...` writes the roles back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type KnowledgeConfig, type RoleSpec, THINKING_LEVELS } from "./types.ts";

export const AGENT_ROLES = ["explore", "advisor", "runner"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** The runner side of test_run. */
export interface TestRunConfig {
	/** Runners at once; tasks sharing a resource always run one after another. 1 = one at a time. */
	concurrency: number;
	/** Tasks one test_run call may carry. */
	maxTasks: number;
	/** One runner's time limit. */
	runnerTimeoutMs: number;
	/** The runners' tools (regular names; no edit or write). */
	runnerTools: string[];
	/** Commands runners may not run, as regexes over the command's words or the whole text. */
	runnerDeny: string[];
	/** Flags whose value is a project path that must lie inside the session's folders. */
	runnerPathFlags: string[];
	/** Environment variable names that runners may not set (use the path flags instead). */
	runnerPathEnv: string[];
}

export interface AgentsConfig {
	roles: Record<AgentRole, RoleSpec>;
	explore: {
		maxQueries: number;
		concurrency: number;
		tools: string[];
		/** Explore subagents load AGENTS.md / CLAUDE.md files when true; off keeps them cheap. */
		contextFiles: boolean;
	};
	advisor: { tools: string[]; maxTranscriptChars: number };
	test: TestRunConfig;
	knowledge: KnowledgeConfig;
	subagent: {
		extensions: string[];
		timeoutMs: number;
		/** Ends a subagent that writes nothing this long while no tool runs; 0 turns it off. */
		idleTimeoutMs: number;
	};
}

export const DEFAULTS: AgentsConfig = {
	roles: {
		explore: { model: "claude-bridge/claude-haiku-5-5", thinking: "medium" },
		advisor: { model: "claude-bridge/claude-opus-5-5", thinking: "medium" },
		runner: { model: "claude-bridge/claude-haiku-5-5", thinking: "low" },
	},
	explore: { maxQueries: 8, concurrency: 8, tools: ["read", "grep", "find", "ls"], contextFiles: false },
	advisor: { tools: ["read", "grep", "find", "ls"], maxTranscriptChars: 1_500_000 },
	test: {
		concurrency: 4,
		maxTasks: 8,
		runnerTimeoutMs: 45 * 60_000,
		runnerTools: ["bash", "read", "grep", "find", "ls"],
		runnerDeny: [
			"^adb( -[sdetHP] \\S+)* (reboot|reboot-bootloader|sideload|root|unroot|remount|disable-verity|enable-verity)\\b",
			"^adb\\b.*\\bshell\\b.*(\\brm\\s+-[a-z]*r|\\bwipe\\b|\\brecovery\\b|\\bfactory\\b|\\bformat\\b|\\breboot\\b)",
			"^fastboot\\b",
		],
		runnerPathFlags: ["--project-path", "-projectPath"],
		runnerPathEnv: ["UNITY_PROJECT_PATH"],
	},
	knowledge: {
		server: "knowledge",
		roles: ["explore", "advisor"],
		tools: ["search", "get_entry", "get_rule_pack", "get_schema", "status"],
		env: { KNOWLEDGE_OFFLINE: "1" },
		judgeCheck: true,
	},
	subagent: {
		extensions: ["~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts"],
		timeoutMs: 15 * 60_000,
		idleTimeoutMs: 5 * 60_000,
	},
};

export const CONFIG_PATH = path.join(getAgentDir(), "agents.json");

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays and scalars replace. Only keys of `base` are taken, so unknown keys are dropped. */
function merge<T>(base: T, over: unknown): T {
	if (!isObject(base)) return (over === undefined || over === null || typeof over !== typeof base || Array.isArray(over) !== Array.isArray(base) ? base : over) as T;
	if (!isObject(over)) return base;
	const out: Record<string, unknown> = { ...base };
	for (const k of Object.keys(base)) if (k in over) out[k] = merge((base as Record<string, unknown>)[k], over[k]);
	return out as T;
}

type Loaded = { config: AgentsConfig; error?: string };
let cache: { file: string; key: string; result: Loaded } | null = null;

/** Parsed again only when the file's mtime, ctime or size changed; `saveRole` clears the cache. */
export function loadConfig(file = CONFIG_PATH): Loaded {
	let key: string;
	try {
		const st = fs.statSync(file);
		key = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
	} catch {
		cache = null;
		return { config: DEFAULTS };
	}
	if (cache && cache.file === file && cache.key === key) return cache.result;
	const result = parseConfig(file);
	cache = { file, key, result };
	return result;
}

const num = (v: unknown, min: number, max = Infinity): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function parseConfig(file: string): Loaded {
	try {
		const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		const config = merge(DEFAULTS, raw);
		for (const r of AGENT_ROLES) {
			const spec = config.roles[r];
			if (typeof spec?.model !== "string" || !spec.model) config.roles[r] = DEFAULTS.roles[r];
			else if (spec.thinking !== undefined && !THINKING_LEVELS.includes(spec.thinking)) config.roles[r] = { model: spec.model };
		}
		const e = config.explore;
		if (!num(e.maxQueries, 1, 32)) e.maxQueries = DEFAULTS.explore.maxQueries;
		if (!num(e.concurrency, 1)) e.concurrency = DEFAULTS.explore.concurrency;
		if (!strings(e.tools)) e.tools = DEFAULTS.explore.tools;
		if (typeof e.contextFiles !== "boolean") e.contextFiles = DEFAULTS.explore.contextFiles;
		const a = config.advisor;
		if (!strings(a.tools)) a.tools = DEFAULTS.advisor.tools;
		if (!num(a.maxTranscriptChars, 1000)) a.maxTranscriptChars = DEFAULTS.advisor.maxTranscriptChars;
		const t = config.test;
		if (!num(t.concurrency, 1)) t.concurrency = DEFAULTS.test.concurrency;
		if (!num(t.maxTasks, 1, 16)) t.maxTasks = DEFAULTS.test.maxTasks;
		if (typeof t.runnerTimeoutMs !== "number" || !Number.isFinite(t.runnerTimeoutMs) || t.runnerTimeoutMs < 60_000) t.runnerTimeoutMs = DEFAULTS.test.runnerTimeoutMs;
		for (const k of ["runnerTools", "runnerDeny", "runnerPathFlags", "runnerPathEnv"] as const) if (!strings(t[k])) t[k] = DEFAULTS.test[k];
		const k = config.knowledge;
		if (typeof k.server !== "string") k.server = DEFAULTS.knowledge.server;
		if (!strings(k.roles)) k.roles = DEFAULTS.knowledge.roles;
		if (!strings(k.tools)) k.tools = DEFAULTS.knowledge.tools;
		if (!isObject(k.env) || Object.values(k.env).some((v) => typeof v !== "string")) k.env = DEFAULTS.knowledge.env;
		const s = config.subagent;
		if (!strings(s.extensions)) s.extensions = DEFAULTS.subagent.extensions;
		if (typeof s.timeoutMs !== "number" || !Number.isFinite(s.timeoutMs) || s.timeoutMs <= 0) s.timeoutMs = DEFAULTS.subagent.timeoutMs;
		if (typeof s.idleTimeoutMs !== "number" || !Number.isFinite(s.idleTimeoutMs) || s.idleTimeoutMs < 0) s.idleTimeoutMs = DEFAULTS.subagent.idleTimeoutMs;
		return { config };
	} catch (err) {
		return { config: DEFAULTS, error: `${file}: ${(err as Error).message}` };
	}
}

/** Updates one role in agents.json, leaving the rest of the file as it was. */
export function saveRole(role: AgentRole, spec: RoleSpec, file = CONFIG_PATH): void {
	const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	raw.roles = { ...(raw.roles ?? {}), [role]: spec };
	fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
	cache = null;
}
