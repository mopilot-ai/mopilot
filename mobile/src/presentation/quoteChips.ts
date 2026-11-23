// A phone's Ask (#5359): the quotes at the head of a draft shown as chips above the field, and the words typed under them as the field's own text. The draft stays one string ("> " lines, a blank line, the words), so a send, the outbox and every Mac, Host and harness take it as before.
import { quoteBlocks } from '../../../shared/quotedReply.mjs';

const QUOTE_START = /^>( |$)/;

export type SplitDraft = { quotes: string[]; typed: string };

/** The draft as its leading quote blocks (each as its raw "> " lines) and the words typed under them. */
export function splitDraft(full: string): SplitDraft {
  const found = quoteBlocks(full);
  const rest = found ? found.rest : full;
  // words that start like a quote are stored behind one space (see joinDraft); the field shows them as typed
  const typed = rest.startsWith(' >') && QUOTE_START.test(rest.slice(1)) ? rest.slice(1) : rest;
  return { quotes: found?.blocks ?? [], typed };
}

/** The draft for these quotes and typed words. Words that begin with "> " are stored behind a space so that they stay words and do not turn into a chip as they are typed. */
export function joinDraft(quotes: string[], typed: string): string {
  const words = QUOTE_START.test(typed) ? ` ${typed}` : typed;
  return quotes.length ? `${quotes.join('\n\n')}\n\n${words}` : words;
}

/** A quote block as one line of plain words, for its chip. */
export const chipText = (block: string): string =>
  block
    .split('\n')
    .map((line) => line.slice(2))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The draft without its `index`th quote. */
export function withoutQuote(full: string, index: number): string {
  const { quotes, typed } = splitDraft(full);
  return joinDraft(
    quotes.filter((_, i) => i !== index),
    typed,
  );
}
