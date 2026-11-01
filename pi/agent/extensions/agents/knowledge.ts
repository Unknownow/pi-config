/** Team knowledge tools for the subagents: which tool names a role gets and which MCP server config is forwarded. Pure functions. */
import type { KnowledgeConfig } from "./types.ts";

/** `mcp__<server>__`, with the server name normalized like pi's tool names. */
export function toolPrefix(server: string): string {
	return `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__`;
}

/** Tools that write; never handed to a subagent, whatever the config says. */
const WRITE_TOOLS = new Set(["propose_entry"]);

/** Knowledge tool names `role` gets; [] when the role is not in `cfg.roles`. */
export function roleTools(role: string, cfg: KnowledgeConfig): string[] {
	return cfg.server && cfg.roles.includes(role) ? cfg.tools.filter((t) => !WRITE_TOOLS.has(t)).map((t) => toolPrefix(cfg.server) + t) : [];
}

/**
 * The server config for subagents: as registered, plus `cfg.env` for stdio servers, with its tools
 * exposed directly (the subagents name them in --tools). {} when not registered.
 */
export function forwardedServers(registered: { name: string; config: object }[], cfg: KnowledgeConfig): Record<string, Record<string, unknown>> {
	const found = cfg.server ? registered.find((r) => r.name === cfg.server) : undefined;
	if (!found) return {};
	const config = { ...(found.config as Record<string, unknown>) };
	if (typeof config.command === "string") config.env = { ...((config.env as Record<string, string> | undefined) ?? {}), ...cfg.env };
	config.exposure = "direct";
	delete config.toolExposure;
	return { [cfg.server]: config };
}
