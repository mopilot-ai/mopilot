// MoMo's suggestions as the Tasks panel's Up next gets them (A7, electron/momo/suggestions.cjs).

/** What a suggestion's score was made of, kept so "why did you tell me this?" has an answer. */
export interface MomoSuggestionScore {
  urgency: number;
  cost: number;
  confidence: number;
  novelty: number;
  total: number;
}

/** One suggestion: `status` says whether the user added it (a task of theirs that waits for Start). */
export interface MomoSuggestion {
  id: string;
  title: string;
  why: string;
  /** the one source line shown with it */
  source: string;
  /** the first step MoMo would take, sent to its chat on Start */
  step: string;
  /** the channel id, or 'main' */
  channel: string;
  kind: string;
  status: 'new' | 'added';
  createdAt: number;
  expiresAt: number;
  score: MomoSuggestionScore;
}

export type MomoSuggestionAction = 'add' | 'start' | 'hide';

/** Every answer: what was asked for, or why not (`reason`: MoMo is not allowed, the Tasks panel is off, or the suggestion is gone). */
export type MomoSuggestionsResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; reason?: 'not_allowed' | 'unavailable' | 'gone' };
