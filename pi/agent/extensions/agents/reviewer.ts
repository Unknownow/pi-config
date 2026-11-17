/**
 * Subagent-only extension of the judge and critic processes: refuses every tool that is not a reading
 * tool (read, grep, find, ls). `PI_AGENTS_REVIEW_ALLOW` (comma list) adds tools, for the knowledge MCP.
 * Loaded with `-e`; pi loads only index.ts from this folder, so the main session never runs it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REVIEW_ALLOW_ENV = "PI_AGENTS_REVIEW_ALLOW";

const READ = new Set(["read", "grep", "find", "ls"]);

/** The allow list in the env value. */
export function parseAllow(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Why a tool call is refused, or undefined. A reading tool may come through a prefix (`x__read`); allowed tools match by full name. */
export function reviewerRefusal(tool: string, allow: string[] = []): string | undefined {
	const name = tool.replace(/^.*__/, "");
	if (READ.has(tool) || READ.has(name) || allow.includes(tool)) return undefined;
	return `${tool} is not available to a reviewer: read the code with read, grep, find and ls and report findings.`;
}

export default function reviewer(pi: ExtensionAPI): void {
	const allow = parseAllow(process.env[REVIEW_ALLOW_ENV]);
	pi.on("tool_call", async (event) => {
		const why = reviewerRefusal(event.toolName, allow);
		return why ? { block: true, reason: why } : undefined;
	});
}
