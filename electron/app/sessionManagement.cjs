// Registers the session-management tools (capabilities/tools/sessionRead.cjs, sessionControl.cjs) on the registry every
// harness's tool channel serves, over the session host that reads and changes chats through their own adapters, and
// installs Auto model routing (autoRouteWiring.cjs) on the same chats.
const os = require('node:os');
const path = require('node:path');
const { registerSessionReadTools } = require('../capabilities/tools/sessionRead.cjs');
const { registerSessionControlTools } = require('../capabilities/tools/sessionControl.cjs');
const { ProjectsStore } = require('../platform/projects.cjs');
const { appContext } = require('../context/index.cjs');
const { createSessionHost } = require('./sessionHost.cjs');
const { installAutoRoute } = require('./autoRouteWiring.cjs');

/**
 * @param {any} live main's late-bound services (capabilities, chats, controller, harness adapters)
 * @param {{ orchestrator: any, owner: (ctx: any) => string | null, prefs: () => any, projectOf: (chatId: string) => Promise<string | null>,
 *   worktreeInfo: (dir: string) => any, userData: string, broadcastAll: (channel: string, payload: unknown) => void }} o
 * @returns {() => void} removes the tools
 */
function registerSessionManagement(live, { orchestrator, owner, prefs, projectOf, worktreeInfo, userData, broadcastAll }) {
  const host = createSessionHost({
    live,
    orchestrator,
    prefs,
    projectOf,
    worktreeInfo,
    projects: () => new ProjectsStore(path.join(userData, 'projects.json')).list().projects,
    downloads: () => path.join(os.homedir(), 'Downloads'),
    changed: (id) => broadcastAll('chats:changed', { id, chat: live.chats.get(id) }),
    context: appContext,
  });
  // a phone renames and restores chats through it too (app/phoneChatOps.cjs)
  live.sessionHost = host;
  // Auto model routing on every chat's turns, by the same settings the tools change
  live.autoRoute ??= installAutoRoute(live, {
    orchestrator,
    prefs,
    userData,
    changed: (id) => broadcastAll('chats:changed', { id, chat: live.chats.get(id) }),
  });
  const disposers = [
    registerSessionReadTools(live.capabilities, { orchestrator, owner, host }),
    registerSessionControlTools(live.capabilities, { orchestrator, owner, host }),
  ];
  return () => disposers.forEach((dispose) => dispose());
}

module.exports = { registerSessionManagement };
