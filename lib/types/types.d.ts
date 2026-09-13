/**
 * Shared internal types for dsh-mcp-session.
 *
 * The plugin keeps one {@link AgentState} per live agent (a DSH subagent is a
 * first-class agent, so it gets its own state automatically) and one shadow
 * registration set per revealed/pinned server inside that agent's own tool
 * layer.
 *
 * @module dsh-mcp-session/types
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/**
 * The scoped registrations that make one server's native tools visible inside
 * ONE agent's own layer.
 *
 * `defs` keeps the registry definition object each lift was created from so a
 * reconnect (which swaps the definition object on `tools/change`) can be
 * detected without re-registering on every assembly.
 */
export interface ShadowSet {
    /** Raw tool name → the global definition object the lift shadows. */
    readonly defs: Map<string, ToolDefinition>;
    /** Raw tool name → the exact disposer returned by `tools.register`. */
    readonly lifts: Map<string, () => void>;
}
/** Per-agent (= per-session) bookkeeping owned by the plugin. */
export interface AgentState {
    /** Agent/session id. */
    readonly id: string;
    /** The live agent handle. */
    readonly agent: Agent;
    /** Live parent agent id when this agent was created as a subagent. */
    parentId: string | undefined;
    /** Servers the user/model pinned for this session (persist for the session). */
    readonly pinned: Set<string>;
    /** Servers revealed for the CURRENT turn (keyword hit or `mcp_call` acquisition). */
    readonly revealed: Set<string>;
    /** Turn number `revealed` belongs to; a new turn clears it. */
    revealTurn: number;
    /** Concatenated user text claimed in the current turn (hint-matching input). */
    turnText: string;
    /** Per-server shadow registrations currently owned by this agent. */
    readonly shadows: Map<string, ShadowSet>;
    /** Disposers for the plugin's own helper tools registered in this agent's layer. */
    readonly helperLifts: Array<() => void>;
    /** Current `restrict({ deny })` disposer, when a deny is installed. */
    denyLift: (() => void) | undefined;
    /** Global MCP names the installed deny covers (used for cheap change detection). */
    denyNames: string[];
}
