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
import type { ServerHintConfig } from './config.js';
import type { ServerEntry } from './registry.js';
/** One server's reveal vocabulary. */
export interface HintCandidate {
    server: string;
    hints: string[];
    /** `true` when the hints came from `mcp-session.json` (higher quality). */
    configured: boolean;
}
/** One matched server, ranked. */
export interface RankedMatch {
    server: string;
    /** Index of the earliest matching hint in the message. */
    at: number;
    /** Length of the matching hint (longer = more specific). */
    length: number;
    /** Whether the matching hint was explicitly configured. */
    configured: boolean;
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
export declare function deriveHints(entry: ServerEntry, limit?: number): string[];
/**
 * Build the candidate list: configured hints win, everything else derives.
 *
 * @param entries - registered servers.
 * @param configured - the user's per-server config.
 * @returns one candidate per server (never empty hints).
 */
export declare function buildCandidates(entries: Iterable<ServerEntry>, configured: Record<string, ServerHintConfig>): HintCandidate[];
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
export declare function rankServers(text: string, candidates: readonly HintCandidate[]): RankedMatch[];
/**
 * Take the reveal budget from a ranked list.
 *
 * @param ranked - best-first matches from {@link rankServers}.
 * @param max - reveal cap (non-positive reveals nothing).
 * @returns the servers to reveal and the ones the cap dropped.
 */
export declare function applyRevealBudget(ranked: readonly RankedMatch[], max: number): {
    revealed: string[];
    truncated: string[];
};
/** One catalog row rendered into the system prompt section. */
export interface CatalogRow {
    server: string;
    label: string | undefined;
    hints: readonly string[];
    toolCount: number;
    pinned: boolean;
    revealed: boolean;
}
/** How the catalog talks about the session tools. */
export interface CatalogOptions {
    /** Servers the reveal cap dropped for the current turn. */
    truncated?: readonly string[];
    /**
     * Whether this agent actually has the helper tools (§2.6.1 F-V1).
     *
     * The catalog must never tell the model to call a tool that was never
     * registered: with `config.proxyTool: false` all five helpers are released,
     * so the operating instructions are rendered against the FACTS.
     */
    helpersEnabled?: boolean;
    /** Hints shown per row before an ellipsis. */
    maxHints?: number;
}
/**
 * Render the compact catalog section.
 *
 * @param rows - one row per registered server.
 * @param options - cap truncation, helper availability, hint budget.
 * @returns the section text, or `''` when there is nothing to advertise.
 */
export declare function renderCatalog(rows: readonly CatalogRow[], options?: CatalogOptions): string;
