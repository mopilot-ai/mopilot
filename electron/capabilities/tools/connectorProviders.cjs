// What each harness family does with its MCP servers for connectorTools.cjs: Claude Code through its live session's SDK
// calls (status, toggle, reconnect: this session only), Codex through the app-server (status list, config.toml's
// mcp_servers.<name>.enabled and a reload: shared by every Codex chat) and a basic (ACP) harness through the user's own
// server list, which MoPilot turns on and off for its chats (prefs acpMcp; a running process restarts when idle).
const { ToolError } = require('../contract/registry.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');

const CLAUDE_STATUS = { connected: 'connected', 'needs-auth': 'needs_auth', failed: 'failed', pending: 'pending', disabled: 'disabled' };
const CODEX_STATUS = {
  connected: 'connected',
  starting: 'pending',
  notStarted: 'pending',
  authenticationRequired: 'needs_auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled',
};

/** A control request that found no process for the chat answers null. */
const notRunning = () => new ToolError("This session's agent isn't running, so its connectors can't be reached.", 'unavailable');

/**
 * Claude Code: the live session's servers; a change is this session's only.
 * @param {{ control: (chatId: string, method: string, arg?: unknown) => Promise<unknown> }} o `control` is the chat's CLI control request
 * @returns {import('./connectorTools.cjs').ConnectorProvider}
 */
function claudeProvider({ control }) {
  return {
    async status(chatId) {
      const rows = await control(chatId, 'mcpStatus');
      if (!Array.isArray(rows)) throw notRunning();
      return {
        scope: 'this session',
        connectors: rows.map((m) => {
          const status = CLAUDE_STATUS[m.status] ?? 'pending';
          return {
            name: String(m.name),
            status,
            enabled: status !== 'disabled',
            ...(Array.isArray(m.tools) ? { tool_count: m.tools.length } : {}),
          };
        }),
      };
    },
    async setEnabled(chatId, _kind, name, enabled) {
      if ((await control(chatId, 'toggleMcp', { name, enabled })) === null) throw notRunning();

      return { said: 'Done for this session. New sessions keep their own settings.' };
    },
    async reconnect(chatId, _kind, name) {
      if ((await control(chatId, 'reconnectMcp', { name })) === null) throw notRunning();
      return { said: 'Reconnecting. Check session_connectors_status in a moment.' };
    },
  };
}

/**
 * Codex: the app-server's servers; a change is written to config.toml, so it is shared by every Codex chat.
 * @param {{ request: (method: string, params: unknown) => Promise<any> }} o
 * @returns {import('./connectorTools.cjs').ConnectorProvider}
 */
function codexProvider({ request }) {
  const reload = () => request('config/mcpServer/reload', undefined);
  return {
    async status() {
      // config.toml says which are turned off; a disabled server may report no runtime state at all
      const [live, config] = await Promise.allSettled([
        request('mcpServerStatus/list', {}),
        request('config/read', { includeLayers: false }),
      ]);
      if (live.status === 'rejected') throw live.reason;
      const rows = live.value?.data ?? [];
      const off = (name) => (config.status === 'fulfilled' ? config.value?.config?.mcp_servers?.[name]?.enabled === false : false);
      return {
        scope: 'every chat on this harness',
        connectors: rows.map((m) => {
          const status = off(m.name)
            ? 'disabled'
            : (CODEX_STATUS[m.runtimeStatus] ?? (m.authStatus === 'notLoggedIn' ? 'needs_auth' : 'pending'));
          return { name: String(m.name), status, enabled: status !== 'disabled', tool_count: Object.keys(m.tools ?? {}).length };
        }),
      };
    },
    async setEnabled(_chatId, _kind, name, enabled) {
      await request('config/value/write', {
        keyPath: `mcp_servers.${JSON.stringify(name)}.enabled`,
        value: enabled,
        mergeStrategy: 'replace',
      });
      await reload();
      return { said: 'Saved in this harness’s config, so every chat on it has it now.' };
    },
    async reconnect() {
      await reload();
      return { said: 'Asked this harness to reload its MCP servers (all of them). Check session_connectors_status in a moment.' };
    },
  };
}

/**
 * A basic harness: the servers in its own settings and which of them MoPilot's chats on it load. It reports no
 * live state and can't reconnect one.
 * @param {{ status: (harness: string) => { supported: boolean, load: boolean, servers: { name: string, off: boolean }[] },
 *           prefs: () => any, patchPrefs: (set: Record<string, unknown>) => boolean }} o
 * @returns {import('./connectorTools.cjs').ConnectorProvider}
 */
function acpProvider({ status, prefs, patchPrefs }) {
  const harness = (kind) => parseKind(kind)?.basic ?? '';
  return {
    async status(_chatId, kind) {
      const s = status(harness(kind));
      if (!s.supported) throw new ToolError("MoPilot can't list this harness's MCP servers.", 'unavailable');
      return {
        scope: 'MoPilot’s chats on this harness',
        connectors: s.servers.map((m) => ({ name: m.name, status: m.off ? 'disabled' : 'unknown', enabled: !m.off })),
      };
    },
    async setEnabled(_chatId, kind, name, enabled) {
      const h = harness(kind);
      const s = status(h);
      // a harness whose servers all load keeps no list; one that loads none has them all off
      const off = new Set(s.servers.filter((m) => m.off).map((m) => m.name));
      if (enabled) off.delete(name);
      else off.add(name);
      if (!patchPrefs({ acpMcp: { ...prefs()?.acpMcp, [h]: { load: true, off: [...off].sort() } } }))
        throw new ToolError("Couldn't save the choice", 'save_failed');
      return { said: 'Saved. The harness restarts to read it once its chats are idle; this session keeps its servers until then.' };
    },
  };
}

module.exports = { claudeProvider, codexProvider, acpProvider };
