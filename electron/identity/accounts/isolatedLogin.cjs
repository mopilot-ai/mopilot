// How MoMo's Codex app-server signs in (#2308, harness/codexIsolatedServer.cjs): to the account the main one runs on now,
// with that account's current tokens (external tokens, so nothing is written to MoMo's home). An API-key account is not
// signed in there: Codex would keep the key in MoMo's home, and a key's threads carry their own provider
// (identity/contract/codexProvider.cjs). Its later sign-ins follow the main one's, and the account relay still picks each
// thread's account.
const { readAuth } = require('./records.cjs');

/**
 * The account/login/start params for the active Codex account, or null when none is chosen or it is an API key.
 * @param {InstanceType<typeof import('../codexAccounts.cjs').Accounts>} accounts
 * @returns {Promise<object | null>}
 */
async function isolatedLogin(accounts) {
  const a = accounts.active();
  if (!a) return null;
  const auth = readAuth(accounts.home(a));
  if (auth?.kind === 'apiKey') return null;
  const tok = await accounts.tokens(a);
  return {
    type: 'chatgptAuthTokens',
    accessToken: tok.accessToken,
    chatgptAccountId: tok.chatgptAccountId,
    chatgptPlanType: a.planType ?? null,
  };
}

module.exports = { isolatedLogin };
