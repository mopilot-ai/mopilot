// The usage event's props for a thumbs up or down on a reply, sent only where the harness counts ratings as usage data.
import { HARNESS_TRAITS, type HarnessFamily } from '../harness/family';

/**
 * A thumbs up or down on a reply, as the props of a `reply_rated` usage event, naming the harness as the chat's turns do (`usageHarnessOf`). The click
 * is the user's consent to send it, so it goes whatever the sharing choice. A Codex rating goes to Codex's own feedback
 * upload instead, and nothing about another harness's chat goes to OpenAI.
 */
export function ratingEvent(family: HarnessFamily, harness: string, kind: 'good' | 'bad') {
  if (HARNESS_TRAITS[family].rating !== 'usage') return null;
  return { harness, rating: kind };
}
