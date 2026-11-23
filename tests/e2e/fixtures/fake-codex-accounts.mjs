// The fake Codex app-server's sign-in: account/read, account/login/start and account/logout, and the turns a login
// can't serve (a usage limit, a 401 whose token refresh fails), as the real app-server reports them.
// FAKE_CODEX_AUTH=signed-out starts without an account: account/login/start (chatgpt) answers an auth URL and completes
// the login by itself; an API key signs in at once; account/logout signs out.
// FAKE_CODEX_LOGIN_EMAIL and FAKE_CODEX_LOGIN_ACCOUNT set who a ChatGPT login signs in as (fake-user@example.test,
// acct-fake by default; account/read answers that email too), so a test can sign an account in again as itself.
// FAKE_CODEX_AUTH=api-key starts signed in with an OpenAI API key (account/read answers type apiKey).
// "USAGELIMIT" in a prompt ends the turn on a usage limit (codexErrorInfo usageLimitExceeded) while the app-server runs
// as the CLI's own login ($CODEX_HOME/auth.json's account); once the client hands it another account's tokens
// (account/login/start chatgptAuthTokens) the same prompt runs as usual. "AUTHEXPIRED" asks the client for fresh tokens
// (account/chatgptAuthTokens/refresh), as the app-server does on a 401: an error answer ends the turn as unauthorized.
// A ".fake-expired" file in $CODEX_HOME is a sign-in that can't be refreshed: account/read with refreshToken has no account.
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} home $CODEX_HOME
 * @param {(method: string, params: object) => void} notify
 * @param {(method: string, params: object, timeoutMs?: number) => Promise<any>} ask a request to the client
 */
export function createFakeCodexAccounts(home, notify, ask) {
  const auth = {
    in: process.env.FAKE_CODEX_AUTH !== 'signed-out',
    /** the account whose tokens the client handed over (chatgptAuthTokens), or null while it runs as the CLI's own login */
    tokensFor: null,
    /** the CLI's own login: $CODEX_HOME/auth.json's account */
    own() {
      try {
        return JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens?.account_id ?? null;
      } catch {
        return null;
      }
    },
    // a login leaves $CODEX_HOME/auth.json behind, as the real one does (the accounts list reads it)
    save(on) {
      this.in = on;
      const file = path.join(home, 'auth.json');
      if (!on) return fs.rmSync(file, { force: true });
      const account = process.env.FAKE_CODEX_LOGIN_ACCOUNT || 'acct-fake';
      const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_plan_type: 'plus' } };
      const jwt = (c) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.x`;
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: jwt({ ...claims, exp: 4e9 }),
            id_token: jwt({ ...claims, email: process.env.FAKE_CODEX_LOGIN_EMAIL || 'fake-user@example.test' }),
            refresh_token: 'fake',
            account_id: account,
          },
        }),
      );
    },
  };

  const handlers = {
    'account/read': (p) => ({
      account:
        !auth.in || (p.refreshToken && fs.existsSync(path.join(home, '.fake-expired')))
          ? null
          : process.env.FAKE_CODEX_AUTH === 'api-key'
            ? { type: 'apiKey' }
            : { type: 'chatgpt', email: process.env.FAKE_CODEX_LOGIN_EMAIL || 'fake-user@example.test', planType: 'plus' },
      requiresOpenaiAuth: true,
      workspaceRouting: null,
    }),
    // a ChatGPT login completes by itself shortly after its URL is handed out; any other kind signs in at once
    'account/login/start': (p) => {
      // tokens the client supplies stay in the app-server's memory, as the real one does: $CODEX_HOME/auth.json keeps the CLI's own login
      if (p.type === 'chatgptAuthTokens') return (auth.in = true), (auth.tokensFor = p.chatgptAccountId ?? null), { type: p.type };
      if (p.type !== 'chatgpt') return auth.save(true), { type: p.type };
      setTimeout(() => {
        auth.save(true);
        notify('account/login/completed', { loginId: 'login-1', success: true, error: null });
        notify('account/updated', { authMode: 'chatgpt', planType: 'plus' });
      }, 100);
      return { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.example.test/codex' };
    },
    'account/logout': () => {
      auth.save(false);
      setImmediate(() => notify('account/updated', { authMode: null, planType: null }));
      return {};
    },
  };

  /** The error a prompt's turn ends on because of its login (USAGELIMIT, AUTHEXPIRED), or null to run it as usual. */
  async function turnRefusal(text) {
    if (text.includes('USAGELIMIT') && (auth.tokensFor ?? auth.own()) === auth.own())
      return { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null, misalignment: null };
    if (!text.includes('AUTHEXPIRED')) return null;
    const res = await ask('account/chatgptAuthTokens/refresh', { reason: 'unauthorized', previousAccountId: auth.tokensFor }, 30_000);
    if (res?.result) {
      auth.tokensFor = res.result.chatgptAccountId ?? auth.tokensFor;
      return null;
    }
    const message = res?.error?.message ?? 'Your access token could not be refreshed.';
    return { message, codexErrorInfo: 'unauthorized', additionalDetails: null, misalignment: null };
  }

  return { handlers, turnRefusal };
}
