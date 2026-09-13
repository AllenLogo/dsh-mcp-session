/**
 * dsh-mcp-session — session-level MCP visibility for DeepSeek Harness.
 *
 * Default-zero-cost MCP access: every `mcp__<server>__*` tool is hidden from
 * every agent until it is either (a) mentioned by a keyword in the current
 * turn, (b) pinned for the session (`mcp_pin`, several at once), or
 * (c) reached through `mcp_call`. Revealing is a per-agent scoped
 * registration, so a subagent can acquire a server on its own and a scheduling
 * parent never has to know the server exists.
 *
 * The plugin never manages MCP connections: `dsh-mcp-manager` / `dsh-mcp-client`
 * keep registering the tools; this plugin only decides which of them each
 * agent sees.
 *
 * @module dsh-mcp-session
 */
import type { Context } from '@deepseek-ai/cordis';
import type { McpSessionUserConfig } from './config.js';
/** Plugin name (must match the cordis insert row `name`). */
export declare const name = "dsh-mcp-session";
/** Services this plugin needs before `apply` runs. */
export declare const inject: string[];
export type { McpSessionUserConfig, ResolvedConfig, ServerHintConfig } from './config.js';
/**
 * Mount the session manager.
 *
 * @param ctx - the plugin's (global) context.
 * @param config - the cordis insert row config; `$DSH_HOME/mcp-session.json`
 *   is merged underneath it.
 */
export declare function apply(ctx: Context, config?: McpSessionUserConfig): void;
