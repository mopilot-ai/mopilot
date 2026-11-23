import type { AccountFile, AccountStatus, ClientConfig, DisconnectCause, Fetch, StoredAccount, Tokens, ClientKind } from './types.mjs';
/** The account cannot be used now; `cause` says why when the user can fix it by signing in again. */
export declare class AccountError extends Error {
  readonly code: 'not_connected' | 'needs_sign_in' | 'unavailable' | 'different_account' | 'wrong_account';
  readonly cause_: DisconnectCause | undefined;
  constructor(code: AccountError['code'], cause_?: DisconnectCause);
}
export type AccountDeps = {
  file: AccountFile;
  config: ClientConfig;
  /** The iOS OAuth client, when the owner made one; grants it made are refreshed with it. */
  iosConfig?: ClientConfig;
  fetch: Fetch;
  now(): number;
  testingMode?: boolean;
  /** How long a revoke at Google is waited for (default 3 seconds). */
  revokeMs?: number;
};
export declare class GoogleAccount {
  #private;
  readonly deps: AccountDeps;
  constructor(deps: AccountDeps);
  status(): Promise<AccountStatus>;
  /** The record, for callers that need the connect day or the granted scopes (never for a log). */
  load(): Promise<StoredAccount | null>;
  /** Who is connected changes with every connect, disconnect and dispose; work begun under an older value must not save. */
  generation(): number;
  /** Saves the tokens of a finished sign-in in one step with the checks that decide it (see account.mjs); returns what was saved. */
  connect(o: {
    email: string;
    subject: string;
    tokens: Tokens;
    client: ClientKind;
    rule: 'read' | 'send';
    generation: number;
  }): Promise<StoredAccount>;
  /** A valid access token, refreshed when it is near its end; one refresh at a time. */
  accessToken(): Promise<string>;
  /** An access token with the generation it belongs to, for `markNeedsSignIn` and `invalidate`. */
  access(): Promise<{ token: string; generation: number }>;
  /** Marks the account as needing a new sign-in, only if it is still the account `generation` was read for. */
  markNeedsSignIn(cause: DisconnectCause, generation: number): Promise<void>;
  /** Revokes a grant that was not kept (a sign-in for another account): best effort. */
  revokeToken(token: string): Promise<boolean>;
  /** The access token in hand was refused: the next `accessToken` asks Google for a new one. */
  invalidate(generation: number): Promise<void>;
  /** This object is done: every call says nothing is connected, and a refresh on its way saves nothing. */
  dispose(): void;
  /** Revokes the grant at Google (best effort: the tokens are erased here whatever Google answers) and forgets the account. */
  disconnect(): Promise<{
    revoked: boolean;
    owedToken: string | null;
  }>;
}

export declare function revokeGrant(o: { fetch: typeof fetch; revokeUri: string; token: string; ms?: number }): Promise<boolean>;
