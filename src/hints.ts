/**
 * Keyword hints: derivation, matching, and the compact catalog section.
 *
 * Matching direction matters and is the fix for the "Chinese fuzzy word"
 * failure: a hint is tested as a SUBSTRING OF the user's message
 * (`message.includes(hint)`), never the other way round. A whole sentence is
 * therefore matched by the words it contains, not by an exact index lookup.
 *
 * Derivation is deliberately conservative. Only the server namespace and the
 * tool NAMES contribute automatic hints — never free text from tool
 * descriptions. Descriptions are prose ("… for the current search index
 * status."), so mining them produced generic English fragments ("for", "the",
 * "search") that revealed unrelated servers on any English sentence. Words a
 * user actually says belong in `mcp-session.json`; anything else must be
 * structural. See {@link deriveHints}.
 *
 * @module dsh-mcp-session/hints
 */
import type { ServerHintConfig } from './config.js'
import type { ServerEntry } from './registry.js'

/** One server's reveal vocabulary. */
export interface HintCandidate {
  server: string
  hints: string[]
  /** `true` when the hints came from `mcp-session.json` (higher quality). */
  configured: boolean
}

/** One matched server, ranked. */
export interface RankedMatch {
  server: string
  /** Index of the earliest matching hint in the message. */
  at: number
  /** Length of the matching hint (longer = more specific). */
  length: number
  /** Whether the matching hint was explicitly configured. */
  configured: boolean
}

/**
 * English function words and generic verbs that must never become hints.
 *
 * Tool names are snake_case verb phrases (`get_data`, `send_message`,
 * `search_notes`), so function words AND the generic verb of the operation
 * leak into tokens. None of them discriminate between servers — "search"
 * appearing in `archive_search` says nothing about a sentence that merely
 * contains the word "search". §2.6.1 F1 fixes this list as: function words +
 * generalized verbs (for/the/and/with/return/search/get/read/list/send/create…).
 */
const STOPWORDS = new Set([
  // function words
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'under', 'about', 'after', 'before', 'between',
  'during', 'without', 'within', 'this', 'that', 'these', 'those', 'your', 'yours', 'you', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'all', 'any', 'can', 'could', 'should', 'would', 'will', 'may', 'might',
  'must', 'its', 'their', 'they', 'them', 'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'how', 'why',
  'what', 'than', 'then', 'also', 'more', 'most', 'some', 'such', 'only', 'other', 'others', 'each', 'every',
  'both', 'few', 'many', 'much', 'own', 'same', 'too', 'very', 'just', 'here', 'there', 'now', 'one', 'two', 'per',
  'via',
  // generic verbs / operation nouns
  'search', 'find', 'query', 'lookup', 'fetch', 'load', 'read', 'write', 'create', 'update', 'delete', 'remove',
  'insert', 'append', 'send', 'receive', 'return', 'response', 'request', 'call', 'calls', 'invoke', 'exec',
  'execute', 'run', 'start', 'stop', 'open', 'close', 'add', 'adds', 'put', 'set', 'sets', 'get', 'gets', 'got',
  'list', 'count', 'check', 'test', 'make', 'makes', 'made', 'build', 'parse', 'format', 'convert', 'upload',
  'download', 'sync', 'edit', 'modify', 'select', 'use', 'uses', 'used', 'using', 'do', 'does', 'did', 'done',
  // generic nouns every server has
  'tool', 'tools', 'server', 'servers', 'client', 'service', 'data', 'item', 'items', 'name', 'names', 'value',
  'values', 'result', 'results', 'info', 'status', 'type', 'types', 'file', 'files', 'user', 'api', 'http',
  'https', 'json', 'text', 'message', 'messages', 'content', 'config', 'option', 'options', 'param', 'params',
  'argument', 'arguments', 'current', 'default', 'based', 'given', 'new', 'old',
])

/** Minimum length of an ASCII token that may become a hint. */
const MIN_TOKEN_LENGTH = 4

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** Split an identifier into lowercase words (snake/kebab/dot/camel aware). */
function identifierTokens(value: string): string[] {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
  const out: string[] = []
  for (const raw of spaced.split(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/)) {
    if (raw.length === 0) continue
    if (CJK.test(raw)) {
      // Whole CJK runs only — a 2-gram slice of free text is noise.
      if (raw.length >= 2) out.push(raw)
      continue
    }
    if (raw.length < MIN_TOKEN_LENGTH) continue
    if (STOPWORDS.has(raw)) continue
    if (/^[0-9]+$/.test(raw)) continue
    out.push(raw)
  }
  return out
}

/**
 * Derive hints for a server the user did not configure.
 *
 * Structure only: the server namespace plus every tool name's identifier
 * tokens, filtered by a stopword list and a minimum length of
 * {@link MIN_TOKEN_LENGTH}. Tool descriptions are intentionally ignored — see
 * the module comment. Servers whose vocabulary is genuinely prose must be
 * configured explicitly in `mcp-session.json`.
 *
 * @param entry - the server's registered tools.
 * @param limit - maximum number of hints to keep.
 * @returns lowercased hints, deduplicated and capped.
 */
export function deriveHints(entry: ServerEntry, limit = 12): string[] {
  const out = new Set<string>()
  for (const token of identifierTokens(entry.server)) out.add(token)
  for (const tool of entry.names.keys()) {
    for (const token of identifierTokens(tool)) out.add(token)
    if (out.size >= limit * 3) break
  }
  return [...out].slice(0, limit)
}

/**
 * Build the candidate list: configured hints win, everything else derives.
 *
 * @param entries - registered servers.
 * @param configured - the user's per-server config.
 * @returns one candidate per server (never empty hints).
 */
export function buildCandidates(
  entries: Iterable<ServerEntry>,
  configured: Record<string, ServerHintConfig>,
): HintCandidate[] {
  const out: HintCandidate[] = []
  for (const entry of entries) {
    const user = configured[entry.server]
    const configuredHints = Array.isArray(user?.hints)
      ? user.hints.filter((hint): hint is string => typeof hint === 'string' && hint.trim().length > 0)
      : []
    const hints = configuredHints.length > 0 ? configuredHints.map((hint) => hint.toLowerCase()) : deriveHints(entry)
    out.push({ server: entry.server, hints, configured: configuredHints.length > 0 })
  }
  return out
}

/**
 * Rank every server whose hints appear in the text.
 *
 * Ordered by hint QUALITY first, text position last:
 *  1. explicitly configured hints beat derived ones;
 *  2. within that, the longer (more specific) matching hint wins;
 *  3. only then does an earlier match position break the tie;
 *  4. the server name is the final deterministic tie-break.
 *
 * Position last matters: a derived token that happens to appear early in the
 * sentence must not outrank an explicitly configured server and consume the
 * reveal budget.
 *
 * @param text - the accumulated user text of the current turn.
 * @param candidates - every server's hints.
 * @returns every matching server, best first.
 */
export function rankServers(text: string, candidates: readonly HintCandidate[]): RankedMatch[] {
  const haystack = text.toLowerCase()
  const scored: RankedMatch[] = []
  for (const candidate of candidates) {
    let best: { at: number; length: number } | undefined
    for (const hint of candidate.hints) {
      const at = haystack.indexOf(hint)
      if (at < 0) continue
      if (best === undefined || hint.length > best.length || (hint.length === best.length && at < best.at)) {
        best = { at, length: hint.length }
      }
    }
    if (best !== undefined) {
      scored.push({ server: candidate.server, at: best.at, length: best.length, configured: candidate.configured })
    }
  }
  scored.sort(
    (a, b) =>
      Number(b.configured) - Number(a.configured) ||
      b.length - a.length ||
      a.at - b.at ||
      a.server.localeCompare(b.server),
  )
  return scored
}

/**
 * Take the reveal budget from a ranked list.
 *
 * @param ranked - best-first matches from {@link rankServers}.
 * @param max - reveal cap (non-positive reveals nothing).
 * @returns the servers to reveal and the ones the cap dropped.
 */
export function applyRevealBudget(
  ranked: readonly RankedMatch[],
  max: number,
): { revealed: string[]; truncated: string[] } {
  if (max <= 0) return { revealed: [], truncated: ranked.map((match) => match.server) }
  return {
    revealed: ranked.slice(0, max).map((match) => match.server),
    truncated: ranked.slice(max).map((match) => match.server),
  }
}

/** One catalog row rendered into the system prompt section. */
export interface CatalogRow {
  server: string
  label: string | undefined
  hints: readonly string[]
  toolCount: number
  pinned: boolean
  revealed: boolean
}

/** How the catalog talks about the session tools. */
export interface CatalogOptions {
  /** Servers the reveal cap dropped for the current turn. */
  truncated?: readonly string[]
  /**
   * Whether this agent actually has the helper tools (§2.6.1 F-V1).
   *
   * The catalog must never tell the model to call a tool that was never
   * registered: with `config.proxyTool: false` all five helpers are released,
   * so the operating instructions are rendered against the FACTS.
   */
  helpersEnabled?: boolean
  /** Hints shown per row before an ellipsis. */
  maxHints?: number
}

/**
 * Render the compact catalog section.
 *
 * @param rows - one row per registered server.
 * @param options - cap truncation, helper availability, hint budget.
 * @returns the section text, or `''` when there is nothing to advertise.
 */
export function renderCatalog(rows: readonly CatalogRow[], options: CatalogOptions = {}): string {
  if (rows.length === 0) return ''
  const truncated = options.truncated ?? []
  const helpersEnabled = options.helpersEnabled !== false
  const maxHints = options.maxHints ?? 6

  const lines = rows.map((row) => {
    const label = row.label !== undefined && row.label.length > 0 ? `(${row.label})` : ''
    const shown = row.hints.slice(0, maxHints).join('/')
    const more = row.hints.length > maxHints ? '/…' : ''
    const state = row.pinned ? '常驻' : row.revealed ? '本轮已揭示' : '惰性'
    const keywords = shown.length > 0 ? ` · 触发词:${shown}${more}` : ''
    return `- ${row.server}${label} · ${row.toolCount} 个工具 · 状态:${state}${keywords}`
  })

  const out = [
    '# MCP 服务器(会话级可见性 · dsh-mcp-session)',
    '默认惰性:每条消息里出现下面的触发词时,该服务器的原生工具在本轮自动可用(无需激活);也可以常驻或直达。',
    ...lines,
  ]

  if (truncated.length > 0) {
    const tail = helpersEnabled
      ? '需要时用 mcp_pin / mcp_call 显式取用。'
      : '需要时请在配置里常驻或提高 hintScan.maxServers(本会话未启用代理工具)。'
    out.push(
      `注:本轮另有 ${truncated.length} 个服务器命中触发词但超出揭示上限(hintScan.maxServers),未揭示:${truncated.join(', ')}。${tail}`,
    )
  }

  if (helpersEnabled) {
    out.push(
      '操作:常驻 `mcp_pin(server)` · 收回 `mcp_unpin(server)` · 查看 `mcp_pins()` / `mcp_status()` · 直达 `mcp_call(server, tool, arguments)`。',
      '让子代理用某个 MCP:在委派提示词里点名即可(子代理本轮自动可用);子代理也可以自己 `mcp_pin` / `mcp_call`,不需要父级先知道它。',
    )
  } else {
    // §2.6.1 F-V1: with proxyTool=false none of the five helpers exists, so the
    // operating line must not name them.
    out.push(
      '操作:本会话未启用代理工具(proxyTool=false),没有常驻/直达工具可用 —— 服务器只在出现触发词的当轮自动可用;要长期常驻请在 mcp-session.json 里配置或开启 proxyTool。',
      '让子代理用某个 MCP:在委派提示词里点名即可(子代理本轮自动可用);代理工具关闭时子代理无法自行常驻或直达。',
    )
  }

  return out.join('\n')
}
