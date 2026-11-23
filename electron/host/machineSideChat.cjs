// Prepare a temporary machine chat using the completed ownership and agent binding of its stable parent chat.
const { randomUUID } = require('node:crypto');
const { agentOfKind, appIdPrefix } = require('../../shared/host/chatIds.mjs');
const { SIDE_CHAT_MARKER } = require('../../shared/host/sideChats.mjs');
const { saveMeta } = require('../../shared/metaSave.mjs');
const { hostPermissionOf, isHostPermission } = require('../../shared/host/permissions.mjs');
const { LOCAL_HOST_ID } = require('./ownership.cjs');

/**
 * @param {{ ownerOf: (id: string) => import('./ownership.cjs').OwnershipRecord, kindOf: (id: string) => string | undefined,
 *   row: (id: string) => { hostKey?: string } | undefined, start: ReturnType<typeof import('./machineChatStart.cjs').createMachineChatStart>['start'],
 *   active: Map<string, { sourceId: string, windowId?: number }>, retire: () => void, live: () => any }} o
 */
function machineSideChat({ ownerOf, kindOf, row, start, active, retire, live }) {
  return async (/** @type {unknown} */ sourceId, /** @type {unknown} */ restoring, /** @type {number | undefined} */ windowId) => {
    if (typeof sourceId !== 'string' || !sourceId) throw new Error('The parent chat is unavailable.');
    if (restoring !== undefined) {
      const binding = typeof restoring === 'string' ? active.get(restoring) : undefined;
      if (typeof restoring !== 'string' || !binding || binding.sourceId !== sourceId || binding.windowId !== windowId) return null;
      const { hostId, ownerHostId, folder } = ownerOf(restoring);
      if (hostId === LOCAL_HOST_ID || hostId !== ownerHostId || !folder) return null;
      const config = live().chats?.get(restoring)?.meta?.config ?? {};
      return { chatId: restoring, hostId, cwd: folder, config };
    }
    const { hostId, ownerHostId, epoch, folder } = ownerOf(sourceId);
    if (hostId === LOCAL_HOST_ID && ownerHostId === LOCAL_HOST_ID) return null;
    if (hostId !== ownerHostId || !folder)
      throw new Error('The parent chat’s folder or machine is unavailable. Try again when it reconnects.');
    const harness = agentOfKind(kindOf(sourceId));
    if (!harness) throw new Error('The machine has not reported the agent for this chat yet. Try again.');
    const chatId = `${appIdPrefix(harness)}${SIDE_CHAT_MARKER}${randomUUID()}`;
    active.set(chatId, { sourceId, windowId });
    try {
      await start({ chatId, hostId, folder, harness, scope: row(hostId)?.hostKey, sideChat: { sourceId, epoch } });
      const current = ownerOf(sourceId);
      if (
        !active.has(chatId) ||
        current.hostId !== hostId ||
        current.ownerHostId !== hostId ||
        current.epoch !== epoch ||
        current.folder !== folder ||
        agentOfKind(kindOf(sourceId)) !== harness
      )
        throw new Error('The parent chat changed. Open a new side chat from it.');
      const { chats, controller } = live();
      const config = chats?.get(sourceId)?.meta?.config;
      const mode = controller?.state?.get(sourceId)?.permission;
      const permission = hostPermissionOf(config?.hostPermission, hostId, harness) ?? (isHostPermission(mode) ? mode : null);
      const model = config?.hostSelection;
      const ownConfig = {
        ...(permission ? { hostPermission: { hostId, harness, value: permission } } : {}),
        ...(model?.hostId === hostId && model?.harness === harness ? { hostSelection: model } : {}),
      };
      // This is the child's request for its first send. Only the Host reports its running mode.
      if (Object.keys(ownConfig).length && !saveMeta(chats, chatId, { config: ownConfig }))
        throw new Error('Could not save the side chat’s settings. Try again.');
      return { chatId, hostId, cwd: folder, config: ownConfig };
    } catch (error) {
      active.delete(chatId);
      retire();
      throw error;
    }
  };
}

module.exports = { machineSideChat };
