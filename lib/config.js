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
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** The harness home: `$DSH_HOME` when set, else `~/.dsh`. */
export function dshHomeDir() {
    const fromEnv = process.env.DSH_HOME;
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0)
        return fromEnv.trim();
    return join(homedir(), '.dsh');
}
/** Absolute path of the config file this plugin watches. */
export function configPath(user) {
    const dir = typeof user.configDir === 'string' && user.configDir.length > 0 ? user.configDir : dshHomeDir();
    return join(dir, 'mcp-session.json');
}
const fileCache = new Map();
/**
 * Read the JSON config file, reusing the last parse until its mtime changes.
 *
 * @param user - the row config (its `configDir` selects the file).
 * @returns the parsed object, or `{}` when the file is missing/unreadable.
 */
export function readConfigFile(user) {
    const path = configPath(user);
    try {
        const stats = statSync(path);
        const cached = fileCache.get(path);
        if (cached !== undefined && cached.mtimeMs === stats.mtimeMs)
            return cached.value;
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        const value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        fileCache.set(path, { mtimeMs: stats.mtimeMs, value });
        return value;
    }
    catch {
        fileCache.delete(path);
        return {};
    }
}
function pick(row, file, fallback) {
    if (row !== undefined)
        return row;
    if (file !== undefined)
        return file;
    return fallback;
}
/** Merge row config over file config over defaults. */
export function resolveConfig(user) {
    const file = readConfigFile(user);
    const rowScan = user.hintScan?.maxServers;
    const fileScan = file.hintScan?.maxServers;
    const rawMax = pick(rowScan, fileScan, 3);
    const maxRevealServers = Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : 3;
    const serverMap = pick(user.servers, file.servers, {});
    return {
        defaultPolicy: pick(user.defaultPolicy, file.defaultPolicy, 'lazy'),
        keywordReveal: pick(user.keywordReveal, file.keywordReveal, true),
        proxyTool: pick(user.proxyTool, file.proxyTool, true),
        catalog: pick(user.catalog, file.catalog, true),
        maxRevealServers,
        servers: serverMap !== null && typeof serverMap === 'object' ? serverMap : {},
        defaultPins: normaliseStringList(pick(user.pins, file.pins, {})?.default),
        pinsByWorkspace: normaliseWorkspacePins(pick(user.pins, file.pins, {})?.byWorkspace),
    };
}
function normaliseWorkspacePins(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return {};
    const out = {};
    for (const [workspace, pins] of Object.entries(value)) {
        const list = normaliseStringList(pins);
        if (workspace.length > 0 && list.length > 0)
            out[workspace] = list;
    }
    return out;
}
function normaliseStringList(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.length > 0);
}
//# sourceMappingURL=config.js.map