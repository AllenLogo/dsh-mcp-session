/**
 * Harness-only fake MCP surface.
 *
 * Registers tools under the exact public naming scheme the real MCP client
 * uses (`mcp__<server>__<tool>`) so the session manager can be exercised in the
 * isolated host without any MCP server, network, or model call.
 *
 * Definitions are cloned from a live first-party tool when one is available
 * (keeping every mandatory field), otherwise built by hand with an explicit
 * `output` declaration — a definition missing `output` fails the whole tree.
 *
 * `globalThis.__fakeMcpReconnect(publicName)` disposes and re-registers one
 * tool with a FRESH definition object and a bumped generation marker. That is
 * how a real MCP server reconnect looks to the registry, and it lets the
 * harness prove the shadow registrations are rebuilt from the new definition
 * (the result text carries the generation that actually executed).
 */
export const name = 'dsh-fake-mcp'
export const inject = ['tools']

const SERVERS = {
  amap: ['maps_geo', 'maps_route', 'maps_weather', 'maps_search'],
  xiaohongshu: ['note_search', 'note_get', 'note_comments'],
  obsidian: ['vault_search', 'vault_read'],
  // Deliberately absent from the harness mcp-session.json: this server exists
  // to exercise hint auto-derivation for an unconfigured server.
  archive: ['archive_search', 'archive_read'],
  // Also unconfigured, and its DESCRIPTIONS are prose full of stopwords. Only
  // server/tool NAMES may become hints, so a message that merely contains
  // "search"/"for"/"the" must NOT reveal this server.
  noisy: ['noisy_ping', 'noisy_sync'],
  // §2.6.1 F1 regression fixtures (mirror the reviewer's `map`/`wiki`): their
  // descriptions contain NON-stopword words ("repository", "structure") that
  // also appear in the unrelated test sentence. If descriptions were ever mined
  // again, these servers would be revealed — the assertion is therefore sharp
  // against description-mining itself, not just against function words.
  map: ['maps_geo'],
  wiki: ['page_get'],
}

/**
 * Prose descriptions for the fixtures. `noisy`/`map`/`wiki` exist specifically
 * so the harness can prove description text is never mined for hints: every
 * word a naive miner would pick up lives only here.
 */
const DESCRIPTIONS = {
  'mcp__noisy__noisy_ping': 'Ping the service for the current search index status.',
  'mcp__noisy__noisy_sync': 'Sync the search index and the metadata for the selected days.',
  'mcp__map__maps_geo': 'Search for a place by address and return its coordinates on the map.',
  'mcp__wiki__page_get': 'Return the repository structure and the summarized index for the team.',
}

const OPEN_OBJECT = { type: 'object', properties: {}, additionalProperties: true }

/** publicName → { lift, generation } */
const registrations = new Map()

export function apply(ctx) {
  const source = ctx.tools.get('todo_write') ?? ctx.tools.get('bash') ?? ctx.tools.get('glob')

  function build(publicName, generation) {
    const execute = async () => ({ ok: true, tool: publicName, generation })
    const output = {
      schema: OPEN_OBJECT,
      render: () => [{ type: 'text', text: `${publicName}:gen${generation}` }],
    }
    const base = {
      name: publicName,
      description: DESCRIPTIONS[publicName] ?? `fake MCP tool ${publicName}`,
      parameters: OPEN_OBJECT,
      output,
      execute,
    }
    return source === undefined ? base : { ...source, ...base }
  }

  function install(publicName) {
    const previous = registrations.get(publicName)
    if (previous !== undefined) previous.lift()
    const generation = (previous?.generation ?? 0) + 1
    const lift = ctx.tools.register(build(publicName, generation))
    registrations.set(publicName, { lift, generation })
    return generation
  }

  let count = 0
  for (const [server, tools] of Object.entries(SERVERS)) {
    for (const tool of tools) {
      install(`mcp__${server}__${tool}`)
      count += 1
    }
  }

  globalThis.__fakeMcpReconnect = (publicName) => install(publicName)
  globalThis.__fakeMcpGenerations = () => Object.fromEntries([...registrations].map(([k, v]) => [k, v.generation]))
  /**
   * Unregister one whole server's tools — the shape of a server being removed
   * from `mcp-servers.json`. Used by V19: the plugin's ledger must stop
   * reporting that server as visible/revealed.
   */
  globalThis.__fakeMcpRemoveServer = (server) => {
    let removed = 0
    for (const publicName of [...registrations.keys()]) {
      if (!publicName.startsWith(`mcp__${server}__`)) continue
      registrations.get(publicName)?.lift()
      registrations.delete(publicName)
      removed += 1
    }
    return removed
  }
  ctx.logger?.info?.(`dsh-fake-mcp: registered ${count} fake mcp tools`)
}
