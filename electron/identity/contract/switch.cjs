// The account switching contract for the main process. The billing-type rules live in shared/switch.mjs
// (a switch stays on one provider and billing type; moving to pay-per-use is only offered). Claude's
// policy runs here, with no window (WP3-7; A12, A23): which login a chat moves to when its own hits a
// limit or its login lapses, and what the chat says about it. ClaudeAdapter (electron/harness/claude/adapter.cjs)
// asks `decideClaudeSwitch` and carries the answer out; windows only show the result, or the confirmation
// when one is needed.
const shared = require('../../../shared/switch.mjs');
const { foldMarks } = require('./sameAccount.cjs');

/** A limit that comes with no reset time holds the login back for this long. */
const LIMIT_HOLD_MS = 30 * 60_000;
/** At most RECENT_MAX automatic continues per chat in RECENT_MS, so a stuck backend can't loop. */
const RECENT_MS = 10 * 60_000;
const RECENT_MAX = 3;

/** "Max" for a Claude Max login, for the switch note. */
function planName(a) {
  const base = String(a?.subscriptionType || a?.organizationType || '')
    .replace(/^claude[_ ]/i, '')
    .replace(/_/g, ' ')
    .trim();
  const w = base.split(' ')[0];
  return w ? `${w[0].toUpperCase()}${w.slice(1)}` : null;
}

/**
 * A Claude login as the switching contract sees it.
 * marks: Map(account id -> { limitedUntil?: ms, expired?: boolean, left?: percent }) of what main has seen.
 * @returns {import('../../../shared/switch.mjs').LaneInstance}
 */
function claudeInstance(a, marks, now) {
  const m = marks.get(a.id);
  return {
    id: a.id,
    provider: 'anthropic',
    billing: /api.?key|console/i.test(a.authMethod ?? '') ? 'apiKey' : 'subscription',
    status: a.loggedIn && !m?.expired ? 'ok' : 'signedOut',
    limited: !!m?.limitedUntil && m.limitedUntil > now,
  };
}

/**
 * The logins with the most left first; the login in use goes first among equals. What was left when a limit struck
 * (nothing) says nothing once that limit has ended: until the next reading the login counts as full again.
 * @param {{ id: string }[]} rows
 * @param {string | undefined} active
 * @param {Map<string, { left?: number, limitedUntil?: number }>} marks
 * @param {number} now ms
 * @returns {any[]} rows, in that order
 */
function mostLeft(rows, active, marks, now) {
  const left = (id) => {
    const m = marks.get(id);
    return m?.limitedUntil && m.limitedUntil <= now ? 100 : (m?.left ?? 100);
  };
  return shared.mostLeft(rows, active, (r) => left(r.id));
}

/**
 * The login a Claude chat runs on, from the one it picked or moved to (A-9): that login while it is usable (signed in,
 * not marked lapsed or out of usage). When it is not and auto-switch is on, the usable login of the same billing lane
 * with the most left stands in, the active one first on a tie, so the turn does not start on a login known to refuse
 * it. Otherwise the chat stays on its pick, so its turn reports the sign-in or the limit and
 * decideClaudeSwitch decides (and asks) where it goes. A pick no longer listed has no lane to keep, and no pick means
 * the active login. A pick folded into another login of the same account (view.same, #1312) stands as that login, and
 * runs as itself while that one is signed in: it is the same quota.
 * @param {string | null | undefined} pick
 * @param {{ active: string, autoSwitch?: boolean, same?: Record<string, string>, accounts: { id: string, loggedIn?: boolean, authMethod?: string | null }[] }} view
 * @param {Map<string, { expired?: boolean, limitedUntil?: number }> | { snapshot: () => Map<string, any> }} [marks] see
 *   claudeInstance; LoginMarks or a copy of its marks
 * @param {number} [now] ms
 * @param {boolean} [preflight] false: only a signed-out pick is stood in for, which is what the login a chat is on
 *   means once a turn has started (ClaudeAdapter.accountOf); the move before a turn is ClaudeAdapter.preflight
 * @returns {string}
 */
function claudeLoginFor(pick, { active, autoSwitch, accounts, same = {} }, marks = new Map(), now = Date.now(), preflight = true) {
  // with no logins listed only the CLI's own one is signed in
  if (!accounts.length) return pick === 'default' ? pick : active;
  const own = preflight ? (pick ?? active) : pick;
  const row = own ? accounts.find((a) => a.id === (same[own] ?? own)) : null;
  if (!row) return active;
  const held = foldMarks('snapshot' in marks ? marks.snapshot() : marks, same);
  const from = claudeInstance(row, held, now);
  // a chat with no pick of its own is on the active login whatever its sign-in status says right now (it may not be read
  // yet): only what main marked on it moves the chat; a pick is also stood in for while it reads signed out
  const marked = from.limited || !!held.get(row.id)?.expired;
  const stays = preflight ? (pick ? from.status === 'ok' && !from.limited : !marked) : row.loggedIn;
  if (autoSwitch === false || stays) return pick ?? active;
  const lane = accounts.filter((a) => {
    const i = claudeInstance(a, held, now);
    return i.status === 'ok' && !i.limited && i.billing === from.billing;
  });
  return mostLeft(lane, active, held, now)[0]?.id ?? pick ?? active;
}

/**
 * What to do when the login a Claude chat runs on can't serve it.
 * @param {object} o
 * @param o.account the login the chat ran on
 * @param [o.reason] 'limit' | 'expired'
 * @param o.view the logins ({ active, autoSwitch, accounts, same })
 * @param o.marks see claudeInstance; the login in use is marked here as the reason says
 * @param [o.now] ms
 * @param [o.recent] when this chat last continued automatically (ms)
 * @param [o.ephemeral] a temporary chat: it keeps the login it started on
 * @param [o.goal] the chat's goal, to say it carries over
 * @param [o.keyMode] a key runs the whole harness: there is no other login to move to
 * @returns {{ action: 'switch'|'confirm'|'offer'|'none', from?: string, to?: string, note?: string, carried?: boolean, recent: number[], why?: string }}
 *   confirm / offer are never carried out here: moving to pay-per-use or another provider is asked, and
 *   with no window to ask in the caller pauses instead (ClaudeAdapter.unresolved)
 */
function decideClaudeSwitch({
  account,
  reason = 'limit',
  view,
  marks,
  now = Date.now(),
  recent = [],
  ephemeral = false,
  keyMode = false,
  goal = null,
}) {
  const keep = recent.filter((t) => now - t < RECENT_MS);
  const none = (why) => ({ action: /** @type {const} */ ('none'), why, recent: keep });
  if (keyMode) return none('key');
  if (keep.length >= RECENT_MAX) return none('looping');
  const accounts = view?.accounts?.length ? view.accounts : [{ id: 'default', loggedIn: true }];
  // a login folded into another of the same account (#1312) shares that one's quota: a limit holds both. A lapse is
  // its own sign-in's, and the other login of the account can take the chat over.
  const same = view?.same ?? {};
  const shown = same[account] ?? account;
  const key = reason === 'expired' ? account : shown;
  const mark = foldMarks(new Map(marks), same);
  const cur = mark.get(key) ?? {};
  mark.set(
    key,
    reason === 'expired'
      ? { ...cur, expired: true }
      : { ...cur, limitedUntil: (cur.limitedUntil ?? 0) > now ? cur.limitedUntil : now + LIMIT_HOLD_MS },
  );
  // the one with the most left first, the login in use among equals
  const rows = mostLeft(
    accounts.filter((a) => a.id !== key),
    view?.active,
    mark,
    now,
  );
  const fromRow = accounts.find((a) => a.id === shown);
  const d = shared.onUnavailable({
    from: claudeInstance({ loggedIn: true, ...fromRow, id: key }, mark, now),
    candidates: rows.map((a) => claudeInstance(a, mark, now)),
    autoSwitch: view?.autoSwitch !== false,
    ephemeral,
  });
  if (d.action !== 'switch') return { action: d.action, ...('to' in d && d.to ? { to: d.to.id } : {}), recent: keep };
  const toRow = rows.find((a) => a.id === d.to.id);
  const carried = goal?.status === 'active' && !!goal.objective;
  const note = shared.switchNoteText({
    reason,
    from: fromRow?.email ?? undefined,
    to: toRow?.email ?? undefined,
    plan: planName(fromRow),
    carried,
  });
  return { action: 'switch', from: account, to: d.to.id, note, carried, recent: [...keep, now] };
}

module.exports = { ...shared, decideClaudeSwitch, claudeInstance, claudeLoginFor, planName, LIMIT_HOLD_MS, RECENT_MS, RECENT_MAX };
