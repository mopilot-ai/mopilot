// window.native.momoSuggestions's types (MoMo's Up next suggestions, A7), merged into NativeApi; the calls are declared in electron/bridge/momoSuggestions.cjs.
import type { MomoSuggestion, MomoSuggestionAction, MomoSuggestionsResult } from './contracts/momoSuggestions';

declare module '../native' {
  interface NativeApi {
    momoSuggestions: {
      /** the live suggestions, best first; `shown` is how many the panel shows before "Show more" */
      list(): Promise<
        MomoSuggestionsResult<{ v: 1; suggestions: MomoSuggestion[]; shown: number; done: Record<string, 'start' | 'hide'>; now: number }>
      >;
      /** the user's own Add, Start or Hide; Start sends the suggestion's first step to MoMo's chat in its channel */
      act(
        id: string,
        action: MomoSuggestionAction,
      ): Promise<MomoSuggestionsResult<{ id: string; action: MomoSuggestionAction; channel: string }>>;
      onChanged(cb: () => void): () => void;
    };
  }
}
