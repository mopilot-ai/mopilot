// Main's context snapshots (electron/context/contextService.cjs): one service per app, fed by every harness's events with or without a window, for its IPC (electron/app/ipc/context.cjs).
const path = require('node:path');
const { ContextService } = require('./contextService.cjs');
const { ContextStore } = require('./store.cjs');

/** @type {{ service: InstanceType<typeof ContextService>, store: InstanceType<typeof ContextStore> } | null} */
let current = null;

/**
 * Main's context service (electron/app/sessions.cjs): its file in userData, snapshots published to every window,
 * Claude Code's breakdown read through its session's control request.
 * @param {{ app: { getPath: (name: 'userData') => string }, broadcastAll: (channel: string, payload: unknown) => void,
 *   chatOf: (nativeId: string) => string,
 *   claude: { observe: (fn: (evt: any) => void) => unknown, turnApi: { control: (key: string, method: string, arg?: any) => Promise<unknown> } } }} o
 */
function openContextService({ app, broadcastAll, chatOf, claude }) {
  const store = new ContextStore({ file: () => path.join(app.getPath('userData'), 'context-snapshots.json') });
  const service = new ContextService({
    store,
    publish: (chatId, snapshot) => broadcastAll('context:snapshot', { chatId, snapshot }),
    chatOf,
    readers: { claude: (key, detail) => claude.turnApi.control(key, 'contextUsage', { detail }) },
  });
  claude.observe((evt) => service.claudeEvent(evt));
  current = { service, store };
  return current;
}

/** The service main opened, or null before that. */
const appContext = () => current;

module.exports = { openContextService, appContext };
