// Reply to a selection (#4837): the words a person selected in a reply, put into the chat's composer as a quote, and the context that hands that to the replies on screen.
import { createContext } from 'react';
import { quoteBlocks } from '../../shared/quotedReply.mjs';

/** The quote's most characters: a whole page selected is cut with an ellipsis, as a note would be. */
export const QUOTE_MAX = 1500;

/** Takes the selected words into the chat's composer; null where the chat has no composer (a closed chat), so no reply action is offered. */
export const ReplyContext = createContext<((selected: string) => void) | null>(null);

/** The selected words as a Markdown quote ("> " before each line), cut at QUOTE_MAX; empty for nothing but blanks. */
export function quoteOf(selected: string): string {
  const text = selected.replace(/\r\n?|\u2028/g, '\n').trim();
  if (!text) return '';
  const cut = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text;
  return cut
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
    .join('\n');
}

/** The draft with the quote after the quotes already in it and ahead of what the person typed, under a blank line, so a stack of quotes reads in the order they were taken; the same quote is not added twice. */
export function withQuote(draft: string, selected: string): string {
  const quote = quoteOf(selected);
  if (!quote) return draft;
  const found = quoteBlocks(draft);
  if (found) return found.blocks.includes(quote) ? draft : `${[...found.blocks, quote].join('\n\n')}\n\n${found.rest}`;
  return draft.trim() ? `${quote}\n\n${draft}` : `${quote}\n\n`;
}
