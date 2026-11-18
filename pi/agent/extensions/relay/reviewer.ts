/**
 * Critic and judge entry: loaded with `-e` into their one-shot pi processes. Refuses every tool that is not a reading tool.
 * `RELAY_REVIEW_ALLOW` (comma list) adds tools, for the knowledge MCP.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const READ = new Set(["read", "grep", "find", "ls"]);

/** Why a tool call is refused, or undefined. */
export function reviewerRefusal(tool: string, allow: string[] = []): string | undefined {
	const name = tool.replace(/^.*__/, "");
	if (READ.has(tool) || READ.has(name) || allow.includes(tool) || allow.includes(name)) return undefined;
	return `${tool} is not available to a reviewer: read the code with read, grep, find and ls and report findings.`;
}

export default function reviewer(pi: ExtensionAPI): void {
	const allow = (process.env.RELAY_REVIEW_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	pi.on("tool_call", async (event) => {
		const why = reviewerRefusal(event.toolName, allow);
		return why ? { block: true, reason: why } : undefined;
	});
}
