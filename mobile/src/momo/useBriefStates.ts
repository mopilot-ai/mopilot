// What became of the suggestions on a morning brief's cards (A7), read from the Mac's own store rather than kept in the card: Start and Hide are 'start' and 'hide', a suggestion that is no longer listed and has no record (it expired, or went) is 'gone', and one still waiting, or not yet read, is undefined. A card that is reopened, or seen again after the chat reloads, reads the same. Read again as MoMo's memory changes (momo.changed tells it for each act, from any device).
import type { MobileRuntime } from '../contracts';
import type { MomoApi } from './api';
import { type Guard, useLoad } from './useLoad';

export type BriefState = 'start' | 'hide' | 'gone';

export function useBriefStates(
  runtime: MobileRuntime,
  api: MomoApi,
  guard: Guard,
  /** whether the phone shows suggestions (suggestionsShown): the Mac's flag is on and it lists the methods */
  listed: boolean,
  version: number,
  /** the page's one call at a time: resolves whether it went */
  run: (work: () => Promise<unknown>) => Promise<boolean>,
) {
  const read = useLoad(runtime, () => (listed ? guard(api.suggestions) : Promise.resolve(null)), [api, listed, version]);
  const view = read.data;
  return {
    /** whether cards may act at all: with suggestions off a card is only the brief's line */
    on: listed,
    /** The user's Hide or Start on a card's suggestion; the card then reads what the Mac says. */
    act: (id: string, action: 'hide' | 'start') =>
      void run(() => api.actSuggestion(id, action)).then((ok) => {
        if (ok) read.reload();
      }),
    stateOf: (id: string): BriefState | undefined =>
      view ? (view.done[id] ?? (view.suggestions.some((s) => s.id === id) ? undefined : 'gone')) : undefined,
  };
}
