import type { TrustedKey } from '../../shared/host/momoEntitlement.mjs';
export type EntitlementState = {
  floorIat: number;
  signedSince: number | null;
  account: string | null;
  features: string[];
  exp: number;
  clockMark: number;
  held: boolean;
};
export type Decision =
  | { ok: true; state: EntitlementState; features: string[]; signed: boolean; warning: string | null; pausesAt: number | null }
  | { ok: false; state: EntitlementState; code: string; message: string };
export const MOMO_ENTITLEMENT_MODES: string[];
export function emptyEntitlementState(): EntitlementState;
export function entitlementStateShape(v: unknown): EntitlementState;
export function entitlementModeFrom(env: Record<string, string | undefined>): 'off' | 'warn' | 'required';
export function createEntitlementGate(o: {
  hostId: string;
  keys: TrustedKey[];
  revoked?: string[];
  mode?: 'off' | 'warn' | 'required';
  now: () => number;
}): {
  mode: 'off' | 'warn' | 'required';
  graceMs: number;
  clockOf: (state: EntitlementState) => number;
  accept: (grant: { account: string; features: string[]; entitlement?: unknown }, state: EntitlementState) => Decision;
  standing: (state: EntitlementState) => { live: true } | { live: false; code: string; message: string };
};
