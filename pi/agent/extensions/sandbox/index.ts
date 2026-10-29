/**
 * Sandbox extension: two small tools that keep big output out of the context.
 *
 *   run_code   run JavaScript in a child node process, get a capped result
 *   fetch_url     fetch a page, save it as markdown/json/text, get a short summary
 *   video_frames  probe a video and get still frames as images (ffmpeg)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchUrl } from "./fetch-url.ts";
import { runCode } from "./run-code.ts";
import { videoFrames } from "./video-frames.ts";

export default function sandbox(pi: ExtensionAPI) {
	pi.registerTool({
		name: "run_code",
		label: "Run code",
		description:
			"Run JavaScript (Node, CommonJS) to process files, logs or command output, and print only the answer. The code runs inside an async function: await works and require is available. Only what you print comes back, capped at 8,000 characters (first 6,000 and last 2,000 are kept), so filter, count and summarize in the code instead of printing raw data. Use it to read many files, parse JSON, grep across a tree or compare outputs in one call. Timeout 60 s by default (max 600); the whole process tree is killed on timeout. JavaScript only: no shell or Python.",
		promptSnippet: "run_code: run JavaScript over files/output and print only the answer (capped at 8,000 characters)",
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript to run; print the result with console.log" }),
			cwd: Type.Optional(Type.String({ description: "Working folder; relative paths resolve against the session folder" })),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 60, max 600)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const r = await runCode(params, { cwd: ctx.cwd, signal });
			return { content: [{ type: "text", text: r.text || "(no output)" }], details: { exitCode: r.exitCode, timedOut: r.timedOut } };
		},
	});

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description:
			"Fetch a web page with GET (http and https only) and save it to a file: HTML becomes markdown, JSON is pretty-printed, other text is kept as is. Returns the final URL, status, size, title, the headings and the first 2,000 characters, plus the path of the saved file. Then use grep or read on that file for the parts you need, instead of reading the whole page. Results are cached for 1 hour; pass force to fetch again. Limits: 30 s timeout, 5 MB body.",
		promptSnippet: "fetch_url: fetch a web page into a file (markdown/json/text) and get a summary; then grep or read the file",
		parameters: Type.Object({
			url: Type.String({ description: "http or https URL" }),
			force: Type.Optional(Type.Boolean({ description: "Skip the 1-hour cache" })),
		}),
		async execute(_id, params, signal) {
			const text = await fetchUrl(params, { signal });
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "video_frames",
		label: "Video frames",
		description:
			"Look at a video file (mp4, mov, webm, mkv, gif, ...): returns its duration, size, frame rate and audio, plus still frames as images. By default 6 frames spread evenly over the video (or over start..end seconds); pass count (max 16) for more, or times (seconds) for exact moments. width (default 768, max 1920) sets the frame width. Frames are JPEGs saved in the temp folder (paths are listed) and reused on the next call. Start with few frames, then zoom into the part that matters with start/end or times. For a still image use read.",
		promptSnippet: "video_frames: get a video's info and still frames as images (count, times, start/end, width)",
		parameters: Type.Object({
			path: Type.String({ description: "Video file; relative paths resolve against the session folder" }),
			count: Type.Optional(Type.Number({ description: "Frames spread evenly over start..end (default 6, max 16)" })),
			times: Type.Optional(Type.Array(Type.Number(), { description: "Exact frame times in seconds (max 16); overrides count" })),
			start: Type.Optional(Type.Number({ description: "Start of the range in seconds (default 0)" })),
			end: Type.Optional(Type.Number({ description: "End of the range in seconds (default the end of the video)" })),
			width: Type.Optional(Type.Number({ description: "Frame width in pixels (default 768, max 1920)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const r = await videoFrames(params, { cwd: ctx.cwd, signal });
			return {
				content: [{ type: "text", text: r.text }, ...r.frames.map((f) => ({ type: "image" as const, data: f.data, mimeType: f.mimeType }))],
				details: { frames: r.frames.map((f) => ({ time: f.time, file: f.file })) },
			};
		},
	});
}
