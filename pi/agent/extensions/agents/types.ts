/** Types of agents.json that other extensions read too (through api.ts). Role specs live in ../shared/roles.ts. */

export interface KnowledgeConfig {
	/** MCP server a pi package registers (IEC: "knowledge"). "" turns it off; off too when nothing registered it. */
	server: string;
	/** Subagent roles that get the server's tools. */
	roles: string[];
	/** The server's tools those roles get. Never list one that writes (propose_entry). */
	tools: string[];
	/** Added to the environment of the subagents' copy of the server. */
	env: Record<string, string>;
	/** The judge's last step is the knowledge check; a skipped check gets a separate pass. */
	judgeCheck: boolean;
}
