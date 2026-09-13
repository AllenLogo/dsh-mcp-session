import { SessionManager } from './manager.js';
/** Plugin name (must match the cordis insert row `name`). */
export const name = 'dsh-mcp-session';
/** Services this plugin needs before `apply` runs. */
export const inject = ['tools', 'systemPrompt', 'agents'];
/**
 * Mount the session manager.
 *
 * @param ctx - the plugin's (global) context.
 * @param config - the cordis insert row config; `$DSH_HOME/mcp-session.json`
 *   is merged underneath it.
 */
export function apply(ctx, config = {}) {
    new SessionManager(ctx, config).start();
}
//# sourceMappingURL=index.js.map