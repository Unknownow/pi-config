/** Contract W1: the payload of `worktree:create`, checked without any I/O. */
import { checkName } from "./layout.ts";

/** The name to create, or `{ error }` for a wrong version, a non-string name or a bad branch name. */
export function parseCreate(data: unknown): { name: string } | { error: string } {
	if (typeof data !== "object" || data === null) return { error: "worktree:create needs an object payload" };
	const o = data as { v?: unknown; name?: unknown };
	if (o.v !== 1) return { error: "worktree:create: unsupported version (v must be 1)" };
	if (typeof o.name !== "string") return { error: "worktree:create: name must be a string" };
	const bad = checkName(o.name);
	return bad ? { error: bad } : { name: o.name };
}
