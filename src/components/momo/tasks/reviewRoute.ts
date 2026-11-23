// Where Review on a card opens (A2, #4846): the chat the card waits in, so a card raised in a channel is answered in that channel and not in Main.
import type { Route } from '../../../../shared/model/window';

/** Main's page for main's cards; a channel's own chat (the Mac knows its id) for a channel's. */
export function reviewRoute(task: { channel?: { id: string } | null; chatId?: string | null }): Route {
  return task.channel && task.chatId ? { name: 'momo', tab: 'chat', chatId: task.chatId } : { name: 'momo', tab: 'chat' };
}
