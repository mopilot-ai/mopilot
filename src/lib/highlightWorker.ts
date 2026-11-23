// The highlight worker's entry: answers each request of highlight.ts with Shiki's html for it (highlightEngine.ts).
import { errorText } from '../../shared/userError.mjs';
import { highlightEntry } from './highlightEngine';
import type { HighlightReply, HighlightRequest } from './highlight';

/** The reply to one request: a failed grammar or highlighter start travels as its message, to be retried by the next request. */
export async function answer({ id, code, lang, dark }: HighlightRequest, run = highlightEntry): Promise<HighlightReply> {
  try {
    return { id, ...(await run(code, lang, dark)) };
  } catch (error) {
    return { id, error: errorText(error) };
  }
}

self.onmessage = (event: MessageEvent<HighlightRequest>) => void answer(event.data).then((reply) => self.postMessage(reply));
