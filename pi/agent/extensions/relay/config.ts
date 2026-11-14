/**
 * relay.json: roles, limits and repo policies. Pure: the file path comes from the caller
 * (`RELAY_CONFIG`, else `<agent dir>/relay.json`, see `configPath`), so tests need no pi package.
 * Invalid keys fall back to their defaults and add a warning.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_TOKEN_WEIGHTS, type TokenWeights } from "../shared/tokens.ts";
import { parseRoleSpec, type RoleSpec, THINKING_LEVELS, type Thinking } from "../shared/roles.ts";

export type Size = "small" | "normal" | "large";
export type MergeMode = "after-pass" | "pr-only";
export const CATEGORIES = ["merge", "publish", "comments", "delete", "formats", "deps"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface KnowledgeConfig {
	server: string;
	roles: string[];
	tools: string[];
	env: Record<string, string>;
	judgeCheck: boolean;
}

export interface ReviewRole extends RoleSpec {
	/** Prompt file, relative to the relay folder unless absolute. */
	prompt: string;
	tools: string[];
}

export interface RepoPolicy {
	merge: MergeMode;
	protectedBranches: string[];
	sensitivePaths: string[];
}

export interface RelayConfig {
	active: boolean;
	roles: { critic: ReviewRole; judge: ReviewRole; escalate: RoleSpec; worker: Record<Size, RoleSpec> };
	editBudget: { lines: number; files: number };
	maxJobs: number;
	caps: { critic: number; judge: number; escalate: number; replans: number };
	budget: { wallMin: number; tokens: number; graceMin: number; graceTokenShare: number };
	stallMin: number;
	bashTimeoutMin: number;
	toolTimeouts: { pattern: string; minutes: number }[];
	worker: { extensions: string[] };
	/** Extensions the critic and judge processes load next to reviewer.ts (normally just the model provider). */
	reviewer: { extensions: string[] };
	repos: Record<string, Partial<RepoPolicy>>;
	defaultMerge: MergeMode;
	askUser: Category[];
	knowledge: KnowledgeConfig;
	judge: { maxDiffChars: number };
	tokenWeights: TokenWeights;
	/** The typed-"go" pattern (copied from workflow.json `approvePattern`). */
	approvePattern: string;
	defaults: { protectedBranches: string[]; sensitivePaths: string[] };
}

export const DEFAULT_SENSITIVE_PATHS = ["**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/*.csproj", "**/Packages/manifest.json", ".github/workflows/**", "**/.env*"];

const opus = (thinking: Thinking): RoleSpec => ({ model: "claude-bridge/claude-opus-5-5", thinking });

export const DEFAULTS: RelayConfig = {
	active: true,
	roles: {
		critic: { ...opus("high"), prompt: "prompts/critic.md", tools: ["read", "grep", "find", "ls"] },
		judge: { ...opus("high"), prompt: "prompts/judge.md", tools: ["read", "grep", "find", "ls"] },
		escalate: opus("high"),
		worker: {
			small: { model: "claude-bridge/claude-haiku-5-5", thinking: "medium" },
			normal: { model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
			large: { model: "claude-bridge/claude-opus-5-5", thinking: "medium" },
		},
	},
	editBudget: { lines: 40, files: 3 },
	maxJobs: 3,
	caps: { critic: 3, judge: 3, escalate: 2, replans: 1 },
	budget: { wallMin: 120, tokens: 4_000_000, graceMin: 30, graceTokenShare: 0.1 },
	stallMin: 10,
	bashTimeoutMin: 60,
	toolTimeouts: [],
	worker: { extensions: [] },
	reviewer: { extensions: [] },
	repos: {},
	defaultMerge: "after-pass",
	askUser: [],
	knowledge: {
		server: "knowledge",
		roles: ["critic", "judge"],
		tools: ["search", "get_entry", "get_rule_pack", "get_schema", "status"],
		env: { KNOWLEDGE_OFFLINE: "1" },
		judgeCheck: true,
	},
	judge: { maxDiffChars: 400_000 },
	tokenWeights: { ...DEFAULT_TOKEN_WEIGHTS },
	approvePattern:
		"^((ok(ay)?|yes|yeah|yep|sure|alright|fine|great|good)[,.! ]+)?(then[, ]+)?(go|go ahead|go for it|do it|do that|do this|do them|do (it )?all( of (it|that|them))?|approved?|lgtm|ship it|execute( it| that| this| the plan)?|proceed|start|let'?s go|let'?s do it|run it|implement( it| that| this| the plan)?|build it|make it so)( for me)?( now)?( please)?[.! ]*$",
	defaults: { protectedBranches: ["main", "master"], sensitivePaths: DEFAULT_SENSITIVE_PATHS },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** `<agent dir>/relay.json`, or `RELAY_CONFIG`. */
export function configPath(agentDir: string, env: Record<string, string | undefined> = process.env): string {
	return env.RELAY_CONFIG || path.join(agentDir, "relay.json");
}

export interface Loaded {
	config: RelayConfig;
	warnings: string[];
}

function roleSpec(raw: unknown, fallback: RoleSpec, where: string, warn: (s: string) => void): RoleSpec {
	if (raw === undefined) return fallback;
	if (!isObject(raw) || typeof raw.model !== "string") {
		warn(`${where}: expected {model, thinking?}; using the default`);
		return fallback;
	}
	const spec = parseRoleSpec(raw.thinking ? `${raw.model}:${raw.thinking}` : raw.model);
	if (typeof spec === "string") {
		warn(`${where}: ${spec}; using the default`);
		return fallback;
	}
	return spec;
}

function num(raw: unknown, fallback: number, where: string, warn: (s: string) => void, min = 0): number {
	if (raw === undefined) return fallback;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min) {
		warn(`${where}: expected a number >= ${min}; using ${fallback}`);
		return fallback;
	}
	return raw;
}

/** Applies defaults to raw JSON. */
export function parseConfig(raw: unknown): Loaded {
	const warnings: string[] = [];
	const warn = (s: string) => warnings.push(s);
	const c: RelayConfig = structuredClone(DEFAULTS);
	if (raw === undefined || raw === null) return { config: c, warnings };
	if (!isObject(raw)) return { config: c, warnings: ["relay.json: expected an object; using the defaults"] };

	if (raw.active !== undefined) {
		if (typeof raw.active === "boolean") c.active = raw.active;
		else warn("active: expected a boolean; using true");
	}
	if (isObject(raw.roles)) {
		const r = raw.roles;
		for (const name of ["critic", "judge"] as const) {
			const o = r[name];
			if (o === undefined) continue;
			const spec = roleSpec(o, c.roles[name], `roles.${name}`, warn);
			c.roles[name] = { ...c.roles[name], ...spec };
			if (isObject(o) && typeof o.prompt === "string") c.roles[name].prompt = o.prompt;
			if (isObject(o) && o.tools !== undefined) {
				if (isStrings(o.tools)) c.roles[name].tools = o.tools;
				else warn(`roles.${name}.tools: expected a list of names; using the default`);
			}
		}
		c.roles.escalate = roleSpec(r.escalate, c.roles.escalate, "roles.escalate", warn);
		if (isObject(r.worker)) for (const s of ["small", "normal", "large"] as const) c.roles.worker[s] = roleSpec(r.worker[s], c.roles.worker[s], `roles.worker.${s}`, warn);
		else if (r.worker !== undefined) warn("roles.worker: expected {small, normal, large}; using the defaults");
	} else if (raw.roles !== undefined) warn("roles: expected an object; using the defaults");

	if (isObject(raw.editBudget)) {
		c.editBudget.lines = num(raw.editBudget.lines, c.editBudget.lines, "editBudget.lines", warn, 1);
		c.editBudget.files = num(raw.editBudget.files, c.editBudget.files, "editBudget.files", warn, 1);
	}
	c.maxJobs = num(raw.maxJobs, c.maxJobs, "maxJobs", warn, 1);
	if (isObject(raw.caps)) for (const k of Object.keys(c.caps) as (keyof RelayConfig["caps"])[]) c.caps[k] = num(raw.caps[k], c.caps[k], `caps.${k}`, warn, 0);
	if (isObject(raw.budget)) for (const k of Object.keys(c.budget) as (keyof RelayConfig["budget"])[]) c.budget[k] = num(raw.budget[k], c.budget[k], `budget.${k}`, warn, 0);
	c.stallMin = num(raw.stallMin, c.stallMin, "stallMin", warn, 1);
	c.bashTimeoutMin = num(raw.bashTimeoutMin, c.bashTimeoutMin, "bashTimeoutMin", warn, 1);

	if (raw.toolTimeouts !== undefined) {
		if (Array.isArray(raw.toolTimeouts) && raw.toolTimeouts.every((t) => isObject(t) && typeof t.pattern === "string" && typeof t.minutes === "number" && t.minutes > 0)) {
			c.toolTimeouts = raw.toolTimeouts.map((t) => ({ pattern: String(t.pattern), minutes: Number(t.minutes) }));
		} else warn("toolTimeouts: expected [{pattern, minutes}]; using none");
	}
	if (isObject(raw.worker)) {
		if (raw.worker.extensions === undefined) {
			// keep the default
		} else if (isStrings(raw.worker.extensions)) c.worker.extensions = raw.worker.extensions;
		else warn("worker.extensions: expected a list of paths; using none");
	}
	if (isObject(raw.reviewer)) {
		if (isStrings(raw.reviewer.extensions)) c.reviewer.extensions = raw.reviewer.extensions;
		else if (raw.reviewer.extensions !== undefined) warn("reviewer.extensions: expected a list of paths; using none");
	}
	if (raw.repos !== undefined) {
		if (!isObject(raw.repos)) warn("repos: expected an object; using none");
		else {
			for (const [k, v] of Object.entries(raw.repos)) {
				if (!isObject(v)) {
					warn(`repos.${k}: expected an object; skipped`);
					continue;
				}
				const p: Partial<RepoPolicy> = {};
				if (v.merge === "after-pass" || v.merge === "pr-only") p.merge = v.merge;
				else if (v.merge !== undefined) warn(`repos.${k}.merge: expected "after-pass" or "pr-only"; using the default`);
				if (isStrings(v.protectedBranches)) p.protectedBranches = v.protectedBranches;
				else if (v.protectedBranches !== undefined) warn(`repos.${k}.protectedBranches: expected a list; using the default`);
				if (isStrings(v.sensitivePaths)) p.sensitivePaths = v.sensitivePaths;
				else if (v.sensitivePaths !== undefined) warn(`repos.${k}.sensitivePaths: expected a list; using the default`);
				c.repos[k] = p;
			}
		}
	}
	if (raw.defaultMerge === "after-pass" || raw.defaultMerge === "pr-only") c.defaultMerge = raw.defaultMerge;
	else if (raw.defaultMerge !== undefined) warn(`defaultMerge: expected "after-pass" or "pr-only"; using "${DEFAULTS.defaultMerge}"`);
	if (raw.askUser !== undefined) {
		if (isStrings(raw.askUser) && raw.askUser.every((x) => (CATEGORIES as readonly string[]).includes(x))) c.askUser = raw.askUser as Category[];
		else warn(`askUser: expected a list of ${CATEGORIES.join(", ")}; using none`);
	}
	if (isObject(raw.knowledge)) {
		const k = raw.knowledge;
		if (typeof k.server === "string") c.knowledge.server = k.server;
		if (isStrings(k.roles)) c.knowledge.roles = k.roles;
		if (isStrings(k.tools)) c.knowledge.tools = k.tools;
		if (isObject(k.env)) c.knowledge.env = Object.fromEntries(Object.entries(k.env).map(([a, b]) => [a, String(b)]));
		if (typeof k.judgeCheck === "boolean") c.knowledge.judgeCheck = k.judgeCheck;
	}
	if (isObject(raw.judge)) c.judge.maxDiffChars = num(raw.judge.maxDiffChars, c.judge.maxDiffChars, "judge.maxDiffChars", warn, 1000);
	if (isObject(raw.tokenWeights)) for (const k of Object.keys(c.tokenWeights) as (keyof TokenWeights)[]) c.tokenWeights[k] = num(raw.tokenWeights[k], c.tokenWeights[k], `tokenWeights.${k}`, warn, 0);
	if (typeof raw.approvePattern === "string") {
		try {
			new RegExp(raw.approvePattern, "i");
			c.approvePattern = raw.approvePattern;
		} catch {
			warn("approvePattern: not a valid regular expression; using the default");
		}
	}
	warnings.push(...longToolWarnings(c));
	return { config: c, warnings };
}

/** Tool patterns whose timeout is longer than the default wall budget: the budget would end first. */
export function longToolWarnings(c: RelayConfig): string[] {
	return c.toolTimeouts.filter((t) => t.minutes > c.budget.wallMin).map((t) => `toolTimeouts "${t.pattern}" (${t.minutes} min) is longer than the default wall budget (${c.budget.wallMin} min): a job that runs it gets its budget raised at dispatch`);
}

/** The tool timeout (minutes) a text matches (first pattern wins), else undefined. */
export function toolTimeoutFor(c: RelayConfig, text: string): number | undefined {
	for (const t of c.toolTimeouts) {
		try {
			if (new RegExp(t.pattern, "i").test(text)) return t.minutes;
		} catch {
			// an invalid pattern never matches
		}
	}
	return undefined;
}

export function loadConfig(file: string): Loaded {
	if (!fs.existsSync(file)) return parseConfig(undefined);
	try {
		return parseConfig(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (e) {
		const r = parseConfig(undefined);
		r.warnings.push(`${file}: ${(e as Error).message}; using the defaults`);
		return r;
	}
}

/** Writes one role's model back (for `/relay model`). Keeps other keys; creates the file when missing. */
export function saveRole(file: string, role: "critic" | "judge" | "escalate" | "worker.small" | "worker.normal" | "worker.large", spec: RoleSpec): void {
	const raw: Record<string, any> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	raw.roles ??= {};
	const [a, b] = role.split(".");
	if (b) {
		raw.roles[a] ??= {};
		raw.roles[a][b] = { model: spec.model, ...(spec.thinking ? { thinking: spec.thinking } : {}) };
	} else {
		raw.roles[a] = { ...(isObject(raw.roles[a]) ? raw.roles[a] : {}), model: spec.model, ...(spec.thinking ? { thinking: spec.thinking } : {}) };
	}
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
}

export { THINKING_LEVELS };

/** The policy of a repo: the first `repos` key matching its path (exact, `**` glob, or `owner/name` suffix), over the defaults. */
export function repoPolicy(c: RelayConfig, repoPath: string): RepoPolicy {
	const norm = repoPath.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
	let hit: Partial<RepoPolicy> = {};
	for (const [key, pol] of Object.entries(c.repos)) {
		const k = key.split("\\").join("/").replace(/\/+$/, "").toLowerCase();
		const re = new RegExp(`^${k.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		if (re.test(norm) || (!k.includes("*") && !/^([a-z]:)?\//.test(k) && norm.endsWith(`/${k}`))) {
			hit = pol;
			break;
		}
	}
	return {
		merge: hit.merge ?? c.defaultMerge,
		protectedBranches: hit.protectedBranches ?? c.defaults.protectedBranches,
		sensitivePaths: hit.sensitivePaths ?? c.defaults.sensitivePaths,
	};
}
