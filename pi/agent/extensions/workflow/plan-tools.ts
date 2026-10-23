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
