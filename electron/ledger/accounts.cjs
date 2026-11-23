// How the request ledger names the account a Claude Code turn runs on: the login MoPilot resolved (#1294: the CLI's own
// login by the server's answer, verified or not; an added login by its own config folder), or the key it bills to.
// Never a key itself, and never the shared ~/.claude.json's label.

/** How a key-paid session's billing kind pays: the line's `pay`, and the account id it is named by. */
const KEY_PAID = Object.freeze({
  cloud: ['cloud', 'cloud'],
  mopilot: ['mopilot', 'gateway'],
  apiKey: ['apiKey', 'key'],
  routed: ['routed', 'routed'],
});

/**
 * @param {{ key?: string, login?: boolean, account?: string }} evt a session event (electron/harness/claude/sessions.cjs): `login`
 *   is whether the session bills to a subscription login, `account` that login's id
 * @param {{ view: () => { accounts?: { id: string, email: string | null, isDefault?: boolean, identity?: string | null, authMethod?: string | null }[],
 *   same?: Record<string, string> } | null | undefined,
 *   authMode: () => string, cloud: () => unknown, loginPay?: (authMethod: string | null | undefined) => 'plan' | 'key',
 *   billingOf?: (key: string) => string }} o `loginPay`: whether a CLI login is a subscription or a Console key; `billingOf`: how
 *   the session's process was started to pay (harness/claude/auth.cjs ledgerMarks), which a busy process keeps after the setting changes
 * @returns {import('./line.cjs').LedgerAccount}
 */
function claudeLedgerAccount(evt, o) {
  // an API key, MoPilot credits, a cloud provider or the user's own provider: named by how it bills, never by the key
  if (!evt.login) {
    const kind = typeof evt.key === 'string' && o.billingOf ? o.billingOf(evt.key) : '';
    const started = Object.hasOwn(KEY_PAID, kind) ? KEY_PAID[/** @type {keyof typeof KEY_PAID} */ (kind)] : null;
    if (started) return { id: started[0], pay: /** @type {any} */ (started[1]) };
    const id = o.cloud() ? 'cloud' : o.authMode();
    const pay = { cloud: 'cloud', mopilot: 'gateway', apiKey: 'key', routed: 'routed' }[id] ?? 'unknown';
    return { id, pay: /** @type {any} */ (pay) };
  }
  const id = typeof evt.account === 'string' && evt.account ? evt.account : 'default';
  const v = o.view();
  // a login that is the same server account as another is shown as that one's row (identity/contract/sameAccount.cjs, #1312)
  const shown = v?.same?.[id] ?? id;
  const row = v?.accounts?.find((a) => a.id === shown);
  if (!row) return { id, pay: o.loginPay ? 'unknown' : 'plan' };
  const pay = o.loginPay ? o.loginPay(row.authMethod) : 'plan';
  // an added login signs in in a folder of its own, so its email is its own; the CLI's login is as #1294 left it
  const verified = !row.isDefault ? !!row.email : row.identity === 'verified' ? true : row.identity === 'unverified' ? false : null;
  return { id, email: row.email, verified, pay };
}

module.exports = { claudeLedgerAccount };
