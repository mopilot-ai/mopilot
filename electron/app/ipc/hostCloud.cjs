// IPC for which chats run where and for cloud machines (Remote Run X6), registered by ipc/host.cjs (`registeredBy`): the owner of a chat and the chats on machines, then the provider key, the sheet's choices and the create, cancel, wake, stop and delete calls, each refused by the service while `host.cloud` is off. A reply never carries the provider key. The cloud service is made on first use from the machines service (its rows and a boot of its own per creation).
const path = require('node:path');
const { isEnabled } = require('../../platform/flags.cjs');
const { chatOwner } = require('../../host/machines.cjs');
const { remoteChatOwners } = require('../../host/ownedChats.cjs');
const { createCloudService } = require('../../host/cloudService.cjs');

/**
 * @param {object} o
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle the Host IPC's own handler (gate, error shape)
 * @param {{ handle: (channel: string, fn: (e: unknown, ...args: any[]) => unknown) => void }} o.ipcMain
 * @param {() => any} o.service the machines service
 * @param {() => any} o.deps the app's services (userData, windows); none before the app is up
 * @param {() => boolean} o.allowed Host's closed-alpha gate
 * @param {() => any} o.safeStorage the encryption for the provider key, read when the service is made
 * @param {() => boolean} [o.enabled] `host.cloud`
 * @param {(hostId: string, chatId: string) => Promise<void>} [o.carry] pushes a chat's unpushed work off the machine; none: Delete refuses a request to push
 */
function registerHostCloud({ handle, ipcMain, service, deps, allowed, safeStorage, enabled = () => isEnabled('host.cloud'), carry }) {
  const dir = deps()?.app.getPath('userData') ?? '';
  const ownerOf = chatOwner({ dir, allowed });
  ipcMain.handle('host:owner', (_e, chatId) => ownerOf(chatId));
  const owners = remoteChatOwners({ dir, allowed });
  ipcMain.handle('host:remoteChats', () => owners());

  /** @type {ReturnType<typeof createCloudService> | null} */
  let made = null;
  const cloud = () =>
    (made ??= createCloudService({
      dir: path.resolve(dir),
      safeStorage: safeStorage() ?? require('electron').safeStorage,
      enabled,
      registry: { list: () => service().list().machines },
      makeBoot: ({ onView }) => service().boot.fork(onView),
      chatsOn: (hostId) =>
        owners()
          .filter((o) => o.hostId === hostId)
          .map((o) => ({ chatId: o.chatId, title: o.chatId, folder: null })),
      carry,
      onEvent: (event) => deps()?.broadcastAll('host:cloud', event),
    }));
  handle('host:cloudProviders', () => cloud().providers());
  handle('host:cloudSetKey', (provider, credential) => cloud().setKey(String(provider), credential));
  handle('host:cloudRemoveKey', (provider) => cloud().removeKey(String(provider)));
  handle('host:cloudCheck', (provider, region) => cloud().check(String(provider), String(region)));
  handle('host:cloudOptions', (provider, region) => cloud().options(String(provider), String(region)));
  handle('host:cloudLaunch', (spec) => cloud().launch(spec));
  handle('host:cloudCancel', (launch) => cloud().cancel(String(launch)));
  handle('host:cloudWake', (id) => cloud().wake(String(id)));
  handle('host:cloudStop', (id) => cloud().stopNow(String(id)));
  handle('host:cloudPlan', (id) => cloud().plan(String(id)));
  handle('host:cloudDelete', (id, o) => cloud().remove(String(id), o));
  handle('host:cloudLine', (id) => cloud().line(String(id)));
  return {
    /** A message waits for a machine that looks offline: a stopped cloud machine is woken. @param {string} hostId */
    wake: (/** @type {string} */ hostId) => cloud().wake(hostId),
    /** Why a chat's source may still run, or null (a cloud machine is lost only when its provider says it is gone). @param {string} hostId */
    lostCheck: (/** @type {string} */ hostId) => cloud().lostCheck(hostId),
  };
}

module.exports = { registerHostCloud, registeredBy: 'host' };
