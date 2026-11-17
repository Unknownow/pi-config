/** Wait points: the wait state, its check and the timer that polls it. */
import { getShellConfig, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CheckVerdict, checkVerdict, replaceWait, resumePrefix, pollDecision } from "../waits.ts";
import { resumeContent } from "../asks.ts";
import { type Flow, type FlowState } from "./context.ts";
import { notifyUser } from "./notify.ts";
import { persist, updateStatus } from "./phase.ts";
import { planMilestone } from "./plan-files.ts";

// ----------------------------------------------------------------------
// Wait points
// ----------------------------------------------------------------------

export function stopWaitTimer(fl: Flow): void {
	if (fl.wait.waitTimer) clearInterval(fl.wait.waitTimer);
	fl.wait.waitTimer = undefined;
	if (fl.wait.waitFirstTimer) clearTimeout(fl.wait.waitFirstTimer);
	fl.wait.waitFirstTimer = undefined;
}

/** Polls the wait's check every `wait.pollMs` while the session is idle. A wait without a check, or whose check already passed, is not polled. */
export function startWaitTimer(fl: Flow, sinceMs?: number): void {
	stopWaitTimer(fl);
	const w = fl.state.waiting;
	if (!w?.check || w.checkPassed) return;
	fl.wait.waitTimerStart = sinceMs ?? Date.now();
	fl.wait.waitTimer = setInterval(() => void waitTick(fl), fl.cfg.wait.pollMs);
	(fl.wait.waitTimer as { unref?: () => void }).unref?.();
	fl.wait.waitFirstTimer = setTimeout(() => void waitTick(fl), 5_000);
	(fl.wait.waitFirstTimer as { unref?: () => void }).unref?.();
}

export function resolveWaitShell(fl: Flow): { shell: string; args: string[] } | { error: string } {
	if (fl.wait.waitShell) return fl.wait.waitShell;
	try {
		const c = getShellConfig();
		fl.wait.waitShell = c.commandTransport === "stdin" ? { error: "no usable bash: only a WSL bash that needs stdin was found" } : { shell: c.shell, args: c.args };
	} catch (e) {
		fl.wait.waitShell = { error: `no usable bash: ${e instanceof Error ? e.message : String(e)}` };
	}
	return fl.wait.waitShell;
}

/** Runs a wait's check in pi's bash. Exit 0 passes; a failure or timeout is "not yet"; a check that cannot run is broken. */
export async function runWaitCheck(fl: Flow, check: string): Promise<CheckVerdict> {
	const sh = resolveWaitShell(fl);
	if ("error" in sh) return checkVerdict(sh, fl.cfg.wait.checkTimeoutMs);
	try {
		const r = await fl.pi.exec(sh.shell, [...sh.args, check], { cwd: fl.lastCtx?.cwd, timeout: fl.cfg.wait.checkTimeoutMs });
		return checkVerdict({ code: r.code, stderr: r.stderr ?? "", killed: !!r.killed }, fl.cfg.wait.checkTimeoutMs);
	} catch (e) {
		return checkVerdict({ error: e instanceof Error ? e.message : String(e) }, fl.cfg.wait.checkTimeoutMs);
	}
}

/** The wait is over: clears it and records the new state. */
export function clearWait(fl: Flow, ctx: ExtensionContext): void {
	fl.state.waiting = undefined;
	stopWaitTimer(fl);
	persist(fl);
	updateStatus(fl, ctx);
	planMilestone(fl, ctx);
}

/** Sets the wait; a wait set over an open one stops the old one's poll timer. */
export function setWaiting(fl: Flow, next: FlowState["waiting"]): void {
	replaceWait(fl.state.waiting, { stopTimer: () => stopWaitTimer(fl) });
	fl.state.waiting = next;
}

/** The wait is over because a person typed: clears it and returns the message that resumes the executor. */
export function finishWait(fl: Flow, ctx: ExtensionContext, w: NonNullable<FlowState["waiting"]>, how: "passed" | "forced" | "plain", text: string | undefined): string {
	clearWait(fl, ctx);
	return resumeContent(resumePrefix(w.reason, how), w.held, text);
}

export async function waitTick(fl: Flow): Promise<void> {
	const w = fl.state.waiting;
	const ctx = fl.lastCtx;
	if (!w || !ctx || fl.wait.waitChecking || fl.state.phase !== "execute") return;
	const elapsedMs = Date.now() - fl.wait.waitTimerStart;
	const limit = fl.cfg.wait.maxMs;
	const idle = ctx.isIdle() && (!ctx.hasUI || ctx.ui.getEditorText().trim() === "");
	const d = pollDecision({ waiting: true, hasCheck: !!w.check && !w.checkPassed, idle, elapsedMs, maxMs: limit });
	if (d === "hold") return;
	if (d === "stop") {
		stopWaitTimer(fl);
		if (w.check && elapsedMs >= limit) {
			ctx.ui.notify(`workflow: stopped polling "${w.check}" after ${Math.round(elapsedMs / 60_000)} min; your next message checks again`, "warning");
			notifyUser(fl, ctx, `stopped waiting for "${w.check}" after ${Math.round(elapsedMs / 60_000)} min`);
		}
		return;
	}
	fl.wait.waitChecking = true;
	try {
		const verdict = await runWaitCheck(fl, w.check as string);
		if (fl.state.waiting !== w) return;
		if (verdict.status === "broken") {
			stopWaitTimer(fl);
			ctx.ui.notify(`workflow: wait check can't run (${verdict.detail}): ${w.check}; fix it or send a message to continue`, "warning");
			notifyUser(fl, ctx, `wait check can't run: ${verdict.detail}`);
			return;
		}
		if (verdict.status !== "pass") return;
		stopWaitTimer(fl);
		if (fl.cfg.wait.autoResume) {
			clearWait(fl, ctx);
			const body = w.held ?? "Continue with the open steps of the plan.";
			fl.pi.sendMessage({ customType: "workflow-wait", content: `${resumePrefix(w.reason, "passed")} ${body}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		} else {
			w.checkPassed = true;
			persist(fl);
			ctx.ui.notify(`workflow: "${w.check}" passed; send any message to continue`, "info");
			notifyUser(fl, ctx, `"${w.check}" passed; send any message to continue`);
		}
	} finally {
		fl.wait.waitChecking = false;
	}
}
