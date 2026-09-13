/**
 * Plugin configuration: `$DSH_HOME/mcp-session.json` plus the cordis entry
 * config, with hot reload by mtime.
 *
 * Precedence, highest first: the value on the cordis insert row, then the
 * config file, then the built-in default. Reading is total: a missing or
 * malformed file never throws and never changes the plugin's behaviour beyond
 * falling back to defaults.
 *
 * @module dsh-mcp-session/config
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One server's user-authored presentation + keyword hints. */
export interface ServerHintConfig {
  /** Human-readable Chinese/English alias shown in the catalog section. */
  label?: string
  /** Substrings that reveal this server for the current turn. */
  hints?: string[]
}

/** The config shape accepted by both the cordis row and the JSON file. */
export interface McpSessionUserConfig {
  /** `lazy` (default) hides every MCP tool until revealed; `eager` hides nothing. */
  defaultPolicy?: 'lazy' | 'eager'
  /** Keyword auto-reveal from the turn's user text (default true). */
  keywordReveal?: boolean
  /** Expose `mcp_call` / `mcp_pin` / `mcp_unpin` / `mcp_pins` / `mcp_status`. */
  proxyTool?: boolean
  /** Inject the compact server catalog into the system prompt (default true). */
  catalog?: boolean
  /** Reveal limiter. */
  hintScan?: { maxServers?: number }
  /** Per-server label + hints; servers absent here derive hints automatically. */
  servers?: Record<string, ServerHintConfig>
  /** Session defaults. */
  pins?: { default?: string[]; byWorkspace?: Record<string, string[]> }
  /** Directory holding `mcp-session.json` (default `$DSH_HOME`). */
  configDir?: string
}

/** Fully resolved config (every field present). */
export interface ResolvedConfig {
  defaultPolicy: 'lazy' | 'eager'
  keywordReveal: boolean
  proxyTool: boolean
  catalog: boolean
  maxRevealServers: number
  servers: Record<string, ServerHintConfig>
  defaultPins: string[]
  /** Workspace (session cwd prefix) → servers pinned by default there. */
  pinsByWorkspace: Record<string, string[]>
}

/** The harness home: `$DSH_HOME` when set, else `~/.dsh`. */
export function dshHomeDir(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** Absolute path of the config file this plugin watches. */
export function configPath(user: McpSessionUserConfig): string {
  const dir = typeof user.configDir === 'string' && user.configDir.length > 0 ? user.configDir : dshHomeDir()
  return join(dir, 'mcp-session.json')
}

interface CacheEntry {
  mtimeMs: number
  value: McpSessionUserConfig
}

const fileCache = new Map<string, CacheEntry>()

/**
 * Read the JSON config file, reusing the last parse until its mtime changes.
 *
 * @param user - the row config (its `configDir` selects the file).
 * @returns the parsed object, or `{}` when the file is missing/unreadable.
 */
export function readConfigFile(user: McpSessionUserConfig): McpSessionUserConfig {
  const path = configPath(user)
  try {
    const stats = statSync(path)
    const cached = fileCache.get(path)
    if (cached !== undefined && cached.mtimeMs === stats.mtimeMs) return cached.value
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const value: McpSessionUserConfig =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as McpSessionUserConfig) : {}
    fileCache.set(path, { mtimeMs: stats.mtimeMs, value })
    return value
  } catch {
    fileCache.delete(path)
    return {}
  }
}

function pick<T>(row: T | undefined, file: T | undefined, fallback: T): T {
  if (row !== undefined) return row
  if (file !== undefined) return file
  return fallback
}

/** Merge row config over file config over defaults. */
export function resolveConfig(user: McpSessionUserConfig): ResolvedConfig {
  const file = readConfigFile(user)
  const rowScan = user.hintScan?.maxServers
  const fileScan = file.hintScan?.maxServers
  const rawMax = pick(rowScan, fileScan, 3)
  const maxRevealServers = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax as number)) : 3
  const serverMap = pick(user.servers, file.servers, {})
  return {
    defaultPolicy: pick(user.defaultPolicy, file.defaultPolicy, 'lazy'),
    keywordReveal: pick(user.keywordReveal, file.keywordReveal, true),
    proxyTool: pick(user.proxyTool, file.proxyTool, true),
    catalog: pick(user.catalog, file.catalog, true),
    maxRevealServers,
    servers: serverMap !== null && typeof serverMap === 'object' ? serverMap : {},
    defaultPins: normaliseStringList(pick(user.pins, file.pins, {})?.default),
    pinsByWorkspace: normaliseWorkspacePins(pick(user.pins, file.pins, {})?.byWorkspace),
  }
}

function normaliseWorkspacePins(value: unknown): Record<string, string[]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string[]> = {}
  for (const [workspace, pins] of Object.entries(value as Record<string, unknown>)) {
    const list = normaliseStringList(pins)
    if (workspace.length > 0 && list.length > 0) out[workspace] = list
  }
  return out
}

function normaliseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}
