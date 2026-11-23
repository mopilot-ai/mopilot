// The Host's logins and credential choice on the wire: what a machine reports per agent (its logins, the credential sources that exist, the one a chat started now would use), the choice a chat start may carry, and the refusals the Host answers with. Additive: an end that does not know a field drops it, and an absent field means one login and today's order.

/** The feature both ends declare before a credential choice or a login pin is sent; declared in FEATURES only by the build that serves it (a Host that drops the field would run the chat on another credential). */
export const LOGINS_FEATURE = 'logins';
/** Where a machine chat's model access can come from: a login on the machine, a key this Mac lends (pay per use), or an organization's lease. */
export const SOURCES = Object.freeze(['own', 'key', 'org']);
/**
 * The order a chat that chose nothing uses its credential in: the first source that exists. THE ONE CONSTANT of the default (#4667), as the owner decided it: a machine
 * that is signed in uses its own login (a subscription), and the key its Mac lends (pay per use) or an organization's lease only when it has none, or by explicit choice.
 * `tests/hostChatCredentials.test.ts` pins both ends of it. Only an agent whose Host can give one chat the machine's own login follows it (Claude Code today).
 */
export const DEFAULT_ORDER = Object.freeze(['own', 'org', 'key']);
/**
 * What an agent that runs every chat in one process does until each credential has its own process (H3): that process uses what is lent, a lease before a key, and the
 * machine's own login when nothing is. It is also what a Claude Code chat that began before the default changed keeps, so no chat switches credential mid-chat.
 */
export const LENT_FIRST_ORDER = Object.freeze(['org', 'key', 'own']);
/** The source a chat that chose nothing uses, given what exists. @param {{ own: boolean, key: boolean, org: boolean }} sources @param {readonly string[]} [order] @returns {'own' | 'key' | 'org'} */
export const usingOf = (sources, order = DEFAULT_ORDER) =>
  /** @type {'own' | 'key' | 'org'} */ (order.find((s) => sources[/** @type {'own'} */ (s)]) ?? 'own');
/** A login's standing on the machine. */
export const LOGIN_STATES = Object.freeze(['ok', 'signedOut', 'expired']);
/** How a login is billed. */
export const BILLING = Object.freeze(['subscription', 'apiKey']);
/** Why the Host refuses a turn that chose a credential or a login: never a fall back to another one. */
export const REFUSALS = Object.freeze({
  login_unavailable: 'That login is not on this machine.',
  login_signed_out: 'That login is signed out on this machine.',
  login_limited: 'That login is at its limit.',
  credential_unavailable: 'That credential is not available.',
  login_removed: 'That login was removed.',
  not_supported: 'This agent has one sign-in.',
});
const ID = /^[\w.-]{1,64}$/;
const text = (/** @type {unknown} */ v, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
const num = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The credential a chat start asks for, checked: a source and, for `own`, the login on the machine. Throws `bad`'s error for anything else.
 * @param {unknown} raw @param {(message: string) => Error} bad @returns {{ source: 'own' | 'key' | 'org', login?: string }}
 */
export function credentialOf(raw, bad) {
  const r = /** @type {any} */ (raw);
  if (!r || typeof r !== 'object' || !SOURCES.includes(r.source)) throw bad('Pick where the model access comes from.');
  if (r.login == null) return { source: r.source };
  if (r.source !== 'own') throw bad('Only a login on the machine can be named.');
  if (typeof r.login !== 'string' || !ID.test(r.login)) throw bad('That is not a login on the machine.');
  return { source: 'own', login: r.login };
}

/**
 * The logins an agent reports, read defensively: a row without an id or with an unknown word is dropped or quieted, never trusted.
 * @param {unknown} raw
 * @returns {{ id: string, label: string, state: 'ok' | 'signedOut' | 'expired', limited: boolean, limitedUntil?: number, billing: 'subscription' | 'apiKey', active: boolean, usage?: { label: string, usedPercent: number, resetsAt: number | null }[] }[] | undefined}
 */
export function loginsOf(raw) {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set();
  return raw.flatMap((item) => {
    const l = /** @type {any} */ (item);
    if (!l || typeof l !== 'object' || typeof l.id !== 'string' || !ID.test(l.id) || seen.has(l.id)) return [];
    seen.add(l.id);
    const until = num(l.limitedUntil);
    const usage = Array.isArray(l.usage)
      ? l.usage.flatMap((/** @type {any} */ w) => {
          const used = num(w?.usedPercent);
          return text(w?.label) && used !== null && used <= 100
            ? [{ label: text(w.label, 40), usedPercent: used, resetsAt: num(w.resetsAt) }]
            : [];
        })
      : [];
    return [
      {
        id: l.id,
        label: text(l.label, 120) || l.id,
        state: LOGIN_STATES.includes(l.state) ? l.state : 'signedOut',
        limited: l.limited === true,
        ...(until !== null && { limitedUntil: until }),
        billing: l.billing === 'apiKey' ? 'apiKey' : 'subscription',
        active: l.active === true,
        ...(usage.length && { usage }),
      },
    ];
  });
}

/**
 * One reported agent with its login fields made safe. Fields a Host does not send stay absent: no `logins` means the one login `signedIn` stands for.
 * @param {any} h a harness record as the Host reported it
 */
export function normalizeHarness(h) {
  const logins = loginsOf(h.logins);
  const sources =
    h.sources && typeof h.sources === 'object' ? Object.fromEntries(SOURCES.map((s) => [s, h.sources[s] === true])) : undefined;
  const using = SOURCES.includes(h.using) ? h.using : undefined;
  // a field a Host does not send stays absent, so a record from an older Host is unchanged
  const { logins: _l, sources: _s, using: _u, loginsSupported: _p, ...rest } = h;
  return {
    ...rest,
    ...(logins && { logins }),
    ...(sources && { sources }),
    ...(using && { using }),
    ...(typeof h.loginsSupported === 'boolean' && { loginsSupported: h.loginsSupported }),
  };
}

/**
 * The logins of a reported agent as a person is shown them: the list when the Host sent one, else the one login `signedIn` stands for (none when the agent is not installed).
 * @param {any} h a normalized harness record
 */
export function effectiveLogins(h) {
  if (h.logins) return h.logins;
  if (!h.detected) return [];
  return [{ id: 'default', label: '', state: h.signedIn ? 'ok' : 'signedOut', limited: false, billing: 'subscription', active: true }];
}
