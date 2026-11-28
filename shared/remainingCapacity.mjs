// What a harness or an account has left, as one measure: the fraction left of its tightest usage window times its plan's
// size (plan units). Pure: start_session's harness "auto" (electron/session/orchestration/autoHarness.cjs) and MoMo's
// default brain (src/components/momo/setup/defaultBrain.ts) both rank by it, so they agree on which has the most left.

import { parseKind } from './harnessKind.mjs';

/** Below this fraction left, harness "auto" passes a harness over for one with more, as it does one that is out. */
export const LOW_CAPACITY = 0.1;

/**
 * How much each plan holds next to the smallest paid one, by harness and by a word of the plan's name (Claude Pro = 1,
 * Max 5× = 5; Codex Plus = 1, Pro Lite = 5, Pro = 20). A harness missing here has no known plan sizes.
 */
export const PLAN_SIZES = {
  codex: { plus: 1, team: 1, business: 1, 'pro lite': 5, pro: 20 },
  claude: { pro: 1, team: 1, max: 5 },
};

/** Billing types of a plan login: a subscription's windows, or a basic harness's own sign-in. */
const PLAN_BILLING = new Set(['subscription', 'harness']);

/** A plan name with case, spaces, underscores and hyphens dropped, so "Pro Lite", "pro_lite" and "prolite" read alike. */
const squash = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * A plan's size in plan units: the multiplier it names ("Max 20×", "default_claude_max_20x"), else the size of the
 * longest of `sizes`' words its name holds ("Pro Lite" before "Pro"), else null (not known).
 * @param {Record<string, number>} sizes
 * @param {string | null | undefined} plan
 * @returns {number | null}
 */
export function planUnitsOf(sizes, plan) {
  if (!plan) return null;
  const mult = /(\d+)\s*[×x]/i.exec(plan)?.[1];
  if (mult) return Number(mult);
  const name = squash(plan);
  const key = Object.keys(sizes)
    .sort((a, b) => squash(b).length - squash(a).length)
    .find((k) => name.includes(squash(k)));
  return key ? sizes[key] : null;
}

/**
 * A plan's size on harness `harness` (an identity registry harness id), or null when its sizes or the plan are not known.
 * @param {string} harness
 * @param {string | null | undefined} plan
 */
export const planUnits = (harness, plan) => (Object.hasOwn(PLAN_SIZES, harness) ? planUnitsOf(PLAN_SIZES[harness], plan) : null);

/**
 * What one account holds now, in plan units: the percent left of its tightest window over 100, times its plan's size
 * (1 when that is not known, so the percent alone compares). Null when its usage is not known.
 * @param {{ left: number | null | undefined, units: number | null | undefined }} a
 * @returns {number | null}
 */
export const accountRemaining = (a) => (a.left == null ? null : (a.left * (a.units ?? 1)) / 100);

/**
 * What harness `kind` has left, from the identity registry's instances (identity/contract/registry.cjs) of its family:
 * - pay per use it runs on now (an active key or credits): never out, nothing to measure (`payPerUse` names its billing);
 * - else its signed-in plan logins together: out (`limited`) when every one is; `units` what they hold (accountRemaining
 *   of each, a login out until its reset holding none) and `fraction` that over their combined size. Both null while
 *   any login that is not out has no usage reading: what it holds is not known, so neither is the whole.
 * Null when nothing is known: no signed-in login (whether it can run at all is another question), or no harness kind.
 * A key it isn't set to doesn't carry a new session, so it doesn't count.
 * @param {{ account: string, status: string, limited: boolean, active?: boolean, billing?: string, left?: number | null, units?: number | null }[] | null | undefined} instances
 * @param {string} kind
 * @returns {import('./remainingCapacity.d.mts').Capacity | null}
 */
export function remainingCapacity(instances, kind) {
  const parsed = parseKind(kind);
  if (!parsed || !Array.isArray(instances)) return null;
  const ok = instances.filter((i) => i?.status === 'ok' && (!parsed.basic || i.account === parsed.basic));
  const paid = ok.find((i) => i.active && !PLAN_BILLING.has(i.billing ?? ''));
  if (paid) return { limited: false, payPerUse: paid.billing ?? 'unknown', fraction: null, units: null };
  const plans = ok.filter((i) => PLAN_BILLING.has(i.billing ?? ''));
  if (!plans.length) return null;
  const limited = plans.every((i) => i.limited === true);
  const held = plans.map((i) => (i.limited === true ? 0 : accountRemaining({ left: i.left, units: i.units })));
  if (held.some((h) => h == null)) return { limited, payPerUse: null, fraction: null, units: null };
  const units = /** @type {number[]} */ (held).reduce((s, h) => s + h, 0);
  const size = plans.reduce((s, i) => s + (i.units ?? 1), 0);
  return { limited, payPerUse: null, fraction: units / size, units };
}
