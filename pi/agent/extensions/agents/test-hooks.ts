/**
 * Test helper: stubs the pi packages, which are not installed next to the tests, so modules that import
 * them at runtime load. Import it before the module under test (with a dynamic import after it).
 * `getAgentDir` points at a fresh temp folder, so agents.json is absent and the defaults apply.
 */
import * as fs from "node:fs";
import { registerHooks } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

export const AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-"));

const anyFn = "new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : (...a) => ({ args: a })), apply: () => ({}), construct: () => ({}) })";
const STUBS: Record<string, string> = {
	"@earendil-works/pi-coding-agent": `export const getAgentDir = () => ${JSON.stringify(AGENT_DIR)}; export const convertToLlm = (m) => m; export const serializeConversation = () => "";`,
	"@earendil-works/pi-ai": `export const StringEnum = (v, o) => ({ enum: v, ...o });`,
	"@earendil-works/pi-tui": `export class Text { constructor(text) { this.text = text; } }`,
	typebox: `export const Type = ${anyFn};`,
};

registerHooks({
	resolve(specifier, context, next) {
		const stub = STUBS[specifier];
		if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
		return next(specifier, context);
	},
});
