import type { GoogleAccount } from './account.mjs';
import type { ClientConfig, ClientKind, Fetch } from './types.mjs';
import type { Handoff } from './handoff.mjs';
import type { Sealer } from './seal.mjs';
export type ConsentErrorCode =
  | 'bad_redirect'
  | 'no_ios_client'
  | 'different_account'
  | 'superseded'
  | 'no_account'
  | 'unknown_flow'
  | 'expired'
  | 'invalid'
  | 'denied'
  | 'scope_missing'
  | 'wrong_account'
  | 'exchange_failed';
export declare class ConsentError extends Error {
  readonly code: ConsentErrorCode;
  constructor(code: ConsentErrorCode);
}
export type ConsentDeps = {
  account: GoogleAccount;
  config: ClientConfig;
  iosConfig?: ClientConfig;
  sealer: Sealer;
  fetch: Fetch;
  now(): number;
};
export type { Handoff };
export declare class GoogleConsent {
  #private;
  readonly deps: ConsentDeps;
  constructor(deps: ConsentDeps);
  /** How many sign-ins were begun and are still waiting. */
  pending(): number;
  /** Starts a consent: `read` for mail and calendar, `send` for the optional send-only step (needs a connected account). */
  begin(o: { purpose: 'read' | 'send'; redirectUri: string; client: ClientKind }): Promise<{
    flowId: string;
    authUrl: string;
    sealTo: string;
    expiresAt: number;
  }>;
  /** Finishes a consent from a sealed hand-off. A flow is used once, whatever happens. */
  complete(
    flowId: string,
    sealed: string,
  ): Promise<{
    email: string;
    canSend: boolean;
  }>;
}
