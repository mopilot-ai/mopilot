// Folds the cards of a Host the phone reaches directly into the item union, so a card is one item whichever path delivered it (X3); the words of a state come from shared/host/cardLine.mjs.
import { cardLine } from '../../../../shared/host/cardLine.mjs';
import type { CardState, ShownCard } from '../../remote/hostCards';
import type { ApprovalItem, CardView, QuestionItem } from './types';

/** The line a restarted Host leaves on a card it closed; the same words as the card state `restarted`. */
const RESTARTED = cardLine({ state: 'restarted' }, { now: 0 }).text;

function viewOf(shown: ShownCard, machineName: string): CardView {
  const state: CardState = shown.state;
  switch (state.kind) {
    case 'sending':
      return { state: 'sending', optionId: state.optionId };
    case 'unreachable':
      return {
        state: 'unreachable',
        optionId: state.optionId,
        machineName,
        line: cardLine({ state: 'unreachable' }, { now: 0, machineName }).text as string,
      };
    case 'closed':
      return state.line === RESTARTED ? { state: 'restarted', machineName, line: state.line } : { state: 'closed', line: state.line };
    default: {
      const { at, remindMs, pauseMs } = shown.card;
      return {
        state: 'waiting',
        since: at,
        ...(remindMs !== undefined ? { remindMs } : {}),
        ...(pauseMs !== undefined ? { pauseMs } : {}),
      };
    }
  }
}

/** A Host card: a question stays a question, a permission or a link is an approval. `machineName` is the Host's name, for the states that say it. */
export function itemOfHostCard(shown: ShownCard, machineName = 'this machine'): ApprovalItem | QuestionItem {
  const { card } = shown;
  const base = {
    id: shown.id,
    origin: 'host' as const,
    title: card.summary.tool,
    ...(card.summary.line ? { detail: card.summary.line } : {}),
    macOnly: false,
    view: viewOf(shown, machineName),
  };
  if (card.cardKind === 'question') {
    const prompt = {
      id: card.requestId,
      text: card.summary.line || card.summary.tool,
      options: card.options.map((o) => ({ label: o.name })),
      multi: false,
      other: card.form !== undefined,
    };
    return { ...base, kind: 'question', prompts: [prompt], questions: 1 };
  }
  return { ...base, kind: 'approval', options: card.options.map((o) => ({ id: o.optionId, label: o.name, tone: o.kind })) };
}

export const itemsFromHostCards = (cards: readonly ShownCard[], machineName?: string) => cards.map((c) => itemOfHostCard(c, machineName));
