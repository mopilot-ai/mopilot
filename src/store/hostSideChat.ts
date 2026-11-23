// Open a temporary chat on the parent chat's machine and make its remote owner known to the composer.
import { native } from '../lib/native';
import { noteHostChat } from '../lib/hostChats';
import { acpThread } from '../harness/acpSessions';
import { ignoring } from '../lib/ignored';
import { get } from './core';
import { setChatConfig } from './projects';
import { deletionVisibility } from './deletionVisibility';
import { sessionOf } from './session/useSession';
import { SIDE_CHAT_PARENT_CHANGED, sideChatUuid } from '../../shared/host/sideChats.mjs';

const blocked = new Set<string>();

/** Keep a terminal start refusal when the queue row goes back into a draft. */
export function rememberSideChatBlock(chatId: string) {
  if (
    sideChatUuid(chatId) &&
    sessionOf(chatId).queue.some((item) => {
      const code = item.refusal?.code;
      return code === SIDE_CHAT_PARENT_CHANGED || code === 'request_interrupted';
    })
  )
    blocked.add(chatId);
}

/** Leave a refused draft in its pane, while the parent action can open a fresh child. */
export function canReuseHostSideChat(chatId: string) {
  rememberSideChatBlock(chatId);
  return !blocked.has(chatId);
}

export async function openHostSideChat(chatId: string, restoring?: string) {
  const projectId = get().threads[chatId]?.projectId ?? null;
  const opened = await (restoring ? native.host?.openSideChat?.(chatId, restoring) : native.host?.openSideChat?.(chatId));
  const discard = () => {
    if (opened && !restoring) void native.chats.delete(opened.chatId).catch(ignoring('retire the unshown side chat'));
  };
  if (deletionVisibility.has(chatId)) {
    discard();
    throw new Error('The parent chat is no longer available.');
  }
  if (!opened) return null;
  const { chatId: id, hostId, cwd, config } = opened;
  const now = Date.now();
  return {
    thread: { ...acpThread({ id, cwd, createdAt: now, updatedAt: now }), projectId, ephemeral: true },
    publish: () => {
      noteHostChat(id, hostId);
      setChatConfig(id, config);
    },
    discard,
  };
}
