import type { AccountStatus } from './types.mjs';
export declare const DISCONNECT_CAUSES: readonly string[];
export type GoogleState =
  | { kind: 'not_connected'; canStart: boolean; iosRedirectUri: string | null }
  | { kind: 'connecting' }
  | { kind: 'connected_read_only'; email: string; connectedAt: number }
  | { kind: 'send_granted'; email: string; connectedAt: number }
  | { kind: 'disconnected'; email: string; cause: string; since: number };
export declare function googleStateOf(o: {
  status: AccountStatus;
  pending: number;
  configured: { desktop: boolean; iosRedirectUri: string | null };
}): GoogleState;
