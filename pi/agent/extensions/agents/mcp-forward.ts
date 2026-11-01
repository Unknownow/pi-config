/**
 * Subagent-only extension: registers the MCP servers the workflow forwards in PI_WORKFLOW_MCP
 * (JSON: server name -> config, the mcp.json shape). Loaded with `-e` next to `-e builtin:mcp`;
 * pi loads only index.ts from this folder, so the main session never runs it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FORWARD_ENV = "PI_WORKFLOW_MCP";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The forwarded servers; anything malformed is dropped. */
export function parseForwarded(raw: string | undefined): Record<string, Record<string, unknown>> {
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.error(`workflow mcp-forward: ${FORWARD_ENV} is not valid JSON`);
		return {};
	}
	if (!isObject(parsed)) return {};
	return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, Record<string, unknown>] => isObject(e[1])));
}

export default function mcpForward(pi: ExtensionAPI): void {
	for (const [name, config] of Object.entries(parseForwarded(process.env[FORWARD_ENV]))) {
		try {
			pi.registerMcpServer(name, config as never);
		} catch (e) {
			console.error(`workflow mcp-forward: ${name}: ${(e as Error).message}`);
		}
	}
}
