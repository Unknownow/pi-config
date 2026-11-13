/** Pure helpers for `/flow judge` in the discuss phase: the judge reviews the discussion's conclusion. */

import { JUDGE_DISCUSSION } from "./prompts.ts";

export { lastAgreedList } from "../shared/findings.ts";
export { judgeVerdict as discussionVerdict } from "../shared/findings.ts";

export function discussionReviewPrompts(conclusion: string | undefined, transcript: string, folders: string[]): string[] {
	return [
		JUDGE_DISCUSSION,
		`## Conclusion under review\n\n${conclusion ?? "No `Agreed so far:` list yet: review the latest conclusion in the transcript."}`,
		...(folders.length ? [`## Other folders of this session\n\n${folders.map((f) => `- ${f}`).join("\n")}`] : []),
		`## Discussion transcript\n\n${transcript}`,
	];
}
