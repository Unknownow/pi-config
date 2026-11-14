/** Contract W1: the payload of `worktree:create`, checked without any I/O. */
import { checkName } from "./layout.ts";

/** The name to create (and, when given, the only added folders to put in the set), or `{ error }` for a wrong version, a non-string name or a bad branch name. */
export function parseCreate(data: unknown): { name: string; folders?: string[]; bases?: Record<string, string> } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "worktree:create needs an object payload" };
	const o = data as { v?: unknown; name?: unknown; folders?: unknown; bases?: unknown };
	if (o.v !== 1) return { error: "worktree:create: unsupported version (v must be 1)" };
	if (typeof o.name !== "string") return { error: "worktree:create: name must be a string" };
	const bad = checkName(o.name);
	if (bad) return { error: bad };
	let bases: Record<string, string> | undefined;
	if (o.bases !== undefined) {
		if (typeof o.bases !== "object" || o.bases === null || Array.isArray(o.bases) || Object.values(o.bases).some((b) => typeof b !== "string" || !b.trim())) return { error: "worktree:create: bases must be an object of non-empty strings (repo top level -> remote ref)" };
		bases = Object.fromEntries(Object.entries(o.bases as Record<string, string>).map(([k, v]) => [k, v.trim()]));
	}
	if (o.folders === undefined) return { name: o.name, ...(bases ? { bases } : {}) };
	if (!Array.isArray(o.folders) || o.folders.some((f) => typeof f !== "string")) return { error: "worktree:create: folders must be an array of strings" };
	return { name: o.name, folders: o.folders as string[], ...(bases ? { bases } : {}) };
}
