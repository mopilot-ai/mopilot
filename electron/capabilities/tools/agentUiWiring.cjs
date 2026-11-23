// The agent tools that change what the user sees and uses, on the sage_* server for every harness: sidebar writes
// (pins, unread, sections), settings, connectors and the MCP registry search. Main owns each write (chat meta and prefs
// through the same stores and broadcasts the windows use); a change the user should decide asks in a consent card.
const path = require('node:path');
const { ProjectsStore } = require('../../platform/projects.cjs');
const { ownerOf } = require('../../platform/segmentOwner.cjs');
const { registerSidebarTools } = require('./sidebarTools.cjs');
const { registerSettingsTools } = require('./settingsTools.cjs');
const { registerConnectorTools } = require('./connectorTools.cjs');
const { claudeProvider, codexProvider, acpProvider } = require('./connectorProviders.cjs');
const { registerMcpRegistryTool } = require('./mcpRegistry.cjs');

/**
 * @param {unknown} _ipcMain
 * @param {any} deps the shared IPC dependencies (see main.cjs)
 */
function register(_ipcMain, deps) {
  const { live, app } = deps;
  if (!live.capabilities) return;
  const owner = (ctx) => ownerOf(live.chats?.records, ctx);
  const prefs = () => deps.readState?.()?.prefs ?? {};
  // late-bound: the chats' IPC sets the prefs writer once it is up
  const patchPrefs = (set) => live.patchPrefs?.(set) === true;
  /** The user's answer to a consent card in the calling chat; no card broker (nothing to ask with) is a no. */
  const ask = async (chatId, summary, signal) => {
    const broker = live.computerUse?.broker;
    if (!broker) return false;
    return (await broker.ask(chatId, 'consent', { harness: live.controller.ref(chatId).kind, summary }, { signal }))?.decision === 'allow';
  };
  const file = path.join(app.getPath('userData'), 'projects.json');
  registerSidebarTools(live.capabilities, {
    owner,
    records: () => live.chats.records,
    patchMeta: (id, patch) => {
      // patchMeta-changes: false is reported to the model as 'changed: false', not an error
      const changed = live.chats.patchMeta(id, patch);
      // every window, the asking one too, hears the chat as main saved it
      if (changed) deps.broadcastExcept('chats:changed', null, { id, chat: live.chats.get(id) });
      return changed;
    },
    prefs,
    patchPrefs,
    projects: () => new ProjectsStore(file).list().projects,
    ask,
  });
  registerSettingsTools(live.capabilities, { owner, prefs, patchPrefs, ask });
  const kindOf = (chatId) => live.controller?.ref(chatId)?.kind ?? null;
  registerConnectorTools(live.capabilities, {
    owner,
    kindOf,
    ask,
    providers: {
      claude: claudeProvider({
        control: (chatId, method, arg) => deps.claude.turnApi.control(live.controller.ref(chatId).key, method, arg),
      }),
      codex: codexProvider({ request: (method, params) => live.codex.request(method, params) }),
      acp: acpProvider({ status: (harness) => live.acpOwnMcp.status(harness), prefs, patchPrefs }),
    },
  });
  registerMcpRegistryTool(live.capabilities, { owner });
}

module.exports = { register };
