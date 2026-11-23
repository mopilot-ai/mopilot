// API-key and MoPilot account creation, replacement and provider-mode transitions on the shared account manager.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const crypto = require('node:crypto');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { readAuth, writeAuth, defaultHome } = require('./records.cjs');
const { SecretUnavailableError } = require('../../platform/secretFile.cjs');
const { sameLane } = require('../contract/switch.cjs');
const { codexInstance } = require('../drivers/codex.cjs');

/** @typedef {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} Accounts */

const DEFAULT_ID = 'default';

// These methods own no independent state; account identity, homes and pending operations belong to Accounts.
class AccountProviders {
  /** Where API-key traffic goes: the active key's own endpoint (a third-party gateway), else OpenAI. */
  /** @this {Accounts} */
  apiBase() {
    const a = this.active();
    return (a?.kind === 'apiKey' && a.baseUrl) || 'https://api.openai.com/v1';
  }

  /**
   * What a thread's own model provider needs when `a` (the active account) is an added API key: the key reaches Codex
   * through auth.command (identity/contract/codexProvider.cjs), never auth.json. Its own endpoint (MoPilot credits, a gateway),
   * else OpenAI's (#2201). Null for ChatGPT logins and the CLI's own key, which Codex reads from its own auth.json.
   * @this {Accounts}
   */
  providerInput(a = this.active()) {
    if (!a || a.kind !== 'apiKey' || a.id === DEFAULT_ID) return null;
    const key = readAuth(this.home(a))?.apiKey;
    const name = a.mopilot ? 'MoPilot' : a.baseUrl ? new URL(a.baseUrl).host : 'OpenAI';
    return key ? { account: a.id, baseUrl: a.baseUrl || 'https://api.openai.com/v1', name, key } : null;
  }

  /** Every added key's providerInput, so a thread that ran on one keeps its provider while another account is active (#2213). */
  /** @this {Accounts} */
  keyInputs() {
    return this.state.accounts.map((a) => this.providerInput(a)).filter((i) => !!i);
  }

  /**
   * Puts the app-server on API-key account `a`. An added key goes through its thread provider when that route is
   * ready (the key stored where auth-command reads it): nothing is sent, since every thread names the provider (start,
   * resume, fork), so the key is never written to disk (#2201). Otherwise (the CLI's own key, or no helper: not macOS)
   * the app-server logs in with it, which Codex saves to $CODEX_HOME/auth.json, the CLI's own sign-in; for an added
   * key that file is put back afterwards, whatever it held or even if it was not there (D-72).
   * @this {Accounts}
   */
  async applyKey(a, /** @type {string} */ apiKey) {
    if (a.id !== DEFAULT_ID && (await this.provideKey(this.providerInput(a)))) return;
    const file = path.join(defaultHome(), 'auth.json');
    const track = a.id !== DEFAULT_ID;
    const keep = track && fs.existsSync(file) ? fs.readFileSync(file) : null;
    try {
      await this.mainRequest('account/login/start', { type: 'apiKey', apiKey });
    } finally {
      if (track) {
        if (keep) writePrivate(file, keep);
        else fs.rmSync(file, { force: true });
      }
    }
  }

  /**
   * Adds an OpenAI API key as its own account (a private home with an auth.json), and switches to it.
   * With `replaceId` (an API-key account), that account's key and endpoint are replaced instead.
   */
  /** @this {Accounts} */
  async addApiKey(key, baseUrl = '', /** @type {string | null} */ replaceId = null) {
    key = key.trim();
    if (!key) throw new Error('Enter an API key');
    if (/\s/.test(key)) throw new Error('That doesn’t look like an API key');
    /** @type {string | null} */
    let base = null;
    if (baseUrl.trim()) {
      try {
        const u = new URL(baseUrl.trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0;
        base = u.toString().replace(/\/+$/, '');
      } catch {
        throw new Error('That endpoint isn’t a valid URL (expected something like https://host/v1)');
      }
    }
    const res = await fetch(`${base || 'https://api.openai.com/v1'}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => (noteIgnored('check a new API key', error), null));
    // offline or an endpoint that doesn't answer: the key is saved unchecked; only a clear 401 refuses it
    if (res && res.status === 401) throw new Error('OpenAI rejected that API key');
    // nothing is saved readable: without the OS key no folder or key is written
    if (!this.vault.available()) throw new SecretUnavailableError('the API key');
    const target = replaceId ? this.get(replaceId) : null;
    if (target && !this.removing.has(target.id) && target.kind === 'apiKey' && !target.mopilot && target.id !== DEFAULT_ID) {
      writeAuth(this.home(target), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }));
      Object.assign(target, { baseUrl: base, status: 'ok' });
      // the app-server holds the old key in memory: log it in again
      if (this.applied === target.id) this.applied = null;
      this.changed();
      return this.setMode('apiKey', target.id);
    }
    const existing = this.state.accounts.find(
      (a) =>
        !this.removing.has(a.id) &&
        a.kind === 'apiKey' &&
        !a.mopilot &&
        (a.baseUrl || null) === base &&
        readAuth(this.home(a))?.apiKey === key,
    );
    let acct = existing;
    if (!acct) {
      const id = crypto.randomUUID();
      const home = path.join(this.root, id);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      writeAuth(home, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }));
      acct = { id, kind: 'apiKey', email: null, planType: null, baseUrl: base, status: 'ok', addedAt: Date.now() };
      this.state.accounts.push(acct);
    }
    this.changed();
    return this.setMode('apiKey', acct.id);
  }

  /**
   * MoPilot credits for Codex: a managed API-key account whose endpoint is the MoPilot gateway and whose
   * key is this device's gateway key. Called with null on MoPilot sign-out, which removes it (and falls
   * back to a subscription if it was in use, else to nothing).
   */
  /** @this {Accounts} */
  async setMoPilotKey(key, baseUrl) {
    const id = 'mopilot';
    if (this.removing.has(id)) await this.removing.get(id);
    const cur = this.get(id);
    const home = path.join(this.root, id);
    if (!key) {
      if (!cur) return this.view();
      const wasActive = this.state.active === id;
      this.state.accounts = this.state.accounts.filter((a) => a.id !== id);
      fs.rmSync(home, { recursive: true, force: true });
      // chats put on MoPilot credits go back to the pool (as a removal does)
      this.forgetChats(id);
      if (wasActive) {
        // back to a subscription; pay-per-use is never taken up on its own, so with none nothing is active (D-73)
        const left = this.fallbackFor(cur);
        // chosen before switching: a failed switch restores this, never the account just removed
        if (left) this.state.active = left.id;
        if (left)
          await this.switchTo(left.id).catch((error) => {
            // switchTo restores the previous active account; the view is broadcast either way
            noteIgnored('switch Codex to the account left after MoPilot sign-out', error);
            this.changed();
          });
        else {
          await this.releaseMain();
          this.changed();
          this.notice({ kind: 'mopilotSignedOut' });
        }
      } else this.changed();
      // its key leaves the keychain last, unless a sign-in meanwhile put a new one there (CodexProviders orders the writes)
      if (!this.get(id))
        await Promise.resolve(this.forgetProvider?.(id)).catch((error) => noteIgnored('forget the MoPilot provider key', error));
      return this.view();
    }
    if (cur && readAuth(home)?.apiKey === key && cur.baseUrl === baseUrl) return this.view();
    if (!this.vault.available()) {
      // signed in to MoPilot, but its key can't be kept for Codex: say so rather than leave Codex without credits
      this.notice({ kind: 'loginFailed', error: 'Codex can’t use MoPilot credits: the system keychain is unavailable.' });
      throw new SecretUnavailableError('the MoPilot key');
    }
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    writeAuth(home, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: key }));
    if (cur) Object.assign(cur, { baseUrl, status: 'ok' });
    else
      this.state.accounts.push({
        id,
        kind: 'apiKey',
        mopilot: true,
        email: null,
        planType: null,
        baseUrl,
        status: 'ok',
        addedAt: Date.now(),
      });
    if (this.state.active === id) {
      this.applied = null; // the key changed under the active account: log the app-server in again
      // applied stays null, so the next reconnect logs the app-server in with the new key
      await this.apply().catch((error) => noteIgnored('use a new MoPilot key for Codex', error));
    }
    this.changed();
    return this.view();
  }

  /**
   * What becomes active when `left` stops being it (removed, signed out, MoPilot signed out), or stands in for an
   * unknown active id: another subscription only. A signed-in one before a lapsed one (which asks to sign in again),
   * one not out of usage first, then the one the user last chose, then the least used. Never an API key or credits,
   * which bill per use and are the user's choice (shared/switch.mjs). Null: nothing to take up on its own.
   * @this {Accounts}
   */
  fallbackFor(left) {
    const rank = (a) => Number(a.status !== 'ok') * 4 + Number(this.limited(a)) * 2 - Number(a.id === this.state.lastSubscription);
    return (
      this.subscriptions()
        .filter((a) => a !== left && !this.removing.has(a.id))
        .sort((x, y) => rank(x) - rank(y) || (x.limits?.used ?? 0) - (y.limits?.used ?? 0))[0] ?? null
    );
  }

  /**
   * Nothing is active any more: the main app-server lets go of the account it held. Its logout deletes the CLI's own
   * sign-in ($CODEX_HOME/auth.json), which is put back as it was; the user picks what runs next.
   * @this {Accounts}
   */
  async releaseMain() {
    this.state.active = null;
    this.applied = null;
    const file = path.join(defaultHome(), 'auth.json');
    const keep = fs.existsSync(file) ? fs.readFileSync(file) : null;
    try {
      await this.mainRequest('account/logout', {});
    } catch (error) {
      // best effort: the account has left the pool either way
      noteIgnored('sign Codex out of the account that left', error);
    } finally {
      if (keep) writePrivate(file, keep);
    }
    this.mainMode = 'managed';
  }

  /**
   * Whether a chat may be put on `to`: only within the billing lane of the account it is on (shared/switch.mjs). The
   * window offers no other; main refuses one.
   * @this {Accounts}
   */
  inChatLane(threadId, to) {
    // the chat's account as the window sees it: a live pin (view().chatAccounts), else the active account
    const on = this.get(this.view().chatAccounts[threadId]?.id) || this.active();
    return !on || sameLane(codexInstance(on, null), codexInstance(to, null));
  }

  /** Chats put on an account that is going go back to the pool: saved pins and live ones (the view lists both). */
  /** @this {Accounts} */
  forgetChats(id) {
    for (const [t, pid] of Object.entries(this.state.chatPins || {})) if (pid === id) delete this.state.chatPins[t];
    for (const [t, p] of this.pins) if (p.id === id) this.pins.delete(t);
  }

  /** Subscription / API key / MoPilot switch: remembers the ChatGPT account it left, so switching back returns to it. */
  /** @this {Accounts} */
  async setMode(mode, /** @type {string | null} */ apiId = null) {
    const cur = this.active();
    if (mode === 'mopilot') {
      if (!this.get('mopilot')) throw new Error('Sign in to MoPilot first');
      if (cur && (cur.kind || 'chatgpt') === 'chatgpt') this.state.lastSubscription = cur.id;
      return this.switchTo('mopilot');
    }
    if (mode === 'apiKey') {
      const a = (apiId && this.get(apiId)) || this.state.accounts.find((x) => x.kind === 'apiKey' && !x.mopilot);
      if (!a) throw new Error('Add an API key first');
      if (cur && (cur.kind || 'chatgpt') === 'chatgpt') this.state.lastSubscription = cur.id;
      return this.switchTo(a.id);
    }
    const ok = this.state.accounts.filter((x) => (x.kind || 'chatgpt') === 'chatgpt' && x.status === 'ok');
    const a = ok.find((x) => x.id === this.state.lastSubscription) || ok[0];
    if (!a) throw new Error('Sign in with ChatGPT first');
    return this.switchTo(a.id);
  }
}

module.exports = { AccountProviders, DEFAULT_ID };
