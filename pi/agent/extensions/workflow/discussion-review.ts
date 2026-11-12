/** Pure helpers for `/flow judge` in the discuss phase: the judge reviews the discussion's conclusion. */

import { JUDGE_DISCUSSION } from "./prompts.ts";

const AGREED = /^[ \t]*\**Agreed so far:?\**:?/im;

/** The newest `Agreed so far:` list, from its line to the end of that text; undefined when no text has one. */
export function lastAgreedList(assistantTexts: string[]): string | undefined {
	for (let i = assistantTexts.length - 1; i >= 0; i--) {
		const m = AGREED.exec(assistantTexts[i]);
		if (m) return assistantTexts[i].slice(m.index).trim();
	}
	return undefined;
}

export function discussionVerdict(text: string): "PASS" | "FAIL" {
	return /VERDICT:\s*PASS/i.test(text) && !/VERDICT:\s*FAIL/i.test(text) ? "PASS" : "FAIL";
}

export function discussionReviewPrompts(conclusion: string | undefined, transcript: string, folders: string[]): string[] {
	return [
		JUDGE_DISCUSSION,
		`## Conclusion under review\n\n${conclusion ?? "No `Agreed so far:` list yet: review the latest conclusion in the transcript."}`,
		...(folders.length ? [`## Other folders of this session\n\n${folders.map((f) => `- ${f}`).join("\n")}`] : []),
		`## Discussion transcript\n\n${transcript}`,
	];
}
