import { watch } from 'node:fs';
import { dirname, basename } from 'node:path';
import { configPath, resolveConfig } from './config.js';
import { applyRevealBudget, buildCandidates, rankServers, renderCatalog } from './hints.js';
import { McpToolRegistry } from './registry.js';
import { createSessionTools } from './tools.js';
/** System-prompt section placement (after per-tool guidance, before policy). */
const SECTION_NAME = 'mcp-session';
const SECTION_ORDER = 300;
/**
 * Every helper tool the plugin registers per agent. §2.6.1 F3: `config.proxyTool`
 * gates the registration of ALL FIVE, `mcp_status` included — the switch turns
 * the plugin's whole tool surface off (per-agent deny, keyword reveal and the
 * catalog keep working). There is deliberately no "diagnostic exception":
 * a half-gated surface is what made the old `mcp_status` banner contradict the
 * facts.
 */
const HELPER_TOOL_NAMES = ['mcp_call', 'mcp_pin', 'mcp_unpin', 'mcp_pins', 'mcp_status'];
/** How often the config file is re-checked as a safety net for the watcher. */
const CONFIG_POLL_MS = 1000;
/**
 * Tools whose dispatch hands work to a subagent. Intercepting them implements
 * the design's D2 "delegation reveal": naming a server in the delegation prompt
 * reveals it in the PARENT's scope for that turn, and the plugin materializes
 * the reveal into the child when it is created, so the child gets the tools with
 * zero extra round trips.
 *
 * This is a pure optimisation and it does NOT rely on scope inheritance
 * (§2.5.4): a subagent's scope parent is the delegating agent's preset standing
 * mount — never that agent's own layer — and with no preset it has no parent
 * scope at all. The child can always acquire on its own via `mcp_call` /
 * `mcp_pin`, which is why the delegation interception is optional.
 */
const DELEGATION_TOOLS = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph']);
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Extract the text blocks of one message. */
function messageText(message) {
    if (message === undefined)
        return '';
    const blocks = message.content;
    if (!Array.isArray(blocks))
        return '';
    const parts = [];
    for (const block of blocks) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
    }
    return parts.join('\n');
}
/**
 * Whether a message may drive keyword reveal.
 *
 * Real user input and delegation prompts both arrive as `{ kind: 'user' }`
 * (`dsh-subagent` builds its task message that way). Injected runtime context
 * arrives plugin-sourced with a `snapshot` form and is skipped so a catalog
 * snapshot can never reveal the servers it lists.
 */
function isSignalText(message) {
    if (message === undefined)
        return false;
    const source = message.source;
    if (source === undefined)
        return true;
    if (source.kind === 'user')
        return true;
    if (source.kind === 'plugin') {
        return source.form !== 'snapshot' && source.form !== 'catalog' && source.form !== 'instructions';
    }
    return false;
}
function blocksToText(content) {
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string')
            parts.push(block.text);
    }
    return parts.join('\n');
}
/** The last user-authored text of one agent's session log (fallback path). */
function latestUserText(agent) {
    try {
        const events = agent.session?.snapshotEvents?.();
        if (!Array.isArray(events))
            return '';
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (event === undefined || event.type !== 'user/message')
                continue;
            const message = event.data;
            if (!isSignalText(message))
                continue;
            const text = messageText(message);
            if (text.length > 0)
                return text;
        }
    }
    catch {
        /* a session shape change must never break visibility */
    }
    return '';
}
/** The session-level MCP visibility manager. */
export class SessionManager {
    ctx;
    userConfig;
    registry = new McpToolRegistry();
    states = new Map();
    toolDefinitions = [];
    candidatesCache;
    candidatesVersion = -1;
    applying = false;
    rescanQueued = false;
    failOpen = false;
    constructor(ctx, userConfig) {
        this.ctx = ctx;
        this.userConfig = userConfig;
    }
    /** The resolved config, re-read (mtime-cached) on every access. */
    get config() {
        return resolveConfig(this.userConfig);
    }
    /** Wire every registration and event hook. Called once from `apply`. */
    start() {
        this.toolDefinitions = createSessionTools({
            callTool: (caller, server, tool, args, signal, callId) => this.callTool(caller, server, tool, args, signal, callId),
            pinTool: (caller, server) => this.pinTool(caller, server),
            unpinTool: (caller, server) => this.unpinTool(caller, server),
            pinsTool: (caller) => this.pinsTool(caller),
            statusTool: (caller) => this.statusTool(caller),
            // §2.6.1 F7: every helper entry point re-syncs this agent's helper set
            // before doing anything. The comparison is a cheap name-set check, and it
            // makes a config flip take effect on the very next dispatch instead of
            // waiting for an incidental assembly.
            refresh: (caller) => this.refreshAgent(caller),
        });
        // The session tools are NOT registered in the plugin's (global) layer.
        // §2.5.4: they are registered into EVERY agent's own layer, because a
        // scoped registration is exempt from every ancestor restriction — a global
        // one would be hidden from an agent whose composition applies an
        // allow-filter (e.g. a subagent's `toolFilter`), taking the plugin's own
        // escape hatch away exactly when the agent needs it. See `installHelpers`.
        // Prompt layer: the catalog section is resolved per assembly and per scope.
        this.ctx.effect(() => this.ctx.systemPrompt.section({
            name: SECTION_NAME,
            order: SECTION_ORDER,
            text: (context) => this.renderSection(context),
        }), 'dsh-mcp-session: catalog section');
        // Assembly hook: a safety net that re-applies visibility for the exact
        // agent being assembled (pins / tools/change landed since the last step).
        // The reveal itself happens EARLIER, on `agent/inbox/claimed`, because the
        // tool tree is collected from the registry provider BEFORE this provider
        // runs; a registration performed here would only reach the NEXT assembly.
        this.ctx.effect(() => this.ctx.systemPrompt.tools((context) => {
            this.onAssembly(context);
            return { schemas: [] };
        }), 'dsh-mcp-session: assembly hook');
        // Lifecycle hooks. `agent/created` fires for subagents too, and the hook
        // must be registered synchronously as the FIRST thing it does.
        // `agent/created` is a serial listener typed `undefined | Promise<undefined>`
        // at DSH 0.2.0 (the framework awaits these before creation resolves, so a
        // `void`-returning expression body no longer type-checks). The explicit
        // `return undefined` is what makes the inferred return type `undefined`
        // rather than `void`, and the handler stays synchronous — which the
        // no-IO-before-state contract above depends on.
        this.ctx.on('agent/created', (payload) => {
            this.onAgentCreated(payload);
            return undefined;
        });
        this.ctx.on('agent/disposed', (payload) => this.onAgentDisposed(payload));
        this.ctx.on('agent/inbox/claimed', (payload) => this.onInboxClaimed(payload));
        this.ctx.on('agent/turn-stopping', (payload) => this.onTurnStopping(payload));
        this.ctx.on('tools/pre-execute', (exec, next) => this.onPreExecute(exec, next));
        this.ctx.on('tools/change', () => this.onToolsChange());
        // Orderly teardown: release every registration this plugin owns.
        this.ctx.effect(() => () => {
            for (const state of this.states.values()) {
                this.disposeShadows(state);
                this.disposeHelpers(state);
                this.releaseDeny(state);
            }
            this.states.clear();
        }, 'dsh-mcp-session: teardown');
        // §2.6.1 F7: the config file itself must DRIVE the recompute. Watching the
        // directory (not the file) catches editors and scripts that replace the
        // inode, and a slow poll is the safety net for a missed event.
        this.ctx.effect(() => this.watchConfig(), 'dsh-mcp-session: config watch');
        if (this.registry.refresh(this.ctx))
            this.invalidateCandidates();
        this.applyAll();
    }
    // ---------------------------------------------------------------- lifecycle
    onAgentCreated(payload) {
        // No `await`, no I/O before the state exists: a delay here lets the first
        // assembly win the race and the agent sees an unmanaged tool surface.
        try {
            const state = this.stateFor(payload.agent);
            // applyVisibility() syncs the helper tools first, so the agent's very
            // first assembly already sees them.
            this.applyVisibility(state);
        }
        catch (error) {
            this.logError('agent/created', error);
        }
    }
    onAgentDisposed(payload) {
        try {
            const id = String(payload.agent.id);
            const state = this.states.get(id);
            if (state === undefined)
                return;
            this.disposeShadows(state);
            this.disposeHelpers(state);
            this.releaseDeny(state);
            this.states.delete(id);
        }
        catch (error) {
            this.logError('agent/disposed', error);
        }
    }
    /**
     * Recompute THIS turn's reveal set and truncation from the accumulated turn
     * text — one source, one turn (§2.6.1 R3-1).
     *
     * Called from the claim hook AND from every assembly, so what `mcp_status`
     * reports can never contradict the assembly that actually built the tool
     * table. It only ADDS to `revealed` (a delegation reveal or an `mcp_call`
     * acquisition is not a keyword hit and must survive the recomputation).
     */
    syncTurnReveal(state, max) {
        if (state.turnText.length === 0)
            return false;
        const budget = applyRevealBudget(rankServers(state.turnText, this.candidates()), max);
        state.truncated = budget.truncated;
        let changed = false;
        for (const server of budget.revealed) {
            if (!state.revealed.has(server)) {
                state.revealed.add(server);
                changed = true;
            }
        }
        return changed;
    }
    onInboxClaimed(payload) {
        try {
            const config = this.config;
            if (!config.keywordReveal || config.defaultPolicy === 'eager')
                return;
            const text = isSignalText(payload.message) ? messageText(payload.message) : '';
            if (text.length === 0)
                return;
            const state = this.stateFor(payload.agent);
            if (payload.turn !== state.revealTurn) {
                state.revealTurn = payload.turn;
                state.revealed.clear();
                state.turnText = '';
            }
            state.turnText = state.turnText.length === 0 ? text : `${state.turnText}\n${text}`;
            if (this.syncTurnReveal(state, config.maxRevealServers))
                this.applyVisibility(state);
        }
        catch (error) {
            this.logError('agent/inbox/claimed', error);
        }
    }
    onTurnStopping(payload) {
        try {
            const state = this.states.get(String(payload.agent.id));
            if (state === undefined)
                return;
            state.turnText = '';
            state.truncated = [];
            if (state.revealed.size === 0)
                return;
            state.revealed.clear();
            this.applyVisibility(state);
        }
        catch (error) {
            this.logError('agent/turn-stopping', error);
        }
    }
    onAssembly(context) {
        try {
            const agent = context.agent;
            if (agent === undefined)
                return;
            const state = this.states.get(String(agent.id));
            if (state === undefined)
                return;
            const config = this.config;
            if (config.keywordReveal && config.defaultPolicy !== 'eager') {
                if (state.revealTurn < 0) {
                    // Bootstrap only: `user/message` is appended to the session log AFTER
                    // the step's assembly, so the log is stale during the first assembly of
                    // a turn. This fallback runs only for an agent whose claim we never
                    // observed (e.g. the plugin was mounted around a live session); once a
                    // claim has been seen, the claimed text is authoritative.
                    const text = latestUserText(agent);
                    if (text.length > 0)
                        state.turnText = text;
                }
                // §2.6.1 R3-1: recompute from the SAME text the reveal used, so the
                // ledger `mcp_status` reads right after this assembly cannot contradict
                // the tool table this assembly produced.
                this.syncTurnReveal(state, config.maxRevealServers);
            }
            this.applyVisibility(state);
        }
        catch (error) {
            this.logError('system-prompt/tools', error);
        }
    }
    onPreExecute(exec, next) {
        try {
            if (DELEGATION_TOOLS.has(exec.name) && exec.agent !== undefined) {
                const config = this.config;
                if (config.keywordReveal && config.defaultPolicy !== 'eager') {
                    const state = this.stateFor(exec.agent);
                    const text = JSON.stringify(exec.arguments ?? '');
                    const budget = applyRevealBudget(rankServers(text, this.candidates()), config.maxRevealServers);
                    // Servers revealed by the delegation prompt are ADDED here; the
                    // truncation ledger stays owned by syncTurnReveal (called from every
                    // assembly) so `mcp_status` keeps one source of truth (§2.6.1 R3-1).
                    let changed = false;
                    for (const server of budget.revealed) {
                        if (!state.revealed.has(server)) {
                            state.revealed.add(server);
                            changed = true;
                        }
                    }
                    if (changed)
                        this.applyVisibility(state);
                }
            }
        }
        catch (error) {
            this.logError('tools/pre-execute', error);
        }
        return next();
    }
    onToolsChange() {
        // Our own registrations emit this event while `applying`; a scoped
        // registration never changes the GLOBAL name set, so skipping is exact.
        if (this.applying || this.rescanQueued)
            return;
        this.rescanQueued = true;
        queueMicrotask(() => {
            this.rescanQueued = false;
            try {
                if (this.registry.refresh(this.ctx)) {
                    this.invalidateCandidates();
                    this.applyAll();
                }
            }
            catch (error) {
                this.logError('tools/change', error);
            }
        });
    }
    // ------------------------------------------------------------------- state
    stateFor(agent) {
        const id = String(agent.id);
        const existing = this.states.get(id);
        if (existing !== undefined)
            return existing;
        const header = agent.session?.header;
        const depth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0;
        const parentSession = header?.parentSession;
        const parentId = depth > 0 && typeof parentSession === 'string' && parentSession.length > 0 ? parentSession : undefined;
        const state = {
            id,
            agent,
            parentId,
            pinned: new Set(),
            revealed: new Set(),
            revealTurn: -1,
            turnText: '',
            shadows: new Map(),
            helperLifts: [],
            denyLift: undefined,
            denyNames: [],
            truncated: [],
            helperNames: [],
            helperFailures: [],
            helperFailOpen: false,
            pinnedMissing: [],
        };
        if (depth === 0) {
            for (const server of this.sessionDefaultPins(agent))
                state.pinned.add(server);
        }
        this.states.set(id, state);
        return state;
    }
    /** Configured default pins for a NEW root session (`pins.default` + cwd match). */
    sessionDefaultPins(agent) {
        const config = this.config;
        const out = [...config.defaultPins];
        const cwd = agent.session?.header?.cwd;
        if (typeof cwd !== 'string' || cwd.length === 0)
            return out;
        for (const [workspace, pins] of Object.entries(config.pinsByWorkspace)) {
            if (workspace.length === 0)
                continue;
            const prefix = workspace.endsWith('/') ? workspace : `${workspace}/`;
            if (cwd !== workspace && !cwd.startsWith(prefix))
                continue;
            for (const pin of pins)
                if (!out.includes(pin))
                    out.push(pin);
        }
        return out;
    }
    /**
     * The servers one agent must see: its own pins, this turn's reveals, and
     * every live ancestor's pins (a parent pin is inherited downward; rule 4 —
     * the inheritance is a creation-time snapshot, so it is applied explicitly
     * to each live agent instead of relying on the snapshot).
     */
    effectiveServers(state) {
        const out = new Set(state.pinned);
        for (const server of state.revealed)
            out.add(server);
        const seen = new Set([state.id]);
        let cursor = state.parentId;
        while (cursor !== undefined && !seen.has(cursor)) {
            seen.add(cursor);
            const parent = this.states.get(cursor);
            if (parent === undefined)
                break;
            for (const server of parent.pinned)
                out.add(server);
            cursor = parent.parentId;
        }
        return out;
    }
    applyAll() {
        for (const state of this.states.values())
            this.applyVisibility(state);
    }
    /**
     * Make one agent's tool surface match its effective set.
     *
     * Idempotent and delta-driven: the deny is re-installed only when the global
     * MCP name set moved, and a shadow is re-registered only when its definition
     * object changed (server reconnect).
     */
    applyVisibility(state) {
        const config = this.config;
        this.applying = true;
        try {
            // Helper registration tracks `proxyTool` on every pass, which is how a
            // hot config flip is applied and how a failed registration is retried.
            this.syncHelpers(state);
            // §2.6.1 V19: never report a server the registry no longer has.
            this.pruneLedger(state);
            if (config.defaultPolicy === 'eager') {
                // Explicit opt-out: behave exactly like a stock deployment.
                this.disposeShadows(state);
                this.releaseDeny(state);
                return;
            }
            if (state.helperFailOpen) {
                // §2.6.1 F5-④: this agent could not install ANY helper, so hiding its
                // native MCP surface would leave it with no way back. Fail open for this
                // agent only (never a global registration — §2.5.4 forbids that).
                this.disposeShadows(state);
                this.releaseDeny(state);
                return;
            }
            const desired = this.effectiveServers(state);
            const allNames = this.registry.allNames();
            const denyCurrent = allNames.length === state.denyNames.length && allNames.every((name, index) => name === state.denyNames[index]);
            if (!denyCurrent) {
                this.releaseDeny(state);
                if (allNames.length > 0) {
                    try {
                        state.denyLift = state.agent.ctx.tools.restrict({ deny: [...allNames] });
                        state.denyNames = [...allNames];
                        this.failOpen = false;
                    }
                    catch (error) {
                        // §2.7 fail-open: never hide anything behind a broken restrict.
                        state.denyLift = undefined;
                        state.denyNames = [];
                        this.failOpen = true;
                        this.logError('restrict', error);
                    }
                }
            }
            for (const server of [...state.shadows.keys()]) {
                if (!desired.has(server) || !this.registry.servers.has(server))
                    this.disposeShadow(state, server);
            }
            for (const server of desired) {
                const entry = this.registry.servers.get(server);
                if (entry === undefined)
                    continue;
                let shadow = state.shadows.get(server);
                if (shadow === undefined) {
                    shadow = { defs: new Map(), lifts: new Map() };
                    state.shadows.set(server, shadow);
                }
                for (const [tool, definition] of entry.names) {
                    if (shadow.defs.get(tool) === definition)
                        continue;
                    const previous = shadow.lifts.get(tool);
                    if (previous !== undefined) {
                        try {
                            previous();
                        }
                        catch {
                            /* a stale lift is already gone */
                        }
                    }
                    shadow.lifts.set(tool, state.agent.ctx.tools.register(definition));
                    shadow.defs.set(tool, definition);
                }
                for (const [tool, lift] of [...shadow.lifts]) {
                    if (entry.names.has(tool))
                        continue;
                    try {
                        lift();
                    }
                    catch {
                        /* already released */
                    }
                    shadow.lifts.delete(tool);
                    shadow.defs.delete(tool);
                }
            }
        }
        finally {
            this.applying = false;
        }
    }
    disposeShadow(state, server) {
        const shadow = state.shadows.get(server);
        if (shadow === undefined)
            return;
        state.shadows.delete(server);
        for (const lift of shadow.lifts.values()) {
            try {
                lift();
            }
            catch {
                /* already released */
            }
        }
        shadow.lifts.clear();
        shadow.defs.clear();
    }
    disposeShadows(state) {
        for (const server of [...state.shadows.keys()])
            this.disposeShadow(state, server);
    }
    releaseDeny(state) {
        const lift = state.denyLift;
        state.denyLift = undefined;
        state.denyNames = [];
        if (lift === undefined)
            return;
        try {
            lift();
        }
        catch {
            /* already released */
        }
    }
    /** The helper tools the current config wants registered for one agent. */
    wantedHelperNames() {
        // §2.6.1 F3: `proxyTool` gates ALL FIVE helpers. false ⇒ the plugin's tool
        // surface is empty (per-agent deny + keyword reveal + catalog remain).
        return this.config.proxyTool ? [...HELPER_TOOL_NAMES] : [];
    }
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
    syncHelpers(state) {
        const wanted = this.wantedHelperNames();
        const wantedSet = new Set(wanted);
        for (let index = state.helperNames.length - 1; index >= 0; index -= 1) {
            const name = state.helperNames[index];
            if (name !== undefined && wantedSet.has(name))
                continue;
            const lift = state.helperLifts[index];
            try {
                lift?.();
            }
            catch {
                /* already released */
            }
            state.helperLifts.splice(index, 1);
            state.helperNames.splice(index, 1);
        }
        for (const definition of this.toolDefinitions) {
            if (!wantedSet.has(definition.name))
                continue;
            if (state.helperNames.includes(definition.name))
                continue;
            try {
                state.helperLifts.push(state.agent.ctx.tools.register(definition));
                state.helperNames.push(definition.name);
                state.helperFailures = state.helperFailures.filter((name) => name !== definition.name);
            }
            catch (error) {
                if (!state.helperFailures.includes(definition.name))
                    state.helperFailures.push(definition.name);
                this.logError(`register helper ${definition.name} for ${state.id}`, error);
            }
        }
        const wantHelp = wanted.length > 0;
        state.helperFailOpen = wantHelp && state.helperNames.length === 0 && state.helperFailures.length > 0;
    }
    /** §2.6.1 F7: re-sync one agent's helper set from its next tool entry point. */
    refreshAgent(caller) {
        if (caller === undefined)
            return;
        try {
            const state = this.states.get(String(caller.id));
            if (state !== undefined)
                this.syncHelpers(state);
        }
        catch (error) {
            this.logError('refresh', error);
        }
    }
    disposeHelpers(state) {
        for (const lift of state.helperLifts.reverse()) {
            try {
                lift();
            }
            catch {
                /* already released */
            }
        }
        state.helperLifts.length = 0;
        state.helperNames.length = 0;
    }
    // ------------------------------------------------------------------ config
    /** A cheap signature of every config field that changes plugin behaviour. */
    configSignature() {
        const config = this.config;
        return [
            config.defaultPolicy,
            String(config.keywordReveal),
            String(config.proxyTool),
            String(config.catalog),
            String(config.maxRevealServers),
            JSON.stringify(this.userConfig.servers ?? {}),
            process.env.DSH_HOME ?? '',
        ].join('|');
    }
    /**
     * §2.6.1 F5-③/F7: the config file drives the recompute itself.
     *
     * A directory watcher catches editors/scripts that replace the inode, and a
     * slow poll is the safety net for a missed event. Any real change re-applies
     * visibility to EVERY live agent, so a `false → true` flip is deterministic
     * rather than waiting for an incidental dispatch or assembly.
     */
    watchConfig() {
        let signature = this.configSignature();
        let timer;
        let watcher;
        const check = () => {
            try {
                const next = this.configSignature();
                if (next === signature)
                    return;
                signature = next;
                this.invalidateCandidates();
                this.logNotice(`config changed (proxyTool=${String(this.config.proxyTool)}) — re-applying to every live agent`);
                this.applyAll();
            }
            catch (error) {
                this.logError('config change', error);
            }
        };
        const path = configPath(this.userConfig);
        try {
            watcher = watch(dirname(path), (_event, filename) => {
                if (filename !== null && filename !== undefined && String(filename) !== basename(path))
                    return;
                check();
            });
            watcher.on?.('error', (error) => this.logError('config watch', error));
        }
        catch (error) {
            this.logError('config watch setup', error);
        }
        timer = setInterval(check, CONFIG_POLL_MS);
        timer.unref?.();
        return () => {
            if (timer !== undefined)
                clearInterval(timer);
            try {
                watcher?.close();
            }
            catch {
                /* already closed */
            }
        };
    }
    // ---------------------------------------------------------------- keywords
    invalidateCandidates() {
        this.candidatesCache = undefined;
    }
    candidates() {
        const version = this.registry.version;
        if (this.candidatesCache === undefined || this.candidatesVersion !== version) {
            this.candidatesCache = buildCandidates(this.registry.servers.values(), this.config.servers);
            this.candidatesVersion = version;
        }
        return this.candidatesCache;
    }
    renderSection(context) {
        try {
            const config = this.config;
            if (!config.catalog || config.defaultPolicy === 'eager')
                return '';
            if (this.registry.servers.size === 0)
                return '';
            const agent = context.agent;
            const state = agent === undefined ? undefined : this.states.get(String(agent.id));
            const byServer = new Map(this.candidates().map((candidate) => [candidate.server, candidate]));
            const rows = [];
            for (const entry of this.registry.servers.values()) {
                rows.push({
                    server: entry.server,
                    label: config.servers[entry.server]?.label,
                    hints: byServer.get(entry.server)?.hints ?? [],
                    toolCount: entry.names.size,
                    pinned: state?.pinned.has(entry.server) ?? false,
                    revealed: state?.revealed.has(entry.server) ?? false,
                });
            }
            rows.sort((left, right) => left.server.localeCompare(right.server));
            // §2.6.1 F-V1: the operating instructions are rendered against the FACTS
            // for this agent — with `proxyTool: false` the five helpers do not exist,
            // so the section must not name them.
            const helpersEnabled = this.wantedHelperNames().length > 0;
            return renderCatalog(rows, { truncated: state?.truncated ?? [], helpersEnabled });
        }
        catch (error) {
            this.logError('catalog section', error);
            return '';
        }
    }
    /**
     * §2.6.1 V19: prune per-turn / per-server ledger entries whose server no
     * longer exists in the registry, so `mcp_status` and the catalog never mark a
     * server as revealed/truncated/visible when its shadow is actually gone.
     *
     * `pinned` is durable user intent and is deliberately KEPT (a reconnect
     * restores it); the status output reports such pins separately as
     * "常驻(未注册)" instead of dropping or misreporting them.
     */
    pruneLedger(state) {
        const known = this.registry.servers;
        for (const server of [...state.revealed])
            if (!known.has(server))
                state.revealed.delete(server);
        state.truncated = state.truncated.filter((server) => known.has(server));
        state.pinnedMissing = [...state.pinned].filter((server) => !known.has(server)).sort();
    }
    // ------------------------------------------------------------------- tools
    pinTool(caller, server) {
        if (caller === undefined)
            throw new Error('mcp_pin requires an owning agent session');
        const entry = this.registry.servers.get(server);
        if (entry === undefined) {
            throw new Error(this.guidance(`unknown MCP server "${server}"`, [...this.registry.servers.keys()].sort()));
        }
        const state = this.stateFor(caller);
        state.pinned.add(server);
        // Explicit application to every live agent (rule 4: the downward snapshot
        // is creation-time only, so descendants must be re-evaluated).
        this.applyAll();
        const pins = this.pinsTool(caller);
        return { ...pins, ok: true, text: `已在当前会话常驻 "${server}"(${entry.names.size} 个工具)。\n${String(pins.text ?? '')}` };
    }
    /**
     * Servers pinned by a LIVE ANCESTOR and not by this agent itself.
     *
     * A subagent cannot release one of these: the pin is materialized from the
     * parent's session set, so `mcp_unpin` on the child would be a no-op that
     * looks like a failure. The pin tool reports the situation instead.
     */
    inheritedPins(state) {
        const out = new Set();
        const seen = new Set([state.id]);
        let cursor = state.parentId;
        while (cursor !== undefined && !seen.has(cursor)) {
            seen.add(cursor);
            const parent = this.states.get(cursor);
            if (parent === undefined)
                break;
            for (const server of parent.pinned)
                if (!state.pinned.has(server))
                    out.add(server);
            cursor = parent.parentId;
        }
        return [...out].sort();
    }
    unpinTool(caller, server) {
        if (caller === undefined)
            throw new Error('mcp_unpin requires an owning agent session');
        const state = this.stateFor(caller);
        const wasPinned = state.pinned.delete(server);
        const inherited = wasPinned ? false : this.inheritedPins(state).includes(server);
        this.applyAll();
        const pins = this.pinsTool(caller);
        const note = wasPinned
            ? `已收回 "${server}" 的常驻。`
            : inherited
                ? `本 agent 未持有 "${server}" 的常驻:该常驻属于父会话,插件会在父级与每个子代理上**分别物化**它(不是继承下来的),因此子代理无法在这里释放,它仍然可见。请由父级对它调用 mcp_unpin("${server}")。`
                : `"${server}" 本来就没有常驻(可能是本轮临时揭示,或本会话从未 pin 过)。`;
        return { ...pins, ok: true, text: `${note}\n${String(pins.text ?? '')}` };
    }
    /** Servers this agent can actually see: effective set ∩ live registry (V19). */
    visibleServers(state) {
        const known = this.registry.servers;
        return [...this.effectiveServers(state)].filter((server) => known.has(server)).sort();
    }
    pinsTool(caller) {
        if (caller === undefined)
            throw new Error('mcp_pins requires an owning agent session');
        const state = this.stateFor(caller);
        this.pruneLedger(state);
        const inherited = this.inheritedPins(state);
        const pinned = [...state.pinned].sort();
        const revealed = [...state.revealed].sort();
        const visible = this.visibleServers(state);
        const servers = [...this.registry.servers.keys()].sort();
        const text = [
            `已注册服务器:${servers.length > 0 ? servers.join(', ') : '(无)'}`,
            `本会话常驻:${pinned.length > 0 ? pinned.join(', ') : '(无)'}`,
            `本轮临时揭示:${revealed.length > 0 ? revealed.join(', ') : '(无)'}`,
            `继承自父级:${inherited.length > 0 ? inherited.join(', ') : '(无)'}`,
            `当前可见:${visible.length > 0 ? visible.join(', ') : '(无)'}`,
            `本轮截断(本 agent):${state.truncated.length > 0 ? state.truncated.join(', ') : '(无)'}`,
        ];
        if (state.pinnedMissing.length > 0) {
            text.push(`常驻但当前未注册(不生效,重连后自动恢复):${state.pinnedMissing.join(', ')}`);
        }
        return {
            ok: true,
            text: text.join('\n'),
            pinned,
            pinnedMissing: state.pinnedMissing,
            revealed,
            inherited,
            visible,
            truncated: [...state.truncated].sort(),
            servers,
        };
    }
    statusTool(caller) {
        const config = this.config;
        // §2.6.1 F5-①: the report is derived from the ACTUAL registrations, never
        // from the config value. `expected` is what the config asks for; anything
        // else is reported as a defect instead of being hidden behind a banner.
        this.refreshAgent(caller);
        const expected = this.wantedHelperNames();
        const servers = [...this.registry.servers.values()]
            .map((entry) => ({
            server: entry.server,
            label: config.servers[entry.server]?.label ?? null,
            tools: entry.names.size,
        }))
            .sort((left, right) => left.server.localeCompare(right.server));
        const agents = [...this.states.values()].map((state) => {
            this.pruneLedger(state);
            return {
                id: state.id,
                pinned: [...state.pinned].sort(),
                pinnedMissing: [...state.pinnedMissing],
                inherited: this.inheritedPins(state),
                revealed: [...state.revealed].sort(),
                truncated: [...state.truncated].sort(),
                visible: this.visibleServers(state),
                shadowedServers: [...state.shadows.keys()].sort(),
                helpers: [...state.helperNames].sort(),
                helperFailures: [...state.helperFailures].sort(),
                helperFailOpen: state.helperFailOpen,
                denyCount: state.denyNames.length,
            };
        });
        const helpersBroken = agents.filter((agent) => agent.helperFailures.length > 0 ||
            agent.helperFailOpen ||
            (expected.length > 0 && agent.helpers.length !== expected.length));
        const truncated = [...new Set(agents.flatMap((agent) => agent.truncated))].sort();
        const text = [
            `dsh-mcp-session 状态:policy=${config.defaultPolicy} keywordReveal=${config.keywordReveal} proxyTool=${config.proxyTool} catalog=${config.catalog}`,
            `配置:${configPath(this.userConfig)}`,
            expected.length === 0
                ? `助手工具未注册(proxyTool=false):${HELPER_TOOL_NAMES.join(' / ')} 全部未注册、不可派发;仅 per-agent deny、关键词自动揭示与目录段落生效。`
                : `助手工具注册状态(实际):${agents.map((a) => `${a.id}=[${a.helpers.join(',') || '无'}]`).join(' ') || '(无存活 agent)'};期望:${expected.join(', ')}`,
            helpersBroken.length > 0
                ? `⚠️ 助手工具注册异常(需排查):${helpersBroken
                    .map((a) => `${a.id}{缺失:${a.helperFailures.join(',') || '无'};实际:${a.helpers.join(',') || '无'}${a.helperFailOpen ? ';已对该 agent fail-open' : ''}}`)
                    .join(' ')}`
                : expected.length === 0
                    ? '助手工具按配置整体关闭(非异常)。'
                    : '助手工具注册正常(每个存活 agent 与期望一致)。',
            `已注册 MCP 服务器(${servers.length}):${servers.map((s) => `${s.server}(${s.tools})`).join(', ') || '(无)'}`,
            `存活 agent(${agents.length}):${agents.map((a) => `${a.id}[可见:${a.visible.join('/') || '-'};常驻:${a.pinned.join('/') || '-'}${a.pinnedMissing.length > 0 ? `(未注册:${a.pinnedMissing.join('/')})` : ''};本轮揭示:${a.revealed.join('/') || '-'}]`).join(' ')}`,
            `本轮截断(按 agent 归属;与各自该轮 assembly 同源,assembly 为权威):${agents.filter((a) => a.truncated.length > 0).map((a) => `${a.id} N=${a.truncated.length} → ${a.truncated.join(', ')}`).join(' | ') ||
                '(本会话所有 agent 本轮均无截断)'}`,
            `截断候选合计(全局并集,仅供概览,不代表某个 agent):${truncated.length > 0 ? `N=${truncated.length} → ${truncated.join(', ')}` : 'N=0'}`,
            this.failOpen ? '警告:restrict 曾失败,当前 fail-open(不隐藏任何工具),详见日志。' : 'restrict 正常。',
        ].join('\n');
        return {
            ok: true,
            text,
            policy: config.defaultPolicy,
            proxyTool: config.proxyTool,
            helperToolsExpected: expected,
            helperToolsActual: agents.map((agent) => ({ id: agent.id, helpers: agent.helpers })),
            helperToolsBroken: helpersBroken.map((agent) => ({
                id: agent.id,
                missing: agent.helperFailures,
                actual: agent.helpers,
                failOpen: agent.helperFailOpen,
            })),
            // §2.6.1 R3-1: attribution first (`truncatedByAgent`), the cross-agent
            // union second and explicitly labelled as an overview only.
            truncatedByAgent: agents.map((agent) => ({ id: agent.id, truncated: agent.truncated, count: agent.truncated.length })),
            truncated,
            truncatedCount: truncated.length,
            truncatedSemantics: 'truncatedByAgent is per-agent and shares its turn with the assembly; truncated is the labelled global union for overview',
            servers,
            agents,
            registryVersion: this.registry.version,
            failOpen: this.failOpen,
        };
    }
    async callTool(caller, server, tool, args, signal, callId) {
        const entry = this.registry.servers.get(server);
        if (entry === undefined) {
            throw new Error(this.guidance(`unknown MCP server "${server}"`, [...this.registry.servers.keys()].sort()));
        }
        const resolved = this.registry.resolve(server, tool);
        if (resolved === undefined) {
            throw new Error(this.guidance(`unknown tool "${tool}" on server "${server}"`, [...entry.names.keys()].sort()));
        }
        if (caller === undefined)
            throw new Error('mcp_call requires an owning agent session');
        const state = this.stateFor(caller);
        // Reveal first, then dispatch in the caller's own scope: the scoped
        // registration is what resolves the native name (and is exempt from any
        // ancestor restriction), so this is one direct call, not reveal + retry.
        state.revealed.add(server);
        this.applyVisibility(state);
        try {
            const result = await this.ctx.tools.execute({
                callId: `${callId}:mcp`,
                name: resolved.publicName,
                arguments: args ?? {},
                agent: caller,
                signal,
            });
            const text = blocksToText(result.content);
            if (result.isError === true) {
                throw new Error(`mcp_call("${server}","${resolved.publicName}") 失败:${text}`);
            }
            return {
                ok: true,
                server,
                tool: resolved.publicName,
                text: text.length > 0 ? text : '调用成功(无文本输出)。',
            };
        }
        catch (error) {
            if (error instanceof Error)
                throw error;
            throw new Error(`mcp_call("${server}","${resolved.publicName}") 抛出异常:${this.describe(error)}`);
        }
    }
    guidance(message, available) {
        return available.length > 0 ? `${message}\n可用:${available.join(', ')}` : `${message}\n当前没有已注册的服务器。`;
    }
    // ------------------------------------------------------------------ logging
    describe(error) {
        if (error instanceof Error)
            return `${error.name}: ${error.message}`;
        return String(error);
    }
    logError(scope, error) {
        const logger = this.ctx.logger;
        const message = `dsh-mcp-session: ${scope} failed — ${this.describe(error)}`;
        if (logger?.error !== undefined)
            logger.error(message);
        else
            console.error(message);
    }
    /** A user/model-visible signal for a state change worth knowing about. */
    logNotice(message) {
        const logger = this.ctx.logger;
        const text = `dsh-mcp-session: ${message}`;
        if (logger?.info !== undefined)
            logger.info(text);
        else
            console.info(text);
    }
}
//# sourceMappingURL=manager.js.map