/**
 * relay: an autonomous lead/worker/judge extension. This session is the lead; real work goes to headless workers in worktree sets.
 * Inert when RELAY_ROLE is set (workers load worker.ts with -e instead; the judge and critic are agents runs). See README.md.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createLead } from "./lead.ts";

export default function relay(pi: ExtensionAPI): void {
	// A worker or reviewer process never runs a lead.
	if (process.env.RELAY_ROLE) return;
	createLead(pi, { Type, getAgentDir, cwd: process.cwd(), relayDir: path.dirname(fileURLToPath(import.meta.url)), dock: { visibleWidth, truncate: truncateToWidth } });
}
