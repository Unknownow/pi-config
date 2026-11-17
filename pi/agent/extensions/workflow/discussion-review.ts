/** Pure helpers for the discussion review (the discussion gate and `/flow critic` in discuss): agents' critic reviews the discussion's conclusion. */

import type { CriticRequest, Finding } from "../agents/api.ts";
import { DISCUSSION_CRITERIA } from "./prompts.ts";

export { lastAgreedList } from "../shared/findings.ts";
export { judgeVerdict as discussionVerdict } from "../shared/findings.ts";

/** The "other folders" note of a critic's criteria; "" without added folders. */
export function foldersNote(folders: string[]): string {
	return folders.length ? `Other folders of this session (part of the work; read them by absolute path):\n${folders.map((f) => `- ${f}`).join("\n")}` : "";
}

/**
 * The critic request of a discussion review. The document is the agreed list plus the transcript: the whole
 * transcript on a first review, the transcript since the last review on a recheck (`recheck`, with the previous findings).
 */
export function discussionCriticRequest(o: { list?: string; transcript: string; folders: string[]; recheck?: { findings: Finding[] }; disputes?: string }): Pick<CriticRequest, "document" | "about" | "criteria" | "previousFindings" | "disputes"> {
	const conclusion = o.list ?? "No `Agreed so far:` list yet: review the latest conclusion in the transcript.";
	return {
		about: "flow discussion",
		document: `### Conclusion under review\n\n${conclusion}\n\n### ${o.recheck ? "Discussion since the last review" : "Discussion transcript"}\n\n${o.transcript}`,
		criteria: [DISCUSSION_CRITERIA, foldersNote(o.folders)].filter(Boolean).join("\n\n"),
		...(o.recheck ? { previousFindings: o.recheck.findings } : {}),
		...(o.disputes ? { disputes: o.disputes } : {}),
	};
}
