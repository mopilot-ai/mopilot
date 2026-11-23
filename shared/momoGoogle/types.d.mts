/** Read-only scopes of the closed alpha, and the one optional send-only scope (D10). */
export declare const READ_SCOPES: readonly [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];
export declare const READ_ACCESS: readonly string[];
export declare const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** Why the source is disconnected; the UI words each one ("Google access ended: ..."). */
export type DisconnectCause = 'revoked' | 'testing_expired' | 'scope_missing' | 'client_rejected' | 'wrong_account';
export type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};
/** What the Host keeps sealed. `needsSignIn` is set when Google refused the refresh token; tokens stay so a reconnect is explicit. */
export type StoredAccount = {
  version: 1;
  email: string;
  /** Google's id of the account (`sub`): what two sign-ins are compared by, never the address. */
  subject: string;
  /** The day this account was first connected: what bounds the mail and calendar reads. Kept across reconnects of the same account. */
  connectedAt: number;
  /** When the refresh token was issued (a reconnect or the send step renews it): what Testing mode's seven days count from. */
  grantedAt: number;
  /** The OAuth client that made the grant; a record from before there were two has none and is a desktop one. */
  client?: ClientKind;
  tokens: Tokens;
  needsSignIn?: {
    cause: DisconnectCause;
    since: number;
  };
};
export type AccountStatus =
  | {
      state: 'not_connected';
    }
  | {
      state: 'connected';
      email: string;
      canSend: boolean;
      connectedAt: number;
    }
  | {
      state: 'needs_sign_in';
      email: string;
      cause: DisconnectCause;
      since: number;
    };
/** The sealed file the Host persists the account in (the Host's safeStorage seals it). */
export interface AccountFile {
  load(): Promise<StoredAccount | null>;
  save(account: StoredAccount): Promise<void>;
  clear(): Promise<void>;
}
/** Google's OAuth client of this app (a desktop client: its secret is not confidential, but it is still never logged). */
export type ClientKind = 'desktop' | 'ios';
export type ClientConfig = {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
  revokeUri: string;
};
export type Fetch = (
  url: string,
  init?: {
    method?: string;
    redirect?: 'error';
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;
