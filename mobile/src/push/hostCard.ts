// Open the sealed card blob of a push from a Host: the phone's side of shared/remote/cardPush.mjs, giving the lock-screen text and the card's request id, or null so the fixed title stays.
import { cardText, type createCardPush } from '../../../shared/remote/cardPush.mjs';
import type { PushPayload } from './payload';

export interface HostPushText {
  requestId: string;
  rev: number;
  title: string;
  body: string;
  state: string | undefined;
  tool: string | undefined;
}

/**
 * @param cards the card codec built on the phone's primitive set
 * @param keys one card key per Host enrollment (derived from each pair root); the tag decides which fits
 */
export function openHostPush(payload: PushPayload, cards: ReturnType<typeof createCardPush>, keys: Uint8Array[]): HostPushText | null {
  if (!payload.sealedTitle || (payload.kind !== 'needsYou' && payload.kind !== 'done')) return null;
  const opened = cards.open({ sealed: payload.sealedTitle, ref: payload.ref, keys });
  if (!opened) return null;
  return { requestId: opened.requestId, rev: opened.rev, ...cardText(opened.card), state: opened.card.state, tool: opened.card.tool };
}
