// Resolve a tapped notification's opaque ref to the chat it names, using only what this phone can recompute locally.
import { chatRef } from './chatRef';
import type { PushPayload } from './payload';

/** `momo` opens MoMo (at `card` while it is up, in `channel` when the card waits in one of its channels) instead of a chat. */
export type Target = {
  pairId: string;
  chatId?: string;
  draft?: string;
  momo?: { card?: string; channel?: string };
  host?: { requestId?: string };
};

/** A card waiting on a Host, as the phone's own Host client lists it (host.pending). */
export type HostCard = { chatId: string; requestId: string };

export interface Locator {
  pairs: string[];
  /** Connect to the computer of `pairId` and list the ids of its recent chats, reading further pages until `found` says the ids read so far hold what is wanted. */
  chatIds(pairId: string, found: (ids: string[]) => boolean): Promise<string[]>;
  /** The ids of MoMo's open channels on `pairId` (empty while channels are off or the Mac has none); a channel's card push names its channel by chatRef of that id. */
  channelIds?(pairId: string): Promise<string[]>;
  /** Host enrollments this phone holds (pair ids), searched before the Mac's chat lists; a push from a Host carries chatRef(enrollment pair, chat). */
  hostPairs?: string[];
  /** The cards waiting on that Host; may throw when the Host is unreachable. */
  hostCards?(pairId: string): Promise<HostCard[]>;
  /** False once a newer tap or a sign-out has replaced this one. */
  current(): boolean;
}

/**
 * `machineOffline` carries the pair id itself. Any other kind carries chatRef(pair, chat), which no relay can invert, so each paired
 * computer's chat list is searched in turn until a handle matches. A computer that is offline is skipped, not fatal. null means the
 * app opens its home screen.
 */
export async function locateTarget(payload: PushPayload, l: Locator): Promise<Target | null> {
  if (payload.kind === 'machineOffline') return l.pairs.includes(payload.ref) ? { pairId: payload.ref } : null;
  // a push from a Host names a waiting card: open it on that Host's pair, at the card the sealed blob named when it did
  for (const pairId of l.hostPairs ?? []) {
    let cards: HostCard[];
    try {
      cards = (await l.hostCards?.(pairId)) ?? [];
    } catch {
      continue;
    }
    if (!l.current()) return null;
    const hit = cards.filter((c) => chatRef(pairId, c.chatId) === payload.ref);
    if (hit.length) {
      const asked = payload.requestId ? hit.find((c) => c.requestId === payload.requestId) : undefined;
      return { pairId, chatId: hit[0].chatId, host: { requestId: (asked ?? hit[0]).requestId } };
    }
  }
  // a channel's card: its push names the channel by the handle of the channel's id, which this phone knows from the list it keeps; a phone never knows a chat id of MoMo's
  if (payload.kind === 'momoNeedsYou') {
    for (const pairId of l.pairs) {
      let channels: string[];
      try {
        channels = (await l.channelIds?.(pairId)) ?? [];
      } catch {
        continue;
      }
      if (!l.current()) return null;
      const channel = channels.find((id) => chatRef(pairId, id) === payload.ref);
      if (channel) return momoTarget(payload, pairId, channel);
    }
  }
  for (const pairId of l.pairs) {
    let ids: string[];
    try {
      ids = await l.chatIds(pairId, (read) => read.some((id) => chatRef(pairId, id) === payload.ref));
    } catch {
      continue;
    }
    if (!l.current()) return null;
    const chatId = ids.find((id) => chatRef(pairId, id) === payload.ref);
    if (chatId) return momoTarget(payload, pairId) ?? { pairId, chatId };
  }
  // MoMo's main chat is not in the chat list: its push opens MoMo on the first paired computer (MoMo runs on one Mac)
  return payload.kind === 'momoNeedsYou' && l.pairs.length ? momoTarget(payload, l.pairs[0]) : null;
}

/** A MoMo needs-you push opens MoMo itself, at its card while that card is up. */
const momoTarget = (payload: PushPayload, pairId: string, channel?: string): Target | null =>
  payload.kind === 'momoNeedsYou'
    ? { pairId, momo: { ...(payload.card ? { card: payload.card } : {}), ...(channel ? { channel } : {}) } }
    : null;
