// The Needs you state kept for the whole tab, one per chat (MoMo's main chat or a channel's), so a card closed on the Mac while another tab was open is still noted, in the chat it was raised in and nowhere else. A chat's cards are read only once its thread is there: while a chat loads (or after the phone switched to another one) its list is not "the Mac lists none", so nothing is taken for answered.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardData } from '../components/RequestCard';
import { emptyNeeds, reconcileNeeds, type Needs } from './needs';

export type AnsweredHere = { card: CardData; choice: string | undefined };

/**
 * @param cards the shown chat's cards once its thread is loaded, or null while it is not
 * @param chat the shown chat's key: 'momo' for the main chat, `momo:<channel id>` for a channel (momo/channelsContract.ts)
 */
export function useNeeds(cards: CardData[] | null, chat: string) {
  const answered = useRef(new Map<string, Set<string>>());
  /** The ids this phone answered in `key`'s chat. */
  const mineOf = useCallback((key: string) => {
    if (!answered.current.has(key)) answered.current.set(key, new Set());
    return answered.current.get(key) as Set<string>;
  }, []);
  const [byChat, setByChat] = useState<Record<string, Needs>>({});
  useEffect(() => {
    if (cards === null) return;
    setByChat((old) => ({ ...old, [chat]: reconcileNeeds(old[chat] ?? emptyNeeds, cards, mineOf(chat)) }));
  }, [cards, chat, mineOf]);
  const [here, setHere] = useState<Record<string, AnsweredHere[]>>({});
  /** This phone answered `card` with `choice` (the label): its receipt stays in the chat, as an ordinary chat keeps one. */
  const noteAnswered = useCallback(
    (card: CardData, choice: string | undefined) =>
      setHere((old) => ({ ...old, [chat]: [...(old[chat] ?? []), { card, choice }].slice(-5) })),
    [chat],
  );
  return {
    answeredOnMac: (byChat[chat] ?? emptyNeeds).answeredOnMac,
    answeredHere: here[chat] ?? [],
    noteAnswered,
    mine: { current: mineOf(chat) },
  };
}
