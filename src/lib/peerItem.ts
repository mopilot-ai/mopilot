// The peer message a thread item came from, matched by its native item identity.

import type { PeerMessage } from '../../shared/peerMessages';

/** Presentation provenance comes from the main journal and native item identity, never prompt tags. */
export function peerForItem(messages: PeerMessage[], chatId: string, item: { id?: string; clientId?: string | null }) {
  return messages.find(
    (m) =>
      m.targetChatId === chatId &&
      ['submitting', 'delivered', 'uncertain'].includes(m.delivery) &&
      ((!!item.clientId && item.clientId === m.id) || (!!item.id && (item.id === m.targetItemId || item.id === m.id))),
  );
}
