// The Codex CLI's own sign-in ($CODEX_HOME/auth.json) as the pool's "default" record, kept in step with that file, and
// folded into an added account that is the same server account (#1312): one account is one record in the pool.
const { readAuth, defaultHome } = require('./records.cjs');
const { AccountProviders, DEFAULT_ID } = require('./providers.cjs');
const { codexServerId } = require('../contract/sameAccount.cjs');

/** @typedef {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} Accounts */

// These methods own no independent state: the records, pins and the login in use belong to Accounts. `same` (the CLI
// login folded into an added account, for the view) is derived again at every sync.
class AccountCliLogin extends AccountProviders {
  /**
   * Keeps the "default" record in step with $CODEX_HOME/auth.json (the CLI's own sign-in). When that sign-in is an
   * account already added and signed in (its token names the same workspace and member), and not being removed, the
   * added record stands for it: the CLI login is not listed again, and what was on it (the login in use, chats) moves
   * to that record.
   * @this {Accounts}
   */
  syncDefault() {
    const auth = readAuth(defaultHome());
    let d = this.get(DEFAULT_ID);
    const key = auth?.kind === 'chatgpt' ? codexServerId(auth) : null;
    const into =
      key &&
      this.state.accounts.find(
        (a) => a.id !== DEFAULT_ID && a.status !== 'expired' && !this.removing.has(a.id) && codexServerId(a) === key,
      );
    /** @type {Record<string, string>} the folded login id -> the record shown for it */
    this.same = into ? { [DEFAULT_ID]: into.id } : {};
    if (into) {
      this.state.accounts = this.state.accounts.filter((a) => a !== d);
      if (this.state.active === DEFAULT_ID) this.state.active = into.id;
      for (const p of this.pins.values()) if (p.id === DEFAULT_ID) p.id = into.id;
      for (const [t, id] of Object.entries(this.state.chatPins ?? {})) if (id === DEFAULT_ID) this.state.chatPins[t] = into.id;
      return;
    }
    if (!auth) {
      if (d) this.state.accounts = this.state.accounts.filter((a) => a !== d);
      if (this.state.active === DEFAULT_ID) this.state.active = this.fallbackFor(d)?.id ?? DEFAULT_ID; // a subscription, never a key
      return;
    }
    if (!d) {
      d = { id: DEFAULT_ID, status: 'ok', addedAt: Date.now() };
      this.state.accounts.unshift(d);
    }
    d.kind = auth.kind;
    if (auth.kind === 'chatgpt') {
      // A different login replaced the CLI's account: its old usage no longer applies.
      if (d.chatgptAccountId && codexServerId(d) !== key) this.forgetUsage(d);
      Object.assign(d, { email: auth.email, planType: auth.planType || d.planType, chatgptAccountId: auth.chatgptAccountId });
    } else Object.assign(d, { email: null, planType: null, chatgptAccountId: null, status: 'ok' });
    // with nothing chosen, only a ChatGPT sign-in of the CLI's own is taken up: a key is the user's choice
    if (!this.get(this.state.active) && (this.state.active !== null || auth.kind === 'chatgpt')) this.state.active = DEFAULT_ID;
  }

  /**
   * Whether the background poll has work: usage to compare across subscriptions, or a CLI login folded into an added
   * account, whose sign-in changing outside MoPilot only a re-read (refreshUsage → syncDefault) lists again.
   * @this {Accounts}
   */
  polls() {
    return this.subscriptions().length > 1 || Object.keys(this.same).length > 0;
  }
}

module.exports = { AccountCliLogin };
