// Logins that are one server account (#1312): which of them each harness's account list folds into which, so the
// account shows once and the switch policy never counts it as two quotas. A login takes part only with a verified
// server identity while signed in: an unknown or unconfirmed one is never matched, by email or otherwise.

const CLI_ID = 'default';

/**
 * The logins that repeat another one, each mapped to the login shown for that account. The shown login is a
 * MoPilot-added one rather than the CLI's own (that one can be signed in again as another account outside MoPilot,
 * and the added one is the login the user chose), the one in use among those, else the first listed.
 * @template {{ id: string }} L
 * @param {L[]} logins in list order
 * @param {(login: L) => string | null} serverId the login's verified server identity while signed in, else null
 * @param {string | null} [active] the login in use
 * @returns {Record<string, string>} folded login id -> shown login id
 */
function foldSameAccounts(logins, serverId, active = null) {
  /** @type {Map<string, L[]>} */
  const groups = new Map();
  for (const l of logins) {
    const key = serverId(l);
    if (key) groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  /** @type {Record<string, string>} */
  const same = {};
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const added = group.filter((l) => l.id !== CLI_ID);
    const shown = added.find((l) => l.id === active) ?? added[0];
    for (const l of group) if (l !== shown) same[l.id] = shown.id;
  }
  return same;
}

/**
 * What main has seen of each login (identity/contract/loginMarks.cjs), with the quota of each folded login carried onto the
 * login shown for its account: a limit on either holds both, and the least left counts. A lapsed sign-in stays the
 * folded login's own, since the two logins hold different credentials.
 * @param {Map<string, { limitedUntil?: number, expired?: boolean, left?: number }>} marks
 * @param {Record<string, string>} same see foldSameAccounts
 */
function foldMarks(marks, same) {
  const out = new Map(marks);
  for (const [id, shown] of Object.entries(same)) {
    const m = marks.get(id);
    if (!m) continue;
    const s = out.get(shown) ?? {};
    const limitedUntil = Math.max(s.limitedUntil ?? 0, m.limitedUntil ?? 0);
    const left = [s.left, m.left].filter((x) => typeof x === 'number');
    out.set(shown, { ...s, ...(limitedUntil ? { limitedUntil } : {}), ...(left.length ? { left: Math.min(...left) } : {}) });
  }
  return out;
}

/**
 * A ChatGPT login's server identity, from its token's own claims: the workspace (chatgpt_account_id) and the member's
 * email together, since the members of one workspace share its id (a token naming no email matches only another
 * naming none). Null without a workspace: an email alone never makes two logins one account.
 * @param {{ chatgptAccountId?: string | null, email?: string | null } | null | undefined} a
 */
function codexServerId(a) {
  return a?.chatgptAccountId ? `${a.chatgptAccountId}\n${String(a.email ?? '').toLowerCase()}` : null;
}

module.exports = { foldSameAccounts, foldMarks, codexServerId };
