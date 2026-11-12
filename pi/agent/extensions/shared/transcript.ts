/** Session transcript serialization shared by the agents and workflow extensions. */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

/** Keeps 30% of `max` from the head and the rest from the tail; the middle is replaced by a marker line. */
export function clipMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.3);
	return `${text.slice(0, head)}\n\n[... ${text.length - max} characters of the middle omitted ...]\n\n${text.slice(text.length - (max - head))}`;
}

/** A session branch, compactions included, as text clipped to `max` characters. */
export function branchTranscript(branch: readonly unknown[], max: number): string {
	const messages: AgentMessage[] = [];
	for (const raw of branch) {
		const entry = raw as { type?: string };
		if (entry.type === "message") messages.push((raw as { message: AgentMessage }).message);
		else if (entry.type === "custom_message") {
			const e = raw as { content: Message["content"] };
			messages.push({ role: "user", content: e.content, timestamp: Date.now() } as AgentMessage);
		}
	}
	return clipMiddle(serializeConversation(convertToLlm(messages)), max);
}
