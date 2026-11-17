/**
 * Test helper: stubs the pi packages, which are not installed next to the tests, so modules that import
 * agents/api.ts (or the pi packages) at runtime load. Import it first with `await import("./test-hooks.ts")`
 * and load the module under test with a dynamic import after it: static imports resolve before any hook runs.
 * `getAgentDir` points at a fresh temp folder, so agents.json and workflow.json are absent and the defaults apply.
 */
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

export const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-workflow-test-"));

const anyFn = "new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : (...a) => ({ args: a })), apply: () => ({}), construct: () => ({}) })";
const STUBS: Record<string, string> = {
	"@earendil-works/pi-coding-agent": `export const getAgentDir = () => ${JSON.stringify(AGENT_DIR)}; export const convertToLlm = (m) => m; export const serializeConversation = () => ""; export const getShellConfig = () => ({ shell: "sh", args: ["-c"] }); export const loadProjectContextFiles = () => [];`,
	"@earendil-works/pi-ai": `export const StringEnum = (v, o) => ({ enum: v, ...o });`,
	"@earendil-works/pi-tui": `export class Text { constructor(text) { this.text = text; } }; export const truncateToWidth = (s) => s;`,
	typebox: `export const Type = ${anyFn};`,
};

registerHooks({
	resolve(specifier, context, next) {
		const stub = STUBS[specifier];
		if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
		return next(specifier, context);
	},
});
