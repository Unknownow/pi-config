/**
 * Runs one agents role as a subagent: the role's model and thinking from agents.json, the knowledge
 * tools when the role gets them, a run row, the `agents:subagent-finished` event and the usage file.
 * The tools of index.ts and the API functions (runJudge, runCritic) all go through `runRole`; the
 * caller passes the per-process inputs (event bus, registered MCP servers), so nothing here holds `pi`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvent, endRun, newRun, type RunView } from "../shared/runs.ts";
import { DEFAULT_TOKEN_WEIGHTS } from "../shared/tokens.ts";
import { type AgentRole, loadConfig } from "./config.ts";
import { costOf } from "./cost.ts";
import { appendUsage, USAGE_FILE_ENV } from "./env.ts";
import { forwardedServers, roleTools } from "./knowledge.ts";
import { knowledgeTools } from "./prompts.ts";
import { noContextFilesFor, type RunOptions, type RunResult, runSubagent } from "./subagent.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Subagent-only extension that registers forwarded MCP servers (see mcp-forward.ts). */
export const FORWARD_EXTENSION = path.join(HERE, "mcp-forward.ts");
/** The agents extension itself (index.ts), for another pi process to load with `-e` (a relay worker). */
export const AGENTS_EXTENSION = path.join(HERE, "index.ts");
/** Subagent-only extension that guards the runners' bash (see runner-guard.ts). */
export const RUNNER_GUARD_EXTENSION = path.join(HERE, "runner-guard.ts");
/** Subagent-only extension that keeps judge and critic read-only (see reviewer.ts). */
export const REVIEWER_EXTENSION = path.join(HERE, "reviewer.ts");

/** The part of `pi.events` the runs use. */
export interface EventSink {
	emit(name: string, data: unknown): void;
}

/** An MCP server as `pi.getMcpServers()` lists it. */
export interface McpServer {
	name: string;
	config: unknown;
}

/** The knowledge tools and forwarded server config `role` gets; undefined when knowledge is off for it or `mcpServers` is missing. */
export function knowledgeFor(role: string, mcpServers: McpServer[] | undefined): { server: string; tools: string[]; servers: Record<string, Record<string, unknown>> } | undefined {
	const k = loadConfig().config.knowledge;
	if (!mcpServers || !k.server || !k.roles.includes(role) || !fs.existsSync(FORWARD_EXTENSION)) return undefined;
	const servers = forwardedServers(mcpServers as { name: string; config: object }[], k);
	return servers[k.server] ? { server: k.server, tools: roleTools(role, k), servers } : undefined;
}

export interface RoleRun {
	role: AgentRole;
	/** The row's label. */
	label: string;
	systemPrompts: string[];
	tools: string[];
	task: string;
	cwd: string;
	signal?: AbortSignal;
	env?: Record<string, string>;
	/** Added after agents.json `subagent.extensions`. */
	extensions?: string[];
	timeoutMs?: number;
	/** Idle limit of the run; default agents.json `subagent.idleTimeoutMs`. */
	idleTimeoutMs?: number;
	/** The caller's project trust, passed to the subagent (`-a` / `-na`); unset passes neither. */
	trusted?: boolean;
	/** `pi.events`; the finished run is emitted on it as `agents:subagent-finished`. */
	events?: EventSink;
	/** `pi.getMcpServers()`; without it the role gets no knowledge tools. */
	mcpServers?: McpServer[];
	/** The system-prompt text for the knowledge tools; default `knowledgeTools`. */
	knowledgePrompt?: (tools: string[], server: string) => string;
	/** Called with the run row on every update. */
	onRun?: (run: RunView) => void;
	/** Id of the run row; default a number counted in this module. */
	runId?: number;
	/** Test hook: replaces runSubagent. */
	runner?: (opts: RunOptions) => Promise<RunResult>;
}

export interface RoleRunResult {
	result: RunResult;
	run: RunView;
	/** The model that ran (from the reply, else the configured one). */
	model: string;
	/** Cost-weighted tokens × the model's multiplier (cost.ts), not dollars. */
	weightedCost: number;
	/** The knowledge tools the run had; [] without knowledge. */
	knowledgeTools: string[];
}

let nextRunId = 1;

export async function runRole(o: RoleRun): Promise<RoleRunResult> {
	const cfg = loadConfig().config;
	const spec = cfg.roles[o.role];
	const run = newRun(o.runId ?? nextRunId++, o.role, o.label, spec.model);
	o.onRun?.(run);
	const k = knowledgeFor(o.role, o.mcpServers);
	const started = Date.now();
	const result = await (o.runner ?? runSubagent)({
		systemPrompts: k ? [...o.systemPrompts, (o.knowledgePrompt ?? knowledgeTools)(k.tools, k.server)] : o.systemPrompts,
		tools: k ? [...o.tools, ...k.tools] : o.tools,
		task: o.task,
		cwd: o.cwd,
		signal: o.signal,
		env: o.env,
		noContextFiles: noContextFilesFor(o.role, cfg.explore.contextFiles),
		mcp: k ? { servers: k.servers, extension: FORWARD_EXTENSION } : undefined,
		role: spec,
		extensions: o.extensions ? [...cfg.subagent.extensions, ...o.extensions] : cfg.subagent.extensions,
		timeoutMs: o.timeoutMs ?? cfg.subagent.timeoutMs,
		idleTimeoutMs: o.idleTimeoutMs ?? cfg.subagent.idleTimeoutMs,
		...(o.trusted !== undefined ? { trusted: o.trusted } : {}),
		onEvent: (e) => {
			applyEvent(run, e, o.cwd, DEFAULT_TOKEN_WEIGHTS);
			o.onRun?.(run);
		},
	});
	if (!result.ok) endRun(run, false, result.error ?? "failed");
	const model = result.model ?? spec.model;
	const weightedCost = costOf(result.usage, model, cfg.modelCost);
	o.events?.emit("agents:subagent-finished", {
		role: o.role,
		label: o.label,
		ms: Date.now() - started,
		usage: result.usage,
		model,
		ok: result.ok,
		error: result.error,
		bootMs: result.bootMs,
		turns: result.turns,
		tools: result.toolCalls.length,
		// Cost-weighted input-token equivalents × the model's modelCost multiplier; pi's dollar figure stays in usage.cost.
		weightedCost,
	});
	appendUsage(process.env[USAGE_FILE_ENV], { role: o.role, model, usage: result.usage, weightedCost, ok: result.ok, at: new Date().toISOString() });
	return { result, run, model, weightedCost, knowledgeTools: k?.tools ?? [] };
}
