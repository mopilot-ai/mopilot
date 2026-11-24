// What the client shows when a Host does not take the account's MoMo access (the server-signed entitlement, #5474): codes, cause and the one-click fix.
import type { MomoFix, Open } from './momoView.ts';

export const MOMO_ACCESS_CODES = [
  'entitlement_missing',
  'entitlement_invalid',
  'entitlement_unknown_key',
  'entitlement_wrong_host',
  'entitlement_stale',
  'entitlement_expired',
  'entitlement_revoked',
  'clock_skew',
  'not_invited',
  'entitlement_unwritable',
] as const;

/** Why this Host does not take the account's MoMo access (the server-signed entitlement, #5474), with the real cause shown as is and the one-click fix when one exists. */
export interface MomoAccessProblem {
  code: Open<(typeof MOMO_ACCESS_CODES)[number]>;
  cause: string;
  fix: MomoFix | null;
}

/** The access problem a Host's refusal of the grant stands for (its `code` and the cause it worded), or null when the refusal is not about access. */
export function momoAccessProblem(code: string, cause: string): MomoAccessProblem | null {
  return (MOMO_ACCESS_CODES as readonly string[]).includes(code) ? { code, cause, fix: momoAccessFix(code) } : null;
}

/** The fix a client offers for an access problem: a token that is gone, old or not for this Host is fetched again; an old app is updated; a skewed clock is checked; a withdrawn or missing invite has none. */
export function momoAccessFix(code: string): MomoFix | null {
  switch (code) {
    case 'entitlement_expired':
    case 'entitlement_stale':
    case 'entitlement_invalid':
    case 'entitlement_wrong_host':
      return { id: 'refresh-access', label: 'Refresh access' };
    case 'entitlement_missing':
    case 'entitlement_unknown_key':
      return { id: 'update-app', label: 'Update MoPilot' };
    case 'clock_skew':
      return { id: 'check-clock', label: 'Check the clock' };
    default:
      return null;
  }
}
