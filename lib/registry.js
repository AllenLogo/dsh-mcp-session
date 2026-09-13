/**
 * Split one public MCP tool name into its server namespace and raw tool name.
 *
 * @param name - a candidate tool name.
 * @returns the parsed pair, or `undefined` when the name is not `mcp__<s>__<t>`.
 */
export function parseMcpToolName(name) {
    if (!name.startsWith('mcp__'))
        return undefined;
    const rest = name.slice(5);
    const index = rest.indexOf('__');
    if (index <= 0 || index + 2 >= rest.length)
        return undefined;
    return { server: rest.slice(0, index), tool: rest.slice(index + 2) };
}
/** Live mirror of the global `mcp__*` tool surface. */
export class McpToolRegistry {
    /** Server namespace → its tools. */
    servers = new Map();
    names = [];
    definitions = new Map();
    generation = 0;
    /** Monotonic counter bumped on every accepted rescan. */
    get version() {
        return this.generation;
    }
    /** Every currently registered global `mcp__*` name, sorted. */
    allNames() {
        return this.names;
    }
    /**
     * Rescan the global tool surface.
     *
     * @param ctx - a context whose `tools` service reaches the global layer.
     * @returns whether anything changed (name set or a definition identity).
     */
    refresh(ctx) {
        let schemas;
        try {
            schemas = ctx.tools.schemas();
        }
        catch {
            return false;
        }
        const names = [];
        for (const schema of schemas) {
            if (typeof schema?.name === 'string' && schema.name.startsWith('mcp__'))
                names.push(schema.name);
        }
        names.sort();
        let changed = names.length !== this.names.length;
        if (!changed) {
            for (let index = 0; index < names.length; index += 1) {
                if (names[index] !== this.names[index]) {
                    changed = true;
                    break;
                }
            }
        }
        const fresh = new Map();
        for (const name of names) {
            const definition = ctx.tools.get(name);
            if (definition !== undefined)
                fresh.set(name, definition);
        }
        if (!changed) {
            for (const [name, definition] of fresh) {
                if (this.definitions.get(name) !== definition) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed)
            return false;
        this.names = names;
        this.definitions = fresh;
        this.servers.clear();
        for (const [name, definition] of fresh) {
            const parsed = parseMcpToolName(name);
            if (parsed === undefined)
                continue;
            let entry = this.servers.get(parsed.server);
            if (entry === undefined) {
                entry = { server: parsed.server, names: new Map() };
                this.servers.set(parsed.server, entry);
            }
            entry.names.set(parsed.tool, definition);
        }
        this.generation += 1;
        return true;
    }
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
    resolve(server, tool) {
        const entry = this.servers.get(server);
        if (entry === undefined)
            return undefined;
        if (tool.startsWith('mcp__')) {
            const parsed = parseMcpToolName(tool);
            if (parsed === undefined || parsed.server !== server)
                return undefined;
            const definition = entry.names.get(parsed.tool);
            return definition === undefined ? undefined : { publicName: tool, definition };
        }
        const definition = entry.names.get(tool);
        return definition === undefined ? undefined : { publicName: `mcp__${server}__${tool}`, definition };
    }
}
//# sourceMappingURL=registry.js.map