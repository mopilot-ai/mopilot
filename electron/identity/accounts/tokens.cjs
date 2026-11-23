// Codex token reads and their pre-dispatch owners: retired sign-ins cannot publish status, tokens or automatic routing.
const { readAuth } = require('./records.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { AccountLimits } = require('./limits.cjs');

/** @typedef {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} Accounts */
const loginChanged = () => Object.assign(new Error('The login changed. Retry with the current sign-in.'), { code: 'ACCOUNT_CHANGED' });

class AccountTokens extends AccountLimits {
  /** A current access token for an account, refreshing through its sidecar when near expiry. */
  /** @this {Accounts} */
  async tokens(a, force = false) {
    const auth = readAuth(this.home(a));
    if (!force && auth?.kind === 'chatgpt' && auth.exp * 1000 > Date.now() + 5 * 60_000) return auth;
    return this.refresh(a);
  }
  /** @this {Accounts} */
  refresh(a) {
    const pending = this.refreshing.get(a.id);
    if (pending?.current()) return pending.job;
    const current = this.usageRefresh.capture(a.id);
    /** @type {{ current: () => boolean, job: Promise<any> }} */
    const owner = { current, job: Promise.resolve(null) };
    const job = (async () => {
      const r = await this.sidecar(a).call('account/read', { refreshToken: true });
      if (!current()) throw loginChanged();
      const auth = readAuth(this.home(a));
      if (!r?.account || auth?.kind !== 'chatgpt') {
        this.setStatus(
          a,
          'expired',
          this.vault.unreadable(this.home(a))
            ? 'MoPilot couldn’t read this sign-in from the Keychain. Allow access when macOS asks, or sign in again.'
            : 'Your sign-in expired. Sign in again to keep using this account.',
        );
        this.changed();
        throw new Error('expired');
      }
      if (r.account.planType) a.planType = r.account.planType;
      if (a.status !== 'ok') {
        this.setStatus(a, 'ok');
        this.changed();
      }
      return auth;
    })()
      .catch((error) => {
        throw current() ? error : loginChanged();
      })
      .finally(() => {
        if (this.refreshing.get(a.id) === owner) this.refreshing.delete(a.id);
      });
    owner.job = job;
    this.refreshing.set(a.id, owner);
    return job;
  }

  /** The app-server got a 401 with external tokens: refresh, or fail over to a healthy account. */
  /** @this {Accounts} */
  async answerRefresh(m) {
    const respond = (result) => this.server.send({ id: m.id, result });
    const cur = this.active();
    const current = cur ? this.usageRefresh.capture(cur.id) : () => true;
    const retired = () =>
      this.server.send({ id: m.id, error: { code: -32000, message: 'The login changed. Retry with the current sign-in.' } });
    try {
      if (!cur) throw new Error('no account');
      const tok = await this.tokens(cur, true);
      if (!current()) return retired();
      return respond({ accessToken: tok.accessToken, chatgptAccountId: tok.chatgptAccountId, chatgptPlanType: cur.planType ?? null });
    } catch (error) {
      if (!current()) return retired();
      // the current account can't refresh: try the other accounts below
      noteIgnored("refresh the active Codex account's sign-in", error);
    }
    // "Stop" (auto-switch off) keeps the lapsed login, as Claude's policy does (shared/switch.mjs)
    for (const next of this.state.autoSwitch ? this.candidates(cur) : []) {
      const candidateCurrent = this.usageRefresh.capture(next.id);
      try {
        const tok = await this.tokens(next);
        if (!current()) return retired();
        if (!candidateCurrent()) continue;
        // "Stop" chosen while the token was read
        if (!this.state.autoSwitch) break;
        this.state.active = next.id;
        this.applied = next.id;
        this.changed();
        this.notice({ kind: 'switched', reason: 'expired', from: cur?.email ?? null, to: next.email });
        return respond({ accessToken: tok.accessToken, chatgptAccountId: tok.chatgptAccountId, chatgptPlanType: next.planType ?? null });
      } catch (error) {
        if (!current()) return retired();
        // this candidate failed too: try the next; the loop falls through to an error reply
        noteIgnored('refresh another Codex account to move to', error);
      }
    }
    this.server.send({
      id: m.id,
      error: { code: -32000, message: 'Your sign-in expired. Sign in again in Settings → Accounts & billing.' },
    });
  }

  /** Headers for direct ChatGPT backend calls (dictation, cloud environments), as the active account. */
  /** @this {Accounts} */
  async chatgptHeaders() {
    const a = this.active();
    if (!a || (a.kind || 'chatgpt') !== 'chatgpt') return null;
    const current = this.usageRefresh.capture(a.id);
    try {
      const t = await this.tokens(a);
      if (!current()) return null;
      return { Authorization: `Bearer ${t.accessToken}`, 'ChatGPT-Account-Id': t.chatgptAccountId || '', 'User-Agent': 'codex_cli_rs' };
    } catch {
      return null;
    }
  }
}

module.exports = { AccountTokens, loginChanged };
