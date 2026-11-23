// Whether a MoMo role's brain is known to be at its usage limit before anything is sent (#2306), and what its at-limit rule then does: the identity registry's instance for the brain's account (identity/contract/registry.cjs: `limited` and `limitedUntil`, as main last saw them) decides; Next account moves to another account of the same harness and billing lane that isn't out; with none, Next account pauses (effectiveAtLimit). Harness-independent: a basic (ACP) harness reports no limits, so it is never held here, and says so itself when a turn fails.
const { parseKind } = require('../../shared/harnessKind.mjs');
const { effectiveAtLimit } = require('../../shared/momoPrefs.mjs');

/** Billing that runs out until a reset (a plan); a key or credits never do. */
const PLAN = new Set(['subscription', 'harness']);

/**
 * The brain's account as an instance of its harness: its own, else (no account picked) the one in use.
 * @param {any[]} list the harness family's instances
 * @param {{ harness: string, account?: string | null }} brain
 */
function instanceOf(list, brain) {
  const basic = parseKind(brain.harness)?.basic;
  const own = basic ? list.filter((i) => i.account === basic) : list;
  return (brain.account ? own.find((i) => i.account === brain.account) : own.find((i) => i.active)) ?? null;
}

/** When a limit lifts, as the main chat says it ("Oct 25, 6:00 PM"). */
const untilText = (/** @type {number} */ at) =>
  new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * What a role does with `brain` now.
 * - `{ go: brain }`: it isn't known to be out, or it moved to `account` (Next account).
 * - `{ held: text }`: the rule says Pause or Skip this run; `text` says why ("Claude Code is at its limit until …").
 * @param {{ instances: (family: string) => any[] } | null | undefined} identity the identity registry (none: nothing is known)
 * @param {{ harness: string, account?: string | null }} brain
 * @param {import('../../shared/momoPrefs.mjs').MomoAtLimit} rule the role's saved at-limit choice (readMomoPrefs().atLimit[role])
 * @param {number} now
 * @param {(kind: string) => string} label a harness's name for the user (mainChat.cjs labelOf)
 */
function atLimit(identity, brain, rule, now, label) {
  const parsed = parseKind(brain?.harness);
  if (!parsed) return { go: brain };
  const list = identity?.instances(parsed.family) ?? [];
  const i = instanceOf(list, brain);
  if (!i?.limited || !PLAN.has(i.billing)) return { go: brain };
  const others = parsed.basic
    ? []
    : list.filter((o) => o.account !== i.account && o.status === 'ok' && !o.limited && o.billing === i.billing);
  if (effectiveAtLimit(rule, !others.length) === 'nextAccount') return { go: { ...brain, account: others[0].account } };
  const until = typeof i.limitedUntil === 'number' && i.limitedUntil > now ? ` until ${untilText(i.limitedUntil)}` : '';
  return { held: `${label(brain.harness)} is at its limit${until}` };
}

module.exports = { atLimit, untilText };
