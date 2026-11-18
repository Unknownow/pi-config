/** Client of the pi-terminal-bridge VS Code extension: asks it, over a local pipe, to open a terminal. */

import * as net from "node:net";
import type { VscodeRequest } from "./layout.ts";

/** Resolves null when VS Code opened the terminal, otherwise a message. Never throws. */
export function sendToVscode(pipe: string, req: VscodeRequest, timeoutMs = 3000): Promise<string | null> {
	return new Promise((resolve) => {
		let done = false;
		let buf = "";
		const sock = net.createConnection(pipe);
		const finish = (r: string | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			sock.destroy();
			resolve(r);
		};
		const timer = setTimeout(() => finish(`VS Code did not answer in ${timeoutMs} ms`), timeoutMs);
		sock.setEncoding("utf8");
		sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
		sock.on("error", (e) => finish(`cannot reach VS Code (${e.message})`));
		sock.on("close", () => finish("bad reply from VS Code"));
		sock.on("data", (d: string) => {
			buf += d;
			const i = buf.indexOf("\n");
			if (i < 0) return;
			try {
				const r = JSON.parse(buf.slice(0, i));
				if (r && r.ok === true) finish(null);
				else if (r && r.ok === false && typeof r.error === "string") finish(r.error);
				else finish("bad reply from VS Code");
			} catch {
				finish("bad reply from VS Code");
			}
		});
	});
}
