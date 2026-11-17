/**
 * The public API of the agents extension: the one file other extensions import from agents.
 * Re-exports only; the code lives in the files named below. See README.md "Contract".
 */

// Running a subagent process.
export { addUsage, emptyUsage, expandHome, mapLimit, type RunOptions, type RunResult, runSubagent, type SubagentEvent, type ToolCall } from "./subagent.ts";
export { type EventSink, knowledgeFor, type McpServer, type RoleRun, type RoleRunResult, runRole } from "./run-role.ts";

// The reviewer roles.
export { collectDiffParts, type CriticRequest, criticPrompt, type DiffPart, fitDiffs, type JudgeRequest, judgePrompt, type ReviewResult, reviewVerdict, runCritic, runJudge } from "./review.ts";
export { type Finding, isClean, judgeVerdict, parseFindings } from "../shared/findings.ts";

// Cost.
export { costOf, modelMultiplier } from "./cost.ts";

// Role config.
export { AGENT_ROLES, type AgentRole, type AgentsConfig, CONFIG_PATH, DEFAULTS, loadConfig, parseModelCost, saveRole } from "./config.ts";
export type { KnowledgeConfig } from "./types.ts";

// Rendering of run rows.
export { renderRuns, type ToolDetails, toolProgress } from "./render.ts";

// Prompts.
export { ADVISOR, CRITIC, EXPLORE, JUDGE, JUDGE_INCREMENTAL, judgeKnowledgeStep, knowledgeTools, PACE, RUNNER } from "./prompts.ts";

// Knowledge tools.
export { forwardedServers, roleTools, toolPrefix } from "./knowledge.ts";

// Cross-process resource lock.
export { acquireLock, type HeldLock, type LockOptions } from "./lock.ts";
