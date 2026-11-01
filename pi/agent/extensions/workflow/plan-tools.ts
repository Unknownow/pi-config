/**
 * Tools registered after plan or test phase started (an MCP server that connects late) are not in
 * the snapshot taken when the phase began, so the filter must run again. The snapshot is
 * extended in place, so restoring at the end of the phase brings the new tools back too.
 */
export function refilterPlanTools(
	pi: { getActiveTools(): string[]; setActiveTools(tools: string[]): void },
	before: string[],
	refused: (name: string) => boolean,
): boolean {
	const active = pi.getActiveTools();
	for (const name of active) if (!before.includes(name)) before.push(name);
	const wanted = before.filter((t) => !refused(t));
	const same = wanted.length === active.length && wanted.every((t) => active.includes(t));
	if (same) return false;
	pi.setActiveTools(wanted);
	return true;
}

/** Tools of the agents extension: a phase never removes them (test_run is refused by the tool_call hook while planning). */
export const KEPT_TOOLS = ["explore", "advisor", "test_run"];

/** Workflow tools that only mean something inside a flow; normal mode does not declare them to the model. */
export const FLOW_ONLY_TOOLS = ["plan_check", "deliver", "wait_for_user", "publish_packages"];

export type ToolPhase = "off" | "discuss" | "plan" | "execute";

/** Whether a phase takes a tool out of the active set. `planRefused` is the read-only check of discuss and plan. */
export function hiddenInPhase(phase: ToolPhase, name: string, planRefused: (name: string) => boolean): boolean {
	if (KEPT_TOOLS.includes(name)) return false;
	if (phase === "off") return FLOW_ONLY_TOOLS.includes(name);
	if (phase === "execute") return false;
	return planRefused(name);
}

/** Adds or removes the flow-only tools when the phase moves between normal mode and a flow. */
export function syncFlowOnlyTools(
	pi: { getActiveTools(): string[]; setActiveTools(tools: string[]): void; getAllTools(): { name: string }[] },
	phase: ToolPhase,
): boolean {
	const active = pi.getActiveTools();
	if (phase === "off") {
		const wanted = active.filter((t) => !FLOW_ONLY_TOOLS.includes(t));
		if (wanted.length === active.length) return false;
		pi.setActiveTools(wanted);
		return true;
	}
	const registered = new Set(pi.getAllTools().map((t) => t.name));
	const add = FLOW_ONLY_TOOLS.filter((t) => registered.has(t) && !active.includes(t));
	if (!add.length) return false;
	pi.setActiveTools([...active, ...add]);
	return true;
}
