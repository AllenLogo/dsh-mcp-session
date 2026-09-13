/** One server's user-authored presentation + keyword hints. */
export interface ServerHintConfig {
    /** Human-readable Chinese/English alias shown in the catalog section. */
    label?: string;
    /** Substrings that reveal this server for the current turn. */
    hints?: string[];
}
/** The config shape accepted by both the cordis row and the JSON file. */
export interface McpSessionUserConfig {
    /** `lazy` (default) hides every MCP tool until revealed; `eager` hides nothing. */
    defaultPolicy?: 'lazy' | 'eager';
    /** Keyword auto-reveal from the turn's user text (default true). */
    keywordReveal?: boolean;
    /** Expose `mcp_call` / `mcp_pin` / `mcp_unpin` / `mcp_pins` / `mcp_status`. */
    proxyTool?: boolean;
    /** Inject the compact server catalog into the system prompt (default true). */
    catalog?: boolean;
    /** Reveal limiter. */
    hintScan?: {
        maxServers?: number;
    };
    /** Per-server label + hints; servers absent here derive hints automatically. */
    servers?: Record<string, ServerHintConfig>;
    /** Session defaults. */
    pins?: {
        default?: string[];
        byWorkspace?: Record<string, string[]>;
    };
    /** Directory holding `mcp-session.json` (default `$DSH_HOME`). */
    configDir?: string;
}
/** Fully resolved config (every field present). */
export interface ResolvedConfig {
    defaultPolicy: 'lazy' | 'eager';
    keywordReveal: boolean;
    proxyTool: boolean;
    catalog: boolean;
    maxRevealServers: number;
    servers: Record<string, ServerHintConfig>;
    defaultPins: string[];
    /** Workspace (session cwd prefix) → servers pinned by default there. */
    pinsByWorkspace: Record<string, string[]>;
}
/** The harness home: `$DSH_HOME` when set, else `~/.dsh`. */
export declare function dshHomeDir(): string;
/** Absolute path of the config file this plugin watches. */
export declare function configPath(user: McpSessionUserConfig): string;
/**
 * Read the JSON config file, reusing the last parse until its mtime changes.
 *
 * @param user - the row config (its `configDir` selects the file).
 * @returns the parsed object, or `{}` when the file is missing/unreadable.
 */
export declare function readConfigFile(user: McpSessionUserConfig): McpSessionUserConfig;
/** Merge row config over file config over defaults. */
export declare function resolveConfig(user: McpSessionUserConfig): ResolvedConfig;
