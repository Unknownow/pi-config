// node --experimental-strip-types --test vscode-bridge.test.ts
import assert from "node:assert/strict";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { VscodeRequest } from "./layout.ts";
import { sendToVscode } from "./vscode-bridge.ts";

const req: VscodeRequest = { name: "pi x", cwd: "D:/c", shellPath: "cmd.exe", shellArgs: ["/d", "/c", "pi.cmd"] };
let n = 0;
const pipeName = () => {
	const id = `pi-test-${process.pid}-${n++}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), `${id}.sock`);
};

async function withServer(onLine: ((line: string, sock: net.Socket) => void) | null, run: (pipe: string) => Promise<void>) {
	const pipe = pipeName();
	const sockets: net.Socket[] = [];
	const server = net.createServer((s) => {
		sockets.push(s);
		s.setEncoding("utf8");
		let buf = "";
		s.on("error", () => {});
		s.on("data", (d: string) => {
			buf += d;
			const i = buf.indexOf("\n");
			if (i >= 0 && onLine) onLine(buf.slice(0, i), s);
		});
	});
	await new Promise<void>((r) => server.listen(pipe, r));
	try {
		await run(pipe);
	} finally {
		sockets.forEach((s) => s.destroy());
		await new Promise<void>((r) => server.close(() => r()));
	}
}

test("ok reply", async () => {
	let got: unknown;
	await withServer(
		(line, s) => {
			got = JSON.parse(line);
			s.write('{"ok":true}\n');
		},
		async (pipe) => {
			assert.equal(await sendToVscode(pipe, req), null);
			assert.deepEqual(got, req);
		},
	);
});

test("error reply", async () => {
	await withServer((_l, s) => s.write('{"ok":false,"error":"boom"}\n'), async (pipe) => {
		assert.equal(await sendToVscode(pipe, req), "boom");
	});
});

test("bad reply", async () => {
	await withServer((_l, s) => s.write("nope\n"), async (pipe) => {
		assert.equal(await sendToVscode(pipe, req), "bad reply from VS Code");
	});
});

test("nothing listening", async () => {
	assert.match((await sendToVscode(pipeName(), req)) ?? "", /cannot reach VS Code/);
});

test("timeout", async () => {
	await withServer(null, async (pipe) => {
		assert.equal(await sendToVscode(pipe, req, 200), "VS Code did not answer in 200 ms");
	});
});
