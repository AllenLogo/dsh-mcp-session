/**
 * Session manager: the five modules of the frozen design in one place.
 *
 *  - Registry observation  — {@link McpToolRegistry}, re-scanned on `tools/change`.
 *  - Session state         — one {@link AgentState} per live agent.
 *  - Visibility control    — `restrict({ deny })` + per-agent shadow
 *    registrations (the load-bearing mechanism: a scoped registration shadows
 *    the global tool, is exempt from every ancestor restriction, and is
 *    immediately dispatchable).
 *  - Trigger trio          — keyword auto-reveal, session pin, `mcp_call` proxy.
 *  - Prompt layer          — a compact catalog section, resolved per scope.
 *
 * @module dsh-mcp-session/manager
 */
import type { Context } from '@deepseek-ai/cordis';
import type { McpSessionUserConfig } from './config.js';
import { type ResolvedConfig } from './config.js';
import { McpToolRegistry } from './registry.js';
/** The session-level MCP visibility manager. */
export declare class SessionManager {
    private readonly ctx;
    private readonly userConfig;
    readonly registry: McpToolRegistry;
    private readonly states;
    private toolDefinitions;
    private candidatesCache;
    private candidatesVersion;
    private applying;
    private rescanQueued;
    private failOpen;
    constructor(ctx: Context, userConfig: McpSessionUserConfig);
    /** The resolved config, re-read (mtime-cached) on every access. */
    get config(): ResolvedConfig;
    /** Wire every registration and event hook. Called once from `apply`. */
    start(): void;
    private onAgentCreated;
    private onAgentDisposed;
    /**
     * Recompute THIS turn's reveal set and truncation from the accumulated turn
     * text — one source, one turn (§2.6.1 R3-1).
     *
     * Called from the claim hook AND from every assembly, so what `mcp_status`
     * reports can never contradict the assembly that actually built the tool
     * table. It only ADDS to `revealed` (a delegation reveal or an `mcp_call`
     * acquisition is not a keyword hit and must survive the recomputation).
     */
    private syncTurnReveal;
    private onInboxClaimed;
    private onTurnStopping;
    private onAssembly;
    private onPreExecute;
    private onToolsChange;
    private stateFor;
    /** Configured default pins for a NEW root session (`pins.default` + cwd match). */
    private sessionDefaultPins;
    /**
     * The servers one agent must see: its own pins, this turn's reveals, and
     * every live ancestor's pins (a parent pin is inherited downward; rule 4 —
     * the inheritance is a creation-time snapshot, so it is applied explicitly
     * to each live agent instead of relying on the snapshot).
     */
    private effectiveServers;
    private applyAll;
    /**
     * Make one agent's tool surface match its effective set.
     *
     * Idempotent and delta-driven: the deny is re-installed only when the global
     * MCP name set moved, and a shadow is re-registered only when its definition
     * object changed (server reconnect).
     */
    private applyVisibility;
    private disposeShadow;
    private disposeShadows;
    private releaseDeny;
    /** The helper tools the current config wants registered for one agent. */
    private wantedHelperNames;
    /**
     * Make ONE agent's helper-tool set match the current config.
     *
     * §2.5.4: the helper tools live in the agent's own layer, never in the
     * plugin's global layer — only own-layer registrations are exempt from every
     * ancestor restriction, and a subagent does not inherit the parent agent's
     * layer at all, so this is what keeps `mcp_call` / `mcp_pin` reachable for
     * every agent regardless of how its composition restricts it.
     *
     * Diff-based, not rebuild-based (§2.6.1 F5/F7): helpers that are no longer
     * wanted are released, wanted-but-missing ones are (re)tried, and the healthy
     * rest is left alone — so a `proxyTool` flip is both prompt and cheap, and a
     * transient registration failure is retried instead of being permanent.
     *
     * §2.6.1 F5-④: if NOTHING could be installed for an agent while the config
     * wants helpers, that agent would be denied its native MCP surface AND have no
     * escape hatch. It is switched to a per-agent fail-open instead (its own deny
     * is lifted); this never re-introduces a global registration, which §2.5.4
     * forbids.
     *
     * Must stay synchronous inside the `agent/created` handler: the listener's
     * returned promise is not awaited, so an `await` here would let the agent's
     * first assembly win the race.
     */
    private syncHelpers;
    /** §2.6.1 F7: re-sync one agent's helper set from its next tool entry point. */
    private refreshAgent;
    private disposeHelpers;
    /** A cheap signature of every config field that changes plugin behaviour. */
    private configSignature;
    /**
     * §2.6.1 F5-③/F7: the config file drives the recompute itself.
     *
     * A directory watcher catches editors/scripts that replace the inode, and a
     * slow poll is the safety net for a missed event. Any real change re-applies
     * visibility to EVERY live agent, so a `false → true` flip is deterministic
     * rather than waiting for an incidental dispatch or assembly.
     */
    private watchConfig;
    private invalidateCandidates;
    private candidates;
    private renderSection;
    /**
     * §2.6.1 V19: prune per-turn / per-server ledger entries whose server no
     * longer exists in the registry, so `mcp_status` and the catalog never mark a
     * server as revealed/truncated/visible when its shadow is actually gone.
     *
     * `pinned` is durable user intent and is deliberately KEPT (a reconnect
     * restores it); the status output reports such pins separately as
     * "常驻(未注册)" instead of dropping or misreporting them.
     */
    private pruneLedger;
    private pinTool;
    /**
     * Servers pinned by a LIVE ANCESTOR and not by this agent itself.
     *
     * A subagent cannot release one of these: the pin is materialized from the
     * parent's session set, so `mcp_unpin` on the child would be a no-op that
     * looks like a failure. The pin tool reports the situation instead.
     */
    private inheritedPins;
    private unpinTool;
    /** Servers this agent can actually see: effective set ∩ live registry (V19). */
    private visibleServers;
    private pinsTool;
    private statusTool;
    private callTool;
    private guidance;
    private describe;
    private logError;
    /** A user/model-visible signal for a state change worth knowing about. */
    private logNotice;
}
