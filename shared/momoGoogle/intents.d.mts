import type { Catcher } from './signIn.mjs';
import type { Sealer } from './seal.mjs';

export function googleIntents(o: {
  call: (method: string, params: object) => Promise<unknown>;
  sealer: Sealer;
  startCatcher?: (() => Promise<Catcher>) | null;
  client?: 'desktop' | 'ios';
}): Record<
  'google' | 'source.reconnect' | 'source.remove',
  (intent: { intent?: string; client?: string; id?: unknown }) => Promise<{ notice?: string }>
>;

export declare const OWED_NOTICE: string;
