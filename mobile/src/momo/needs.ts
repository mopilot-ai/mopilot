// Which of MoMo's cards still wait for the user: cards that vanish without this phone answering them were answered on the Mac.
import type { CardData } from '../components/RequestCard';

export type Needs = { seen: Record<string, CardData>; answeredOnMac: CardData[] };
export const emptyNeeds: Needs = { seen: {}, answeredOnMac: [] };
export const cardKey = (card: CardData) => String(card.id);

/** The next state once `cards` is what the Mac lists now; `mine` holds ids this phone answered. */
export function reconcileNeeds(prev: Needs, cards: CardData[], mine: ReadonlySet<string>): Needs {
  const now = new Set(cards.map(cardKey));
  // a card to finish on the Mac (connect Calendar) that went away was connected or dismissed there: nothing to report as answered
  const gone = Object.entries(prev.seen).filter(([id, c]) => !now.has(id) && !mine.has(id) && !c.inApp);
  return {
    seen: Object.fromEntries(cards.map((c) => [cardKey(c), c])),
    answeredOnMac: [...prev.answeredOnMac.filter((c) => !now.has(cardKey(c))), ...gone.map(([, c]) => c)].slice(-5),
  };
}
