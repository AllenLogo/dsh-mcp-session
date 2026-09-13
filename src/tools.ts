/**
 * The plugin's own model-facing tools.
 *
 * They are registered into EVERY agent's OWN layer (never into the plugin's
 * global layer), because a scoped registration is exempt from every ancestor
 * restriction (`dsh-tools`: a restriction filters what a scope inherits, never
 * what its own layer registers). §2.5.4: a real subagent's scope parent is the
 * agent-preset standing mount — not the parent agent — and with no preset it
 * has no parent scope at all, so a parent's restriction never reaches it. The
 * own-layer registration is therefore what makes a scheduling parent need no
 * MCP knowledge at all: the subagent it spawns still has `mcp_call` /
 * `mcp_pin` available no matter how its composition restricts it.
 *
 * Definitions are built once (they are stateless) and registered per agent by
 * {@link SessionManager.installHelpers}.
 *
 * @module dsh-mcp-session/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** The operations the tools delegate to the session manager. */
export interface SessionToolHost {
  callTool(
    caller: Agent | undefined,
    server: string,
    tool: string,
    args: JsonValue | undefined,
    signal: AbortSignal,
    callId: string,
  ): Promise<JsonValue>
  pinTool(caller: Agent | undefined, server: string): JsonValue
  unpinTool(caller: Agent | undefined, server: string): JsonValue
  pinsTool(caller: Agent | undefined): JsonValue
  statusTool(caller: Agent | undefined): JsonValue
  /** §2.6.1 F7: re-sync this agent's helper set from a tool entry point. */
  refresh(caller: Agent | undefined): void
}

/** Render one canonical JSON value as the model-facing text block. */
function renderValue(value: JsonValue): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const text = (value as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

const textOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: renderValue(value) }],
}

/**
 * Build the plugin's tool definitions.
 *
 * @param host - the session manager these tools drive.
 * @returns the definitions, ready for `agent.ctx.tools.register` (per agent).
 */
export function createSessionTools(host: SessionToolHost): ToolDefinition[] {
  const pin = defineTool({
    name: 'mcp_pin',
    description:
      'Pin an MCP server to THIS session so its native tools (mcp__<server>__*) stay visible for every ' +
      'remaining turn. Multiple servers can be pinned at once. Use it when the user says a server will be ' +
      'needed throughout the conversation. It takes effect for the next step of this turn.',
    parameters: { server: { type: 'string', required: true, description: 'MCP server name, e.g. "amap".' } },
    output: textOutput,
    execute: (args, exec) => {
      host.refresh(exec.agent)
      return Promise.resolve(host.pinTool(exec.agent, args.server))
    },
  })

  const unpin = defineTool({
    name: 'mcp_unpin',
    description:
      'Release a previously pinned MCP server in THIS session. Its tools become lazily revealed again ' +
      '(keyword hits and mcp_call still work).',
    parameters: { server: { type: 'string', required: true, description: 'MCP server name to release.' } },
    output: textOutput,
    execute: (args, exec) => {
      host.refresh(exec.agent)
      return Promise.resolve(host.unpinTool(exec.agent, args.server))
    },
  })

  const pins = defineTool({
    name: 'mcp_pins',
    description:
      'List the MCP servers pinned/revealed for this session, plus everything currently visible to this agent.',
    parameters: {},
    output: textOutput,
    execute: (_args, exec) => {
      host.refresh(exec.agent)
      return Promise.resolve(host.pinsTool(exec.agent))
    },
  })

  const status = defineTool({
    name: 'mcp_status',
    description:
      'Diagnostic report for the session-level MCP visibility manager: every registered server, its tool ' +
      'count, each live agent\'s effective visible set, and the ACTUAL helper-tool registration state ' +
      '(from the plugin\'s own ledger, not from a schema probe). Use it when an MCP tool seems unavailable.',
    parameters: {},
    output: textOutput,
    execute: (_args, exec) => {
      host.refresh(exec.agent)
      return Promise.resolve(host.statusTool(exec.agent))
    },
  })

  const call = defineTool({
    name: 'mcp_call',
    description:
      'Call one MCP tool directly by (server, tool) name, whether or not that server is currently revealed. ' +
      'This is the fallback path: it reveals the server for the caller and dispatches the native tool in one ' +
      'step. Prefer calling the native mcp__<server>__<tool> when it is already visible.',
    parameters: {
      server: { type: 'string', required: true, description: 'MCP server name, e.g. "amap".' },
      tool: {
        type: 'string',
        required: true,
        description: 'The remote tool name (e.g. "maps_geo") or its full public name (mcp__amap__maps_geo).',
      },
      arguments: { type: 'json', description: 'The tool arguments as a JSON object.' },
    },
    output: textOutput,
    execute: (args, exec) =>
      host.callTool(exec.agent, args.server, args.tool, args.arguments as JsonValue | undefined, exec.signal, String(exec.callId)),
  })

  return [call, pin, unpin, pins, status]
}
