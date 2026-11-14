/**
 * markdown-view extension: /view opens an assistant reply or a markdown file
 * in the browser, with mermaid diagrams rendered. Display only; no tools, no session entries.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { viewCompletions, viewDescription } from "./commands.ts";
import { buildHtml, parseViewArgs, recentReplies, replyTexts, viewFileName } from "./view.ts";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cleanOld(dir: string): void {
	try {
		const now = Date.now();
		for (const f of readdirSync(dir)) {
			if (!/^view-.*\.html$/.test(f)) continue;
			try {
				const p = join(dir, f);
				if (now - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p);
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function openFile(file: string, onError: (e: Error) => void): void {
	const [cmd, args] =
		process.platform === "win32"
			? ["rundll32", ["url.dll,FileProtocolHandler", file]]
			: process.platform === "darwin"
				? ["open", [file]]
				: ["xdg-open", [file]];
	const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.on("error", onError);
	child.unref();
}

export default function markdownView(pi: ExtensionAPI) {
	/** Last seen session context, for the completions. */
	let lastCtx: ExtensionContext | undefined;
	pi.on("session_start", (_e, ctx) => {
		lastCtx = ctx;
	});
	pi.registerCommand("view", {
		description: viewDescription(),
		getArgumentCompletions: (prefix) => viewCompletions(prefix, () => (lastCtx ? recentReplies(lastCtx.sessionManager.getBranch(), 10) : null)),
		handler: async (args, ctx) => {
			lastCtx = ctx;
			try {
				const parsed = parseViewArgs(args);
				if ("error" in parsed) {
					ctx.ui.notify(`view: ${parsed.error}`, "warning");
					return;
				}
				let markdown: string;
				let title: string;
				if (parsed.kind === "reply") {
					const texts = replyTexts(ctx.sessionManager.getBranch());
					if (!texts.length) {
						ctx.ui.notify("view: no assistant reply yet", "warning");
						return;
					}
					if (parsed.index > texts.length) {
						ctx.ui.notify(`view: only ${texts.length} replies`, "warning");
						return;
					}
					markdown = texts[texts.length - parsed.index];
					title = `Reply ${parsed.index} of ${texts.length}`;
				} else {
					const p = resolve(ctx.cwd, parsed.path);
					try {
						markdown = readFileSync(p, "utf8");
					} catch (e) {
						ctx.ui.notify(`view: cannot read ${p}: ${(e as Error).message}`, "warning");
						return;
					}
					title = basename(p);
				}
				const dir = join(tmpdir(), "pi-view");
				mkdirSync(dir, { recursive: true });
				const file = join(dir, viewFileName(new Date()));
				writeFileSync(file, buildHtml(markdown, title), "utf8");
				cleanOld(dir);
				openFile(file, (e) => ctx.ui.notify(`view: cannot open the browser (${e.message}); open ${file} yourself`, "warning"));
				ctx.ui.notify(`view: opened ${title} → ${file}`, "info");
			} catch (e) {
				ctx.ui.notify(`view: ${(e as Error).message}`, "error");
			}
		},
	});
}
