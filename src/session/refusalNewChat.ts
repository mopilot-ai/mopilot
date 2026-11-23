// "New chat on <machine>": a refused message carried to a fresh chat in the same folder, on the same machine and agent, for a chat the machine no longer has or cannot read back.
import type { QueuedMessage } from '../../shared/model/session';

type Refusal = NonNullable<QueuedMessage['refusal']>;
/** The message to carry and where it was queued. */
export type RefusedMessage = { chatId: string; text: string; attachments: QueuedMessage['attachments'] };

/**
 * Starts the chat and puts the message in its composer, unsent: the person sees it before it goes. False when no chat was started (the machine or folder could not take one, which has been told).
 * Imported on use: the store reaches the queue through this file's callers.
 */
export async function newChatWithMessage(r: Refusal, m: RefusedMessage, folder?: string): Promise<boolean> {
  const [{ get, setDraft }, { createHostChatThread }] = await Promise.all([import('../store/core'), import('../store/send')]);
  // the chat's own folder on the machine; none known is told by the creator ("Pick a folder on <machine>")
  const path = folder ?? get().threads[m.chatId]?.cwd ?? '';
  const id = await createHostChatThread({ id: r.hostId, name: r.machine, path, ...(r.agent ? { agent: r.agent } : {}) });
  if (!id) return false;
  setDraft(id, { text: m.text, attachments: m.attachments });
  return true;
}
