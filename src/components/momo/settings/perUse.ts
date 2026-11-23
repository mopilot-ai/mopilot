// Whether an account bills per use (#2139), and whether MoMo can run on it at all (#2308): an API key by its kind, or MoPilot credits by its plan (credits count as a subscription by kind). The one test MoMo's role pickers, their At-limit lanes and setup's suggestions share, in every state the account is in; and where an account stands in MoMo's brain lists, with the words both say it in.
import { MOPILOT_PLAN } from '../../../harness/accounts';
import { HARNESS_TRAITS } from '../../../harness/family';
import type { HarnessId } from '../../../harness/types';

export const perUse = (r: { account: { kind: string }; plan: string | null }) => r.account.kind === 'apiKey' || r.plan === MOPILOT_PLAN;

/** The states a brain can run on now: signed in, or the login in use being checked again. */
const OFFERED = new Set(['signed-in', 'checking']);

/**
 * Where an account stands in MoMo's brain lists, setup's and Settings' alike (#2281): `offered`, a brain can run on it now;
 * `at-limit`, listed with its state until it resets but never suggested; null, left out: billed per use (background
 * work would cost money), signed out, or not yet confirmed as whose it is.
 */
export function brainAccountUse(r: { account: { kind: string }; plan: string | null; state: string }): 'offered' | 'at-limit' | null {
  if (perUse(r)) return null;
  if (r.state === 'limited') return 'at-limit';
  return OFFERED.has(r.state) ? 'offered' : null;
}

/** An account's state as MoMo's brain lists say it: its plan and full status ("Max · Limit reached · resets Oct 25"). */
export const brainAccountState = (r: { plan: string | null; status: { text: string } }) =>
  [r.plan, r.status.text].filter(Boolean).join(' · ');

/** Why MoMo can't run on an account, the one line its brain pickers show, or null (a harness's trait, #2308). */
export const momoUnavailable = (h: HarnessId, account: { kind: string }) =>
  account.kind === 'apiKey' ? HARNESS_TRAITS[h].momoKeyRefused : null;
