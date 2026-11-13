/** Pure helpers for orchestrate's model switch (and, later, the proposal judge gate). Imports only from `shared/` and this folder. */

import { type Mode, MODE_ENTRY } from "./mode.ts";

export type SavedModel = { model: string; thinking?: string };

export type RoleAction = "apply" | "restore" | "warn" | "none";

/** What a mode change does to the session model. Only off<->on, never in a sub; a running workflow phase turns the switch into a warning. */
export function roleSwitch(o: { from: Mode; to: Mode; isSub: boolean; workflowPhase?: string; hasRole: boolean; hasPrev: boolean }): RoleAction {
	if (o.isSub) return "none";
	const on = o.from === "off" && o.to !== "off" && o.hasRole;
	const off = o.from !== "off" && o.to === "off" && o.hasPrev;
	if (!on && !off) return "none";
	if (o.workflowPhase && o.workflowPhase !== "off") return "warn";
	return on ? "apply" : "restore";
}

/** The warning when the switch is skipped because a workflow phase is running. */
export function roleWarnText(direction: "on" | "off", phase: string, saved?: SavedModel): string {
	if (direction === "on") return `orchestrate: the workflow is in phase ${phase}; the model was not switched`;
	const back = saved ? ` Set it back with /model ${saved.model}${saved.thinking ? ` and thinking ${saved.thinking}` : ""}` : "";
	return `orchestrate: the workflow is in phase ${phase}; the model was not restored.${back}`;
}

/** The newest mode entry's `prevModel`, only when that entry's mode is not off. */
export function roleOnRestore(entries: unknown[]): SavedModel | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (!e || e.type !== "custom" || e.customType !== MODE_ENTRY) continue;
		const d = e.data as { mode?: unknown; prevModel?: { model?: unknown; thinking?: unknown } } | undefined;
		if (!d || d.mode === "off") return undefined;
		const p = d.prevModel;
		if (!p || typeof p.model !== "string" || !p.model) return undefined;
		return typeof p.thinking === "string" ? { model: p.model, thinking: p.thinking } : { model: p.model };
	}
	return undefined;
}
