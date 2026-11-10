/**
 * quiet-tools extension: alt+o or /quiet hides finished tool rows in the transcript so only the
 * messages and answers remain; a running tool shows one dim line. See README.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth } from "@earendil-works/pi-tui";
import { quietDefinition, summarizeArgs } from "./quiet.ts";

export default function quietTools(pi: ExtensionAPI) {
	let quiet = true;

	const parts = {
		empty: () => new Container(),
		running: (toolName: string, args: unknown) => ({
			invalidate() {},
			render(width: number) {
				return [truncateToWidth(`\x1b[2m ⋯ ${toolName} ${summarizeArgs(args)}\x1b[22m`, width)];
			},
		}),
	};

	pi.registerToolRenderer((toolName: string, next: () => any) => {
		const d = next();
		return d ? quietDefinition(d, () => quiet, parts as any, toolName) : d;
	});

	const status = (ctx: any) => {
		if (ctx.hasUI) ctx.ui.setStatus("quiet-tools", quiet ? "tools hidden (alt+o)" : undefined);
	};

	const toggle = (ctx: any, on?: boolean) => {
		quiet = on ?? !quiet;
		if (ctx.hasUI) {
			try {
				const was = ctx.ui.getToolsExpanded();
				ctx.ui.setToolsExpanded(!was);
				ctx.ui.setToolsExpanded(was);
			} catch {
				// refresh is best effort
			}
			status(ctx);
			ctx.ui.notify(`Quiet tools: ${quiet ? "on" : "off"}`, "info");
		}
	};

	pi.registerShortcut("alt+o", {
		description: "Hide or show finished tool rows",
		handler: async (ctx: any) => toggle(ctx),
	});

	pi.registerCommand("quiet", {
		description: "Hide or show finished tool rows (/quiet, /quiet on, /quiet off)",
		handler: async (args: string, ctx: any) => {
			const a = (args ?? "").trim().toLowerCase();
			if (a === "") toggle(ctx);
			else if (a === "on") toggle(ctx, true);
			else if (a === "off") toggle(ctx, false);
			else if (ctx.hasUI) ctx.ui.notify("quiet: usage /quiet [on|off]", "warning");
		},
	});

	pi.on("session_start", async (_e: any, ctx: any) => {
		status(ctx);
	});
}
