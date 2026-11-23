// The account switching contract (design-v2 conflicts "账号池与换号机制", ux F8), shared by main
// (Codex's pool, electron/identity/codexAccounts.cjs) and the window (Claude's restartResume, src/harness/claude.ts).
//
// An automatic switch stays within one ProviderProfile and one billing type: a subscription moves
// to another subscription of the same provider, a key to another key of the same provider. Moving
// from a subscription to pay-per-use always asks first, even on the same provider; another provider
// (MoPilot credits) is only offered. A temporary chat keeps its account.

/**
 * An instance's provider as an id: main's instances carry the ProviderProfile object, the window's its id. Two
 * profiles for one custom endpoint are separate objects with the same id.
 */
const providerOf = (i) => (i.provider && typeof i.provider === 'object' ? i.provider.id : i.provider);

/** Same provider and same billing type. Instances: { id, provider, billing, status, limited? }. */
export function sameLane(a, b) {
  return !!a && !!b && providerOf(a) === providerOf(b) && a.billing === b.billing;
}

const usable = (i) => i.status === 'ok' && !i.limited;

/**
 * The rows with the most left first, the one in use (`active`) first among equals. `left(row)` is a percent; a login
 * not read yet counts as full. One order for main's pick of a login and for the window's list of them.
 * @template {{ id: string }} T
 * @param {T[]} rows
 * @param {string | undefined} active
 * @param {(row: T) => number} left
 * @returns {T[]}
 */
export function mostLeft(rows, active, left) {
  return [...rows].sort((a, b) => left(b) - left(a) || Number(b.id === active) - Number(a.id === active));
}

/**
 * What to do when the instance a chat is on can't serve it (a limit, or a lapsed login):
 * - { action: 'switch', to }: move on its own (same lane, auto-switch on);
 * - { action: 'confirm', to }: ask before paying per use on the same provider;
 * - { action: 'offer', to }: show a button for another provider (never automatic);
 * - { action: 'none' }.
 * Candidates are tried in the order given.
 */
export function onUnavailable({ from, candidates, autoSwitch = true, ephemeral = false }) {
  if (!from || ephemeral) return { action: 'none' };
  const rest = (candidates ?? []).filter((c) => c.id !== from.id && usable(c));
  const same = rest.find((c) => sameLane(from, c));
  if (same) return autoSwitch ? { action: 'switch', to: same } : { action: 'none' };
  if (from.billing === 'subscription') {
    const payg = rest.find((c) => providerOf(c) === providerOf(from) && c.billing === 'apiKey');
    if (payg) return { action: 'confirm', to: payg };
  }
  const other = rest.find((c) => providerOf(c) !== providerOf(from));
  return other ? { action: 'offer', to: other } : { action: 'none' };
}

/**
 * "When every account runs out", one choice per harness: its entry in prefs.limitAsk (the window) once the user has
 * set one, else what the old combined choice meant (auto-switch on asked before paid access). The settings row and
 * the paid-access offer both read it. Moving between subscriptions is the harness's own auto-switch (main).
 * - 'ask': ask before paid access;
 * - 'stop': ask nothing.
 */
export function limitChoice(autoSwitch, ask) {
  return (ask ?? autoSwitch) ? 'ask' : 'stop';
}

/** The confirmation before moving from a subscription to pay-per-use. */
export function payPerUseText(providerLabel) {
  return `Your subscription limit is reached. Continue with your ${providerLabel} API key? You'll pay per use from here.`;
}

/**
 * The note left in the chat after an automatic switch, naming the account it left when known (which one ran out).
 * reason: 'limit' | 'expired' | 'unavailable'; plan: the plan name of the account left ("Max").
 */
export function switchNoteText({ reason, from, to, plan = null, carried = false }) {
  const head =
    reason === 'expired'
      ? `${from ?? 'The account'} needs to sign in again`
      : reason === 'limit'
        ? `${plan ? `${plan} limit` : 'Usage limit'} reached${from ? ` on ${from}` : ''}`
        : `${from ?? 'The account'} isn't available`;
  return `${head}. Continued on ${to ?? 'another account'}${carried ? ' · Goal and plan mode carried over' : ''}`;
}
