// The cards a Host waits on, as the phone shows them whichever path delivered them (X3): one card per (Host key, chat, request), its state from the Host's replies, never from a local guess. Pure; the wire is `host.pending`, `chat.answer` and the Host's refusals.
import { answeredLine, cardLine } from '../../../shared/host/directWords.mjs';

/** One card of `host.pending` (plan U1). */
export type HostCardWire = {
  chatId: string;
  epoch: number;
  requestId: string;
  turnId?: string;
  family?: string;
  cardKind: 'permission' | 'question' | 'link';
  summary: { tool: string; line: string; stat?: { files: number; added: number; removed: number } };
  options: { optionId: string; name: string; kind: 'allow' | 'deny' | 'other' }[];
  form?: unknown;
  at: number;
  /** The Host's reminder and pause times for this card (U1), when it sends them. */
  remindMs?: number;
  pauseMs?: number;
};

export type CardState =
  | { kind: 'waiting' }
  | { kind: 'sending'; optionId: string }
  | { kind: 'closed'; line: string }
  /** The Host could not be reached in time: the card stays and the same tap can be tried again. */
  | { kind: 'unreachable'; optionId: string };

export type ShownCard = {
  id: string;
  hostKey: string;
  card: HostCardWire;
  via: 'direct' | 'mac';
  state: CardState;
  /** Closed only because a read of the Host's list lacked it: the next list that has it opens it again (a read that began before the card did must not end it for good). */
  gone?: true;
  /** When it closed (ms): the machine page shows how it ended for a few seconds, then it leaves the Waiting list (its record is in the chat). */
  closedAt?: number;
};

/** The identity of a card: the same whichever path delivered it. */
export const cardId = (hostKey: string, chatId: string, requestId: string) => JSON.stringify([hostKey, chatId, requestId]);

/** What an answer's failure means for the card. The Host's refusal is shown as it is, never guessed. */
export function failureState(error: { code?: string; details?: { by?: { name?: string } } }, machine: string, optionId = ''): CardState {
  switch (error.code) {
    case 'card_answered':
      return { kind: 'closed', line: cardLine('lost', { device: error.details?.by?.name ?? null }) };
    case 'stale_epoch':
      return { kind: 'closed', line: cardLine('moved') };
    case 'timeout':
    case 'unreachable':
      return { kind: 'unreachable', optionId };
    default:
      return { kind: 'closed', line: cardLine('unreachable', { machine }) };
  }
}

/** How a card that was answered reads, by the option and who pressed it (null: this phone). */
export const answeredState = (kind: 'allow' | 'deny' | 'other', device: string | null): CardState => ({
  kind: 'closed',
  line: answeredLine(kind, device),
});

/** Why the Host closed a card (`permissionCancelled.reason`, plan U1). */
export function closedState(reason: string, answered?: { kind: 'allow' | 'deny' | 'other'; device: string | null }): CardState {
  if (reason === 'answered' && answered) return answeredState(answered.kind, answered.device);
  if (reason === 'expired') return { kind: 'closed', line: cardLine('expired') };
  if (reason === 'host_restarted') return { kind: 'closed', line: cardLine('restarted') };
  return { kind: 'closed', line: cardLine('cancelled') };
}

/** A card the Host reports as no longer waiting (`host.pending` `closed`): who answered it, when someone did. */
export type HostClosed = { chatId: string; requestId: string; by?: { name: string } };

/** How a card that left the Host's list ended: on another device, withdrawn, or (an older Host reports none) simply no longer waiting. */
export const endedLine = (how: HostClosed | undefined): string =>
  how?.by ? cardLine('lost', { device: how.by.name }) : how ? cardLine('cancelled') : cardLine('gone');

/**
 * The phone's view of every card of every Host. The latest `host.pending` of a Host replaces what that Host listed before; an answer in
 * flight is kept across it; a card the Host no longer lists turns to the line that says how it ended.
 */
export function createCardStore(now: () => number = Date.now) {
  const cards = new Map<string, ShownCard>();
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  return {
    /** The cards of a Host from `host.pending` (the Host's current set). Cards of the Mac's own path join through `mac`. */
    setPending(hostKey: string, listed: HostCardWire[], closed: HostClosed[] = []) {
      const seen = new Set<string>();
      for (const card of listed) {
        const id = cardId(hostKey, card.chatId, card.requestId);
        seen.add(id);
        const old = cards.get(id);
        // a card that is already open here is the same card: its state (an answer in flight) is kept
        cards.set(id, {
          id,
          hostKey,
          card,
          via: old?.via ?? 'direct',
          state: old && old.state.kind !== 'unreachable' && !old.gone ? old.state : { kind: 'waiting' },
        });
      }
      // a card the Host no longer lists was answered (on another device) or withdrawn: it turns to the line that says how, so its buttons go
      for (const [id, shown] of cards) {
        if (shown.hostKey !== hostKey || seen.has(id) || (shown.state.kind !== 'waiting' && shown.state.kind !== 'unreachable')) continue;
        const how = closed.find((c) => c.chatId === shown.card.chatId && c.requestId === shown.card.requestId);
        cards.set(id, { ...shown, state: { kind: 'closed', line: endedLine(how) }, gone: true, closedAt: now() });
      }
      changed();
    },
    /** A card that reached the phone through the Mac. A card the Host already listed stays the one card. */
    addMac(hostKey: string, card: HostCardWire) {
      const id = cardId(hostKey, card.chatId, card.requestId);
      if (!cards.has(id)) cards.set(id, { id, hostKey, card, via: 'mac', state: { kind: 'waiting' } });
      changed();
    },
    /** A tap: the pressed option shows progress and the others are disabled. */
    sending(id: string, optionId: string) {
      const shown = cards.get(id);
      if (shown && (shown.state.kind === 'waiting' || shown.state.kind === 'unreachable'))
        cards.set(id, { ...shown, state: { kind: 'sending', optionId } });
      changed();
    },
    /** The Host's reply to a tap, or its refusal. */
    settle(id: string, state: CardState) {
      const shown = cards.get(id);
      if (shown) cards.set(id, { ...shown, state, ...(state.kind === 'closed' ? { closedAt: now() } : {}) });
      changed();
    },
    /** The Host closed a card (by a reason it gave). */
    close(id: string, state: CardState) {
      this.settle(id, state);
    },
    list: (hostKey?: string) => [...cards.values()].filter((c) => !hostKey || c.hostKey === hostKey),
    /** How many cards of a Host wait for a person: the "2 waiting" of its line. */
    waiting: (hostKey: string) =>
      [...cards.values()].filter((c) => c.hostKey === hostKey && (c.state.kind === 'waiting' || c.state.kind === 'unreachable')).length,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}
