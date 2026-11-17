import { spawn } from "node:child_process";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyDue, notifyCommand, idleReason } from "../notify.ts";
import { askMenu } from "../asks.ts";
import { assistantText, type Flow, type GateAbort } from "./context.ts";

/** A desktop notification that this session needs the user. Never throws; rate-limited. */
export function notifyUser(fl: Flow, ctx: ExtensionContext, why: string): void {
	try {
		const now = Date.now();
		if (!notifyDue({ enabled: fl.cfg.notify.enabled, hasUI: ctx.hasUI, now, last: fl.notify.lastNotifyAt })) return;
		fl.notify.lastNotifyAt = now;
		fl.notify.notifiedSinceStart = true;
		const c = notifyCommand(process.platform, "pi", `${path.basename(ctx.cwd)}: ${why}`);
		if (!c) return;
		const child = spawn(c.command, c.args, { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => {});
		child.unref();
	} catch {}
}
/** A menu that waits for a person; it notifies, then asks. */
export function askUser(fl: Flow, ctx: ExtensionContext, title: string, options: string[], opts: { localNotice?: () => void; skipLocal?: boolean } = {}): Promise<string | undefined> {
	return askMenu({ select: (t, o) => ctx.ui.select(t, o), notify: (t) => notifyUser(fl, ctx, t) }, { title, options, ...opts });
}

/** Aborts the running gate; the run settles on its own and decides what to do from `reason`. */
export function abortGate(fl: Flow, reason: GateAbort): void {
	if (!fl.gateRun || fl.gateRun.reason) return;
	fl.gateRun.reason = reason;
	fl.gateRun.controller.abort();
}
export function lastAssistantText(ctx: ExtensionContext): string {
	try {
		const entries = ctx.sessionManager.getBranch() as { type: string; message?: AgentMessage }[];
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "message" && e.message?.role === "assistant") return assistantText(e.message).trim();
		}
	} catch {}
	return "";
}
/** After a run settles, notify when the session stays idle; a new turn cancels it. */
export function scheduleIdleNotice(fl: Flow, ctx: ExtensionContext): void {
	if (fl.notify.idleTimer) clearTimeout(fl.notify.idleTimer);
	if (!fl.cfg.notify.enabled || !ctx.hasUI) return;
	fl.notify.idleTimer = setTimeout(() => {
		fl.notify.idleTimer = undefined;
		try {
			if (fl.gateRun || fl.notify.notifiedSinceStart || !ctx.isIdle()) return;
			if (fl.compacting || fl.compactPending || fl.pendingHandover) return scheduleIdleNotice(fl, ctx);
			notifyUser(fl, ctx, idleReason({ phase: fl.state.phase, waiting: fl.state.waiting?.reason }));
		} catch {}
	}, fl.cfg.notify.idleMs);
	fl.notify.idleTimer.unref?.();
}
