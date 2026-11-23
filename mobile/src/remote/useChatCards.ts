// The cards a chat is waiting on, read by following the chat while a sheet is open: answered one at a time, each keeping a receipt of where it was answered. The sheet follows only for as long as it is open.
import { useEffect, useRef, useState } from 'react';
import type { MobileRuntime } from '../contracts';
import { answeredElsewhere } from '../../../shared/remote/cardAnswered.mjs';
import { cardKey, type CardData } from '../components/RequestCard';
import { followRequest } from '../presentation/follow';
import { choiceLabel, type Receipt } from '../presentation/receipts';
import { snapshot, update, type Data, type Thread } from '../presentation/thread';
import { lostInFlight } from './unconfirmed';

/** Events that arrive before the chat is read are kept up to this many, then the read is given up. */
const MAX_BUFFERED = 200;

export type CardReceipt = Receipt & { card: CardData };

export function useChatCards(runtime: MobileRuntime, chatId: string) {
  const [thread, setThread] = useState<Thread | null>(null);
  /** The chat could not be read, or its live updates could not be applied: reading it again is the way on. */
  const [error, setError] = useState<string | null>(null);
  /** An answer was refused: the card stays answerable, and reading the chat again is no help. */
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, CardReceipt>>({});
  /** An answer was in flight as the connection went: the Mac may have taken it. */
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    void attempt;
    let active = true;
    let loaded = false;
    const pending: Data[] = [];
    setThread(null);
    setError(null);
    setUnconfirmed(false);
    const off = runtime.onEvent((event) => {
      if (event.chatId !== chatId || !active) return;
      if (!loaded) {
        if (pending.length < MAX_BUFFERED) pending.push(event);
        return;
      }
      setThread((old) => {
        try {
          return old && update(old, event);
        } catch (e: unknown) {
          setError((e as Error).message);
          return old;
        }
      });
    });
    followRequest(runtime, chatId, 'chat.follow')
      .then((result) => {
        if (!active) return;
        let value = snapshot(result);
        for (const event of pending) value = update(value, event);
        loaded = true;
        setThread(value);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
      off();
      void followRequest(runtime, chatId, 'chat.unfollow').catch(() => {
        /* Cleanup is best effort after the sheet is closed. */
      });
    };
  }, [runtime, chatId, attempt]);

  const cards: CardData[] = Array.isArray(thread?.session.cards) ? (thread.session.cards as CardData[]) : [];
  // a card the Mac took down after it was answered stays, as its receipt, until the sheet moves on
  const shown = [
    ...cards,
    ...Object.values(receipts)
      .map((r) => r.card)
      .filter((c) => !cards.some((up) => cardKey(up) === cardKey(c))),
  ];

  async function answer(card: CardData, key: string, values?: Data) {
    setAnswerError(null);
    setUnconfirmed(false);
    try {
      await runtime.request('card.answer', { chatId, cardId: card.id, rev: card.rev, key, values });
    } catch (e: unknown) {
      if (!mounted.current) return false;
      if (answeredElsewhere(e)) setReceipts((old) => ({ ...old, [cardKey(card)]: { by: 'mac', card } }));
      else if (lostInFlight(e)) setUnconfirmed(true);
      else setAnswerError(e instanceof Error ? e.message : String(e));
      return false;
    }
    if (mounted.current) {
      const choice = choiceLabel(card, key);
      setReceipts((old) => ({ ...old, [cardKey(card)]: { by: 'phone', choice, card } }));
    }
    return true;
  }
  return {
    loaded: thread !== null,
    cards: shown,
    receipts,
    /** Cards still waiting for an answer. */
    waiting: shown.filter((c) => !(cardKey(c) in receipts)).length,
    error,
    answerError,
    unconfirmed,
    answer,
    reload: () => setAttempt((n) => n + 1),
  };
}
