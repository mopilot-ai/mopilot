// Capture the Host's native side-chat parent and recognize the exact fork on a retry.
import { SIDE_CHAT_PARENT_CHANGED, SIDE_CHAT_PARENT_CHANGED_WORDS } from '../../shared/host/sideChats.mjs';
import { HostRefusal } from './hostFs.mjs';

/** @typedef {{ chatId: string, id: string, binding: string }} SideChatSource */
/** @typedef {ReturnType<InstanceType<typeof import('../../electron/session/controller.cjs').ChatController>['ref']>} NativeRef */

export const sideChatParentChanged = () => new HostRefusal(SIDE_CHAT_PARENT_CHANGED, SIDE_CHAT_PARENT_CHANGED_WORDS);

/** @param {{ records: Map<string, unknown> }} chats @param {{ ref: (id: string) => NativeRef }} controller */
export function sideChatParentOf(chats, controller) {
  return (/** @type {string} */ chatId) => {
    if (!chats.records.has(chatId)) return undefined;
    const parent = controller.ref(chatId);
    return {
      ...parent,
      current() {
        if (!chats.records.has(chatId)) return false;
        const next = controller.ref(chatId);
        return next.kind === parent.kind && next.id === parent.id && next.instance === parent.instance;
      },
    };
  };
}

/** @param {{ meta: { nativeSideFork?: string } }} record @param {SideChatSource | undefined} source */
export function isBoundSideFork(record, source) {
  if (!record.meta.nativeSideFork) return false;
  if (record.meta.nativeSideFork !== source?.binding) throw sideChatParentChanged();
  return true;
}
