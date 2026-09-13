import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
/** The operations the tools delegate to the session manager. */
export interface SessionToolHost {
    callTool(caller: Agent | undefined, server: string, tool: string, args: JsonValue | undefined, signal: AbortSignal, callId: string): Promise<JsonValue>;
    pinTool(caller: Agent | undefined, server: string): JsonValue;
    unpinTool(caller: Agent | undefined, server: string): JsonValue;
    pinsTool(caller: Agent | undefined): JsonValue;
    statusTool(caller: Agent | undefined): JsonValue;
    /** §2.6.1 F7: re-sync this agent's helper set from a tool entry point. */
    refresh(caller: Agent | undefined): void;
}
/**
 * Build the plugin's tool definitions.
 *
 * @param host - the session manager these tools drive.
 * @returns the definitions, ready for `agent.ctx.tools.register` (per agent).
 */
export declare function createSessionTools(host: SessionToolHost): ToolDefinition[];
