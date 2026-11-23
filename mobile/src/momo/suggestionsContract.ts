// The shape of momo.suggestions.list (what MoMo suggested for Up next, electron/momo/suggestions.cjs), checked before the page draws it; a row that is not one is left out and a reply that is not a list throws. A Mac that does not list the methods has no suggestions.
export type Suggestion = {
  id: string;
  title: string;
  why: string;
  /** the one source line shown with it */
  source: string;
  /** the first step MoMo would take, sent to its chat on Start */
  step: string;
  /** 'new', or 'added' once the user kept it as a task of their own */
  status: 'new' | 'added';
  /** what the ranking used, kept so "why did you tell me this?" has an answer */
  score: { urgency: number; cost: number; confidence: number; novelty: number };
};
/** `done`: what the user did to a suggestion that is no longer listed, by its id (a brief's card reads it back) */
export type SuggestionsView = { suggestions: Suggestion[]; shown: number; done: Record<string, 'start' | 'hide'> };
export type SuggestionAction = 'add' | 'start' | 'hide';

export const SUGGESTIONS_METHOD = 'momo.suggestions.list';
export const SUGGESTION_ACT_METHOD = 'momo.suggestions.act';

/** Whether the phone shows suggestions: the Mac says its flag is on (momo.state.get) and lists both methods. */
export const suggestionsShown = (state: { suggestions: boolean } | null | undefined, has: (method: string) => boolean) =>
  state?.suggestions === true && has(SUGGESTIONS_METHOD) && has(SUGGESTION_ACT_METHOD);
/** How many new ones show before "Show more" when the Mac says none. */
const SHOWN = 6;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function parseSuggestions(value: unknown): SuggestionsView {
  const v = record(value);
  if (!v || !Array.isArray(v.suggestions)) throw new Error('Could not read the suggestions.');
  const suggestions = v.suggestions.flatMap((s): Suggestion[] => {
    const r = record(s);
    const id = text(r?.id);
    const title = text(r?.title);
    const source = text(r?.source);
    if (!r || !id || !title || !source) return [];
    const score = record(r.score);
    return [
      {
        id,
        title,
        why: text(r.why) ?? '',
        source,
        step: text(r.step) ?? '',
        status: r.status === 'added' ? 'added' : 'new',
        score: { urgency: num(score?.urgency), cost: num(score?.cost), confidence: num(score?.confidence), novelty: num(score?.novelty) },
      },
    ];
  });
  const given = record(v.done);
  const done = Object.fromEntries(Object.entries(given ?? {}).filter(([, a]) => a === 'start' || a === 'hide')) as SuggestionsView['done'];
  return { suggestions, shown: typeof v.shown === 'number' && v.shown > 0 ? Math.floor(v.shown) : SHOWN, done };
}
