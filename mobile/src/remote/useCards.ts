// A chat's cards as the phone keeps them: the ones up, the ones answered here or elsewhere (with receipts until the next send), closed plan sheets, and what the composer is asked for next.
import { useCallback, useRef, useState } from 'react';
import { answeredElsewhere } from '../../../shared/remote/cardAnswered.mjs';
import { asksForChanges, cardKey, type CardData } from '../components/RequestCard';
import { choiceLabel, type Receipt } from '../presentation/receipts';
import type { Data } from '../presentation/thread';

/** What the composer is asked for after an answer: what to change in a plan, or what to do instead of a refused approval. */
export type Feedback = 'plan' | 'comment' | null;

/** `answer` sends one answer and resolves whether the Mac took it; `handled` sees a refusal first and says whether it dealt with it. */
type Answer = (params: Data, handled: (e: unknown) => boolean) => Promise<boolean>;

/** `asking`: the key of the plan the quick review's "Ask for changes" was tapped on, so that plan waits unanswered while the person says what should change. */
export function useCards(up: unknown, answer: Answer, asking: string | null = null) {
  // the refusal goes with the words, so a person who leaves without writing any sends nothing; it is that plan's, and no other
  const [owing, setOwing] = useState(asking);
  const refusing = useRef(false);
  // cards another device answered first, kept to say so until the next message is sent
  const [settled, setSettled] = useState<Record<string, CardData>>({});
  // where the cards this phone answered were answered, so each keeps a receipt after the Mac takes it down
  const [receipts, setReceipts] = useState<Record<string, Receipt>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  // plans whose sheet was closed: they stay in the chat as a row that reopens it
  const [closedPlans, setClosedPlans] = useState<string[]>([]);
  const cards: CardData[] = Array.isArray(up) ? (up as CardData[]) : [];
  const shown = [...cards, ...Object.values(settled).filter((c) => !cards.some((now) => cardKey(now) === cardKey(c)))];
  // reading the chat again starts the cards over; stable, so the read's effect does not run again for it
  const reset = useCallback(() => {
    setSettled({});
    setReceipts({});
    setFeedback(null);
    setClosedPlans([]);
  }, []);
  const settle = (card: CardData) => setSettled((old) => ({ ...old, [cardKey(card)]: card }));

  async function answerCard(card: CardData, key: string, values?: Data) {
    const done = await answer({ cardId: card.id, rev: card.rev, key, values }, (e) => {
      if (!answeredElsewhere(e)) return false;
      settle(card);
      return true;
    });
    if (done) {
      settle(card);
      setReceipts((old) => ({ ...old, [cardKey(card)]: { by: 'phone', choice: choiceLabel(card, key) } }));
    }
    if (done && asksForChanges(card, key)) {
      setFeedback('plan');
      // the sheet makes way for the field, which takes focus
      setClosedPlans((old) => [...old, cardKey(card)]);
    }
    return done;
  }
  // a plan that waits for an answer is read in a sheet over the chat; one answered elsewhere is a plain card
  const isOpenPlan = (card: CardData) => card.kind === 'plan' && !!card.plan && !(cardKey(card) in settled);
  /** What the composer sends first: with the plan still waiting for its changes, the refusal, and the words only once it was taken. */
  const asked = owing ? shown.find((c) => cardKey(c) === owing && isOpenPlan(c)) : undefined;
  const refusingFirst = (send: () => void) => () => {
    const refusal = asked?.choices?.find((c) => c.deny);
    if (!asked || !refusal) return send();
    if (refusing.current) return; // the refusal is on its way: a second tap sends nothing more
    refusing.current = true;
    void answerCard(asked, refusal.key)
      .then((done) => {
        if (done) send();
      })
      .finally(() => {
        refusing.current = false;
      });
  };
  // the cards that wait for the person's answer here (not one to finish on the Mac, nor a plan, which has its own sheet)
  const waiting = cards
    .filter((c) => c.where !== 'mac-only' && !(c.kind === 'plan' && c.plan))
    .map(cardKey)
    .join('|');
  return {
    shown,
    waiting,
    settled,
    receipts,
    feedback: asked ? ('plan' as Feedback) : feedback,
    /** The plan's sheet stays shut while its changes are asked for in the field; a revised plan is another card and opens its own. */
    closedPlans: asked ? [...closedPlans, cardKey(asked)] : closedPlans,
    answerCard,
    refusingFirst,
    isOpenPlan,
    sheetPlan: shown.find(isOpenPlan),
    closePlan: (card: CardData) => setClosedPlans((old) => [...old, cardKey(card)]),
    openPlan: (card: CardData) => {
      setOwing(null);
      setClosedPlans((old) => old.filter((k) => k !== cardKey(card)));
    },
    /** "Deny with comment" was answered: the next message says what to do instead. */
    comment: () => setFeedback('comment'),
    /** A message was sent: receipts and the composer's ask are done with. */
    sent: () => {
      setOwing(null);
      setFeedback(null);
      setSettled({});
      setReceipts({});
    },
    /** The chat is read again from the start. */
    reset,
  };
}

/** The composer's placeholder for what it is asked for. */
export const feedbackPlaceholder = (feedback: Feedback) =>
  feedback === 'plan' ? 'What should change in the plan?' : feedback === 'comment' ? 'Tell it what to do instead' : 'Message this chat';
