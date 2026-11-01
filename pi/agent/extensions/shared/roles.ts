/**
 * Role specs (`provider/model-id[:thinking]`) and the model picker that `/flow model`
 * and `/agents model` share. Pure except `pickRoleSpec`, which only drives the UI it is given.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

export interface RoleSpec {
	/** `provider/model-id`, as accepted by `pi --model`. */
	model: string;
	thinking?: Thinking;
}

/** `provider/id[:thinking]` -> RoleSpec, or what is wrong with the input. */
export function parseRoleSpec(input: string): RoleSpec | string {
	const m = input.trim().match(/^([^/\s]+\/[^:\s]+)(?::(\w+))?$/);
	if (!m) return `expected provider/model-id[:thinking], got "${input}"`;
	const thinking = m[2] as Thinking | undefined;
	if (thinking && !THINKING_LEVELS.includes(thinking)) return `thinking must be one of ${THINKING_LEVELS.join(", ")}`;
	return thinking ? { model: m[1], thinking } : { model: m[1] };
}

export function describeRole(spec: RoleSpec): string {
	return `${spec.model}${spec.thinking ? `:${spec.thinking}` : ""}`;
}

type Model = { provider: string; id: string; name?: string };

/** Models sorted by provider then id, as `provider/id` values with a readable label. */
export function modelChoices(models: Model[], current?: string): { value: string; label: string }[] {
	return [...models]
		.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
		.map((m) => {
			const value = `${m.provider}/${m.id}`;
			const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
			return { value, label: `${value}${name}${value === current ? " (current)" : ""}` };
		});
}

/** Tab completions for `<sub> <role> <provider/id>`: the role, then the models with auth. */
export function roleCompletions(
	sub: string,
	parts: string[],
	roles: readonly string[],
	specOf: (role: string) => RoleSpec,
	models: () => Model[],
): { value: string; label: string }[] | null {
	if (parts.length === 2) return roles.filter((r) => r.startsWith(parts[1])).map((r) => ({ value: `${sub} ${r} `, label: `${r} (${describeRole(specOf(r))})` }));
	if (parts.length !== 3 || !roles.includes(parts[1])) return null;
	try {
		const items = modelChoices(models(), specOf(parts[1]).model)
			.filter((c) => c.value.toLowerCase().startsWith(parts[2].toLowerCase()))
			.slice(0, 50)
			.map((c) => ({ value: `${sub} ${parts[1]} ${c.value}`, label: c.label }));
		return items.length > 0 ? items : null;
	} catch {
		return null;
	}
}

interface PickerUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/**
 * Asks for a model (from the ones with auth, or typed) and a thinking level.
 * Returns the spec, an error message, or undefined when the user cancelled.
 */
export async function pickRoleSpec(ui: PickerUI, role: string, current: RoleSpec | undefined, models: () => Model[]): Promise<RoleSpec | string | undefined> {
	let choices: ReturnType<typeof modelChoices> = [];
	try {
		choices = modelChoices(models(), current?.model);
	} catch {}
	const typeOwn = "Type a model ID…";
	const pick = choices.length > 0 ? await ui.select(`Model for ${role}`, [...choices.map((c) => c.label), typeOwn]) : typeOwn;
	if (!pick) return undefined;
	if (pick === typeOwn) {
		const input = await ui.input(`Model for ${role}`, current ? describeRole(current) : undefined);
		return input ? parseRoleSpec(input) : undefined;
	}
	const model = choices.find((c) => c.label === pick)!.value;
	const keep = `keep (${current?.thinking ?? "default"})`;
	const level = await ui.select(`Thinking for ${model}`, [keep, ...THINKING_LEVELS]);
	if (!level) return undefined;
	if (level === keep) return current?.thinking ? { model, thinking: current.thinking } : { model };
	return { model, thinking: level as Thinking };
}
