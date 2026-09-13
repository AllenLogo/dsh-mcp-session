/**
 * MCP tool registry observation.
 *
 * DSH's MCP client registers every remote tool as a global tool named
 * `mcp__<server>__<tool>`. This module mirrors that surface from the GLOBAL
 * view (`ctx.tools.schemas()` / `ctx.tools.get(name)`), maintaining a
 * server → tools map and the exact definition object of each tool so a
 * server reconnect (which registers fresh definition objects) can be detected.
 *
 * It never uses the schema list to decide visibility: visibility is only ever
 * judged by dispatch. The schema list is a name inventory, which is exactly
 * what it is for.
 *
 * @module dsh-mcp-session/registry
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/** One MCP server's currently registered tools. */
export interface ServerEntry {
    /** MCP server namespace (`mcp__<server>__...`). */
    readonly server: string;
    /** Raw remote tool name → its global definition. */
    readonly names: Map<string, ToolDefinition>;
}
/**
 * Split one public MCP tool name into its server namespace and raw tool name.
 *
 * @param name - a candidate tool name.
 * @returns the parsed pair, or `undefined` when the name is not `mcp__<s>__<t>`.
 */
export declare function parseMcpToolName(name: string): {
    server: string;
    tool: string;
} | undefined;
/** Live mirror of the global `mcp__*` tool surface. */
export declare class McpToolRegistry {
    /** Server namespace → its tools. */
    readonly servers: Map<string, ServerEntry>;
    private names;
    private definitions;
    private generation;
    /** Monotonic counter bumped on every accepted rescan. */
    get version(): number;
    /** Every currently registered global `mcp__*` name, sorted. */
    allNames(): readonly string[];
    /**
     * Rescan the global tool surface.
     *
     * @param ctx - a context whose `tools` service reaches the global layer.
     * @returns whether anything changed (name set or a definition identity).
     */
    refresh(ctx: Context): boolean;
    /**
     * Resolve a user-supplied tool reference to a concrete public tool name.
     *
     * Accepts either the raw remote name (`maps_geo`) or the full public name
     * (`mcp__amap__maps_geo`).
     *
     * @param server - the server namespace.
     * @param tool - the caller-supplied tool reference.
     * @returns the public name plus its definition, or `undefined`.
     */
    resolve(server: string, tool: string): {
        publicName: string;
        definition: ToolDefinition;
    } | undefined;
}
