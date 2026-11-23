// What a user-role row's text is when MoPilot itself wrote it (a session's message, a peer's, a wake-up, a task result, a progress check, MoMo's routine report): the one-line card the desktop shows, or null when a person wrote it. MoMo's framing for the model is only ever a labelled card, never its words.
import { authoredCard } from '../../../shared/authoredEnvelope.mjs';

export type AuthoredCard = { title: string; body: string; kind: string; name?: string; completed?: boolean };

export function authoredCardOf(text: string): AuthoredCard | null {
  const card = authoredCard(text);
  return (
    card && {
      title: card.title,
      body: card.body,
      kind: card.kind,
      ...(card.kind === 'routine' ? { name: card.name, completed: card.completed } : {}),
    }
  );
}

/** The card's line in the shown language: a routine's report names the routine, any other framing for the model is just MoMo's message. */
export function authoredTitle(card: AuthoredCard, t: (key: string, options?: { name?: string }) => string): string {
  if (card.kind === 'routine') return t(card.completed ? 'momoReport.finished' : 'momoReport.unfinished', { name: card.name });
  return card.kind === 'marked' ? t('momoReport.marked') : card.title;
}
