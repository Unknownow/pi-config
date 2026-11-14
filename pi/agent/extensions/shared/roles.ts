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

/** Tab completions for `<sub> <role> <provider/id[:thinking]>`: the role, the models with auth, then the thinking level. */
export function roleCompletions(
	sub: string,
	parts: string[],
	roles: readonly string[],
	specOf: (role: string) => RoleSpec,
	models: () => Model[],
): { value: string; label: string; description: string }[] | null {
	try {
		if (parts.length === 2) {
			const found = roles.filter((r) => r.startsWith(parts[1])).map((r) => ({ value: `${sub} ${r} `, label: r, description: describeRole(specOf(r)) }));
			return found.length > 0 ? found : null;
		}
		if (parts.length !== 3 || !roles.includes(parts[1])) return null;
		const role = parts[1];
		const typed = parts[2];
		const current = specOf(role);
		const all = models();
		const colon = typed.indexOf(":");
		const items: { value: string; label: string; description: string }[] = [];
		if (colon < 0) {
			const byValue = new Map(all.map((m) => [`${m.provider}/${m.id}`, m]));
			for (const c of modelChoices(all, current.model).filter((c) => c.value.toLowerCase().startsWith(typed.toLowerCase())).slice(0, 50)) {
				const m = byValue.get(c.value)!;
				items.push({ value: `${sub} ${role} ${c.value}`, label: c.label, description: `default thinking · ${m.provider}/${m.name ?? m.id}` });
			}
		}
		const base = colon < 0 ? typed : typed.slice(0, colon);
		const levelPrefix = colon < 0 ? "" : typed.slice(colon + 1).toLowerCase();
		if (colon >= 0 || all.some((m) => `${m.provider}/${m.id}` === base)) {
			for (const level of THINKING_LEVELS) {
				if (!level.startsWith(levelPrefix) || typeof parseRoleSpec(`${base}:${level}`) === "string") continue;
				const now = current.model === base && current.thinking === level;
				items.push({ value: `${sub} ${role} ${base}:${level}`, label: `${base}:${level}`, description: `thinking ${level}${now ? " (current)" : ""}` });
			}
		}
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
