/** The roles' models and runRole, the workflow's own subagent runs with their knowledge tools. */
import * as fs from "node:fs";
import type { RoleSpec, Role } from "../config.ts";
import * as prompts from "../prompts.ts";
import { subagentMetric } from "../metrics.ts";
import { loadConfig as loadAgentsConfig, forwardedServers, roleTools, knowledgeFor as agentsKnowledgeFor, type RunResult, runSubagent } from "../../agents/api.ts";
import type { SubRole, FlowRun } from "../view.ts";
import { type Flow, FORWARD_EXTENSION } from "./context.ts";
import { recordMetric } from "./plan-files.ts";

/** The model of a role from workflow.json or, for explore, advisor and runner, agents.json. */
export const roleSpecOf = (fl: Flow, r: string): RoleSpec => (fl.cfg.roles as Record<string, RoleSpec>)[r];

/** The model of a workflow role, or of agents' judge or critic (agents.json, `/agents model`). */
export const modelOf = (fl: Flow, role: Role | "judge" | "critic"): RoleSpec => (role === "judge" || role === "critic" ? loadAgentsConfig().config.roles[role] : fl.cfg.roles[role]);

// ----------------------------------------------------------------------
// Subagent helpers
// ----------------------------------------------------------------------

/** The knowledge tools and server config a workflow subagent role (the arbiter) gets, or undefined when knowledge is off for it. */
export function knowledgeFor(fl: Flow, role: string): { tools: string[]; servers: Record<string, Record<string, unknown>> } | undefined {
	const k = { ...fl.cfg.knowledge, judgeCheck: false };
	if (!k.server || !k.roles.includes(role) || !fs.existsSync(FORWARD_EXTENSION)) return undefined;
	const servers = forwardedServers(fl.pi.getMcpServers(), k);
	return servers[k.server] ? { tools: roleTools(role, k), servers } : undefined;
}

/** The knowledge server whose check agents' judge runs (agents.json `knowledge`, with `judgeCheck` on), or undefined. */
export function judgeKnowledgeServer(fl: Flow): string | undefined {
	const k = agentsKnowledgeFor("judge", fl.pi.getMcpServers());
	return k && loadAgentsConfig().config.knowledge.judgeCheck ? k.server : undefined;
}

/** Runs a workflow role (arbiter, commit) as a subagent with a live row in the view; `onChange` fires on every update. */
export async function runRole(fl: Flow, 
	role: Role & SubRole,
	label: string,
	opts: { systemPrompts: string[]; tools: string[]; task: string; cwd: string; signal?: AbortSignal; env?: Record<string, string>; extensions?: string[]; timeoutMs?: number },
	onChange?: (run: FlowRun) => void,
): Promise<{ result: RunResult; run: FlowRun }> {
	const spec = fl.cfg.roles[role];
	const run = fl.view.start(role, label, spec.model);
	onChange?.(run);
	const { extensions, timeoutMs, ...rest } = opts;
	const k = knowledgeFor(fl, role);
	const started = Date.now();
	const result = await runSubagent({
		...rest,
		tools: k ? [...rest.tools, ...k.tools] : rest.tools,
		systemPrompts: k ? [...rest.systemPrompts, prompts.knowledgeTools(k.tools)] : rest.systemPrompts,
		mcp: k ? { servers: k.servers, extension: FORWARD_EXTENSION } : undefined,
		role: spec,
		extensions: extensions ? [...fl.cfg.subagent.extensions, ...extensions] : fl.cfg.subagent.extensions,
		timeoutMs: timeoutMs ?? fl.cfg.subagent.timeoutMs,
		idleTimeoutMs: fl.cfg.subagent.idleTimeoutMs,
		onEvent: (e) => {
			fl.view.event(run, e, opts.cwd);
			onChange?.(run);
		},
	});
	recordMetric(fl, subagentMetric(role, label, run.stage, result.model ?? spec.model, started, Date.now(), result));
	if (!result.ok) fl.view.finish(run, false, result.error ?? "failed");
	return { result, run };
}
