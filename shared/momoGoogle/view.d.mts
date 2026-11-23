import type { Sealer } from './seal.mjs';
import type { Catcher, GoogleHost, SignInResult } from './signIn.mjs';
import type { GoogleState } from './state.mjs';
export declare const GOOGLE_INTENTS: readonly string[];
export type SourceRow = { id: string; account: string; access: string; status: string; progress: { done: number; total: number } | null };
export declare function sourcesOf(state: GoogleState, progress?: { done: number; total: number } | null): SourceRow[];
export declare function setupGoogleOf(state: GoogleState, lastAttemptFailed: boolean): 'idle' | 'waiting' | 'connected' | 'failed';
export declare const causeOf: (state: GoogleState) => string | null;
export declare function runGoogleIntent(o: {
  intent: string;
  host: GoogleHost;
  startCatcher: () => Promise<Catcher>;
  sealer: Sealer;
  client: 'desktop' | 'ios';
}): Promise<SignInResult | { ok: true; state: GoogleState; revoked: boolean }>;
