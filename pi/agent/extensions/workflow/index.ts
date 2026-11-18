/**
 * Workflow extension: one model per job.
 *
 *   you -> plan (Opus, high) -> approve -> execute (Sonnet, medium) -> judge (Opus) -> commit
 *                                             |-- explore (Haiku, parallel): file:line only
 *                                             `-- advisor (Opus): reads the full transcript at decision points
 *
 *   escalation (manual)  /flow escalate -> Fable, /flow back -> the phase's own model
 *   context guard        compact at ~140k tokens on every model, once the run settles
 *
 * plan and execute switch the main session's model. explore, advisor and judge
 * are tools of the agents extension that run in a separate `pi` process; the
 * flow's code review is agents' runJudge, its plan and discussion reviews agents'
 * runCritic (all through ../agents/api.ts). The workflow roles' models come from
 * ~/.pi/agent/workflow.json (`/flow model`); judge and critic from agents.json.
 *
 * view.ts draws it live: the pipeline above the editor with the active stage
 * and its model, plus a row per running subagent with what it is doing now.
 *
 * This file is only the wiring. The code is in flow/ (see README.md, "Code layout"):
 * plain functions that take the session's shared context `fl: Flow` (flow/context.ts) first.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFlow, type Flow } from "./flow/context.ts";
import { registerTools } from "./flow/tools.ts";
import { registerHooks } from "./flow/hooks.ts";
import { registerCommands } from "./flow/commands.ts";

export default function workflow(pi: ExtensionAPI) {
	register(createFlow(pi));
}

/** Registers everything, in this order: the flag, the tools, the event hooks, the commands. `/folders` and `--add-dir` belong to the workspace extension. */
function register(fl: Flow): void {
	fl.pi.registerFlag("flow", {
		description: "Workflow phase to start in: discuss, plan, execute, test or off (default from workflow.json)",
		type: "string",
	});

	registerTools(fl);
	registerHooks(fl);
	registerCommands(fl);
}
