// A fake pi extension API and event bus, enough to drive relay's lead.ts, and a simulated workflow side of K16.
import { emitClaims } from "../../shared/claims.ts";
import { ownerOf } from "../events.ts";
import type { LeadDeps } from "../lead.ts";
import { createLead } from "../lead.ts";

export function makeBus() {
	const handlers = new Map<string, ((d: any) => void)[]>();
	return {
		on(name: string, fn: (d: any) => void) {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
			return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== fn));
		},
		emit(name: string, data: unknown) {
			for (const h of [...(handlers.get(name) ?? [])]) h(data);
		},
	};
}
export type Bus = ReturnType<typeof makeBus>;

/** Builds a plain-object stand-in for typebox's Type. */
export const FakeType: any = new Proxy({}, { get: (_t, kind) => (x?: unknown) => ({ kind, x }) });

export function fakePi(bus: Bus = makeBus()) {
	const hooks = new Map<string, (e: any, c: any) => any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const sent: { message: any; opts: any }[] = [];
	const userMessages: string[] = [];
	const pi: any = {
		events: bus,
		on: (n: string, fn: any) => void hooks.set(n, fn),
		registerTool: (t: any) => void tools.set(t.name, t),
		registerCommand: (n: string, c: any) => void commands.set(n, c),
		sendMessage: (message: any, opts: any) => void sent.push({ message, opts }),
		sendUserMessage: (t: string) => void userMessages.push(t),
		getMcpServers: () => [],
	};
	return { pi, hooks, tools, commands, sent, userMessages, bus };
}

export function fakeCtx(cwd: string, folders: string[] = []) {
	const notes: string[] = [];
	return {
		cwd,
		notes,
		hasUI: true,
		ui: { notify: (m: string) => void notes.push(m) },
		sessionManager: { getBranch: () => (folders.length ? [{ type: "custom", customType: "session-folders", data: { v: 1, folders } }] : []), getSessionFile: () => "session-1" },
		isProjectTrusted: () => true,
	};
}

export function relayOn(bus: Bus, cwd: string, over: Partial<LeadDeps> = {}) {
	const api = fakePi(bus);
	const lead = createLead(api.pi, { Type: FakeType, getAgentDir: () => cwd, cwd, relayDir: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), env: {}, ...over });
	return { ...api, lead };
}

/** The workflow side of K16: claims while its phase is not "off"; `startPhase` asks relay first, as workflow's setPhase does. */
export function workflowSide(bus: Bus, phase: { value: string }) {
	bus.on("flow:active", (d) => {
		if (d?.from === "workflow") return;
		if (phase.value !== "off") d.claim({ owner: "workflow" });
	});
	const relayOwns = async () => ownerOf(await emitClaims((d) => bus.emit("flow:active", d), { v: 1, from: "workflow" }, 2000).answer) === "relay";
	return {
		relayOwns,
		async startPhase(to: string) {
			if (phase.value === "off" && (await relayOwns())) return false;
			phase.value = to;
			return true;
		},
	};
}
