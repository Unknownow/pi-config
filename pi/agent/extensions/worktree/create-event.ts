/** Contract W1: the payload of `worktree:create`, checked without any I/O. */
import { checkName } from "./layout.ts";

/** The name to create (and, when given, the only added folders to put in the set), or `{ error }` for a wrong version, a non-string name or a bad branch name. */
export function parseCreate(data: unknown): { name: string; folders?: string[]; bases?: Record<string, string>; launch?: "none" } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "worktree:create needs an object payload" };
	const o = data as { v?: unknown; name?: unknown; folders?: unknown; bases?: unknown; launch?: unknown };
	if (o.v !== 1) return { error: "worktree:create: unsupported version (v must be 1)" };
	if (typeof o.name !== "string") return { error: "worktree:create: name must be a string" };
	const bad = checkName(o.name);
	if (bad) return { error: bad };
	if (o.launch !== undefined && o.launch !== "none") return { error: "worktree:create: launch must be \"none\" when given" };
	const launch = o.launch === "none" ? ({ launch: "none" } as const) : {};
	let bases: Record<string, string> | undefined;
	if (o.bases !== undefined) {
		if (typeof o.bases !== "object" || o.bases === null || Array.isArray(o.bases) || Object.values(o.bases).some((b) => typeof b !== "string" || !b.trim())) return { error: "worktree:create: bases must be an object of non-empty strings (repo top level -> remote ref)" };
		bases = Object.fromEntries(Object.entries(o.bases as Record<string, string>).map(([k, v]) => [k, v.trim()]));
	}
	if (o.folders === undefined) return { name: o.name, ...(bases ? { bases } : {}), ...launch };
	if (!Array.isArray(o.folders) || o.folders.some((f) => typeof f !== "string")) return { error: "worktree:create: folders must be an array of strings" };
	return { name: o.name, folders: o.folders as string[], ...(bases ? { bases } : {}), ...launch };
}

/** Contract W2: the payload of `worktree:remove`. */
export function parseRemove(data: unknown): { name: string; force: boolean } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "worktree:remove needs an object payload" };
	const o = data as { v?: unknown; name?: unknown; force?: unknown };
	if (o.v !== 1) return { error: "worktree:remove: unsupported version (v must be 1)" };
	if (typeof o.name !== "string") return { error: "worktree:remove: name must be a string" };
	const bad = checkName(o.name);
	if (bad) return { error: bad };
	if (o.force !== undefined && typeof o.force !== "boolean") return { error: "worktree:remove: force must be a boolean" };
	return { name: o.name, force: o.force === true };
}

/** Contract W3: the payload of `worktree:add-repo`. */
export function parseAddRepo(data: unknown): { name: string; folder: string; base?: string } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "worktree:add-repo needs an object payload" };
	const o = data as { v?: unknown; name?: unknown; folder?: unknown; base?: unknown };
	if (o.v !== 1) return { error: "worktree:add-repo: unsupported version (v must be 1)" };
	if (typeof o.name !== "string") return { error: "worktree:add-repo: name must be a string" };
	const bad = checkName(o.name);
	if (bad) return { error: bad };
	if (typeof o.folder !== "string" || !o.folder.trim()) return { error: "worktree:add-repo: folder must be a non-empty string" };
	if (o.base !== undefined && (typeof o.base !== "string" || !o.base.trim())) return { error: "worktree:add-repo: base must be a non-empty string" };
	return { name: o.name, folder: o.folder, ...(o.base !== undefined ? { base: (o.base as string).trim() } : {}) };
}
