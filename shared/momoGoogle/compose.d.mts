import type { GoogleState } from './state.mjs';
import type { SourceRow } from './view.mjs';

export type GoogleViewParts = {
  state: GoogleState;
  sources: SourceRow[];
  setupGoogle: 'idle' | 'waiting' | 'connected' | 'failed';
  cause: string | null;
};
export declare function googleViewOf(
  state: GoogleState,
  o?: { progress?: { done: number; total: number } | null; lastAttemptFailed?: boolean },
): GoogleViewParts;
export declare function composeGoogle(o: {
  call: (method: string, params: object) => Promise<unknown>;
  progress?: { done: number; total: number } | null;
  lastAttemptFailed?: boolean;
}): Promise<GoogleViewParts & { reachable: boolean }>;
