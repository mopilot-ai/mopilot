// How a Claude Code session is paid for, and what to tell the user when its credential is refused: the rules the
// identity driver (drivers/claude.cjs) and the Claude harness (harness/claude) both read, so the label a chat shows
// and the account list agree.
const { providerFor, PROVIDERS } = require('./registry.cjs');

/** Billing of a CLI login, from `claude auth status`'s authMethod. */
const loginBilling = (authMethod) => (/api.?key|console/i.test(authMethod ?? '') ? 'apiKey' : 'subscription');

/**
 * How the CLI is being paid for right now. MoPilot credits, a key on a third-party endpoint and the user's own
 * provider through MoPilot's model router are not the user's subscription even though `claude auth status` reports a
 * login (with ANTHROPIC_AUTH_TOKEN set it says oauth_token); a Console API key is pay per use.
 * @param {'subscription'|'apiKey'|'mopilot'|'routed'} mode Sage's key mode
 * @param {string|null} [baseUrl] the key's endpoint (apiKey mode)
 * @param {string|null} [authMethod] the CLI's login, as `claude auth status` reports it
 * @param {boolean} [cloud] the shell's cloud-provider variables are passed through
 * @returns {{ mode: 'subscription'|'apiKey'|'mopilot'|'routed', provider: string, label: string }}
 */
function claudeBilling(mode, baseUrl, authMethod, cloud = false) {
  // The shell's cloud-provider variables (opt-in, D-35): the user's cloud account pays, whatever the key mode says.
  if (cloud) return { mode: 'apiKey', provider: 'cloud', label: 'API key · your cloud account' };
  if (mode === 'mopilot') return { mode: 'mopilot', provider: PROVIDERS.mopilot.id, label: 'MoPilot credits' };
  if (mode === 'routed') return { mode: 'routed', provider: PROVIDERS.routed.id, label: PROVIDERS.routed.label };
  if (mode === 'apiKey') {
    const p = providerFor(baseUrl, 'anthropic');
    return { mode: 'apiKey', provider: p.id, label: p.firstParty ? 'API key' : `API key · ${p.label}` };
  }
  if (loginBilling(authMethod) === 'apiKey') return { mode: 'apiKey', provider: PROVIDERS.anthropic.id, label: 'API key' };
  return { mode: 'subscription', provider: PROVIDERS.anthropic.id, label: 'Subscription' };
}

/**
 * What to tell the user when the credential the CLI runs on was refused. Only a credential MoPilot passes
 * on (a key, MoPilot credits) or the shell's cloud account is named here: signing in to the CLI fixes none of them.
 * null for the CLI's own login (a subscription or a Console login), which signing in again does fix.
 * @param {'subscription'|'apiKey'|'mopilot'|'routed'} mode Sage's key mode
 * @param {string|null} [baseUrl] the key's endpoint (apiKey mode)
 * @param {boolean} [cloud] the shell's cloud-provider variables are passed through
 * @returns {string|null}
 */
function rejectedCredential(mode, baseUrl, cloud = false) {
  if (cloud) return "Your cloud provider refused Claude Code's credentials. Check the cloud-provider variables your shell exports.";
  if (mode === 'mopilot') return "MoPilot refused this device's credits key. Sign out of MoPilot and sign in again.";
  if (mode === 'routed')
    return 'Your own provider refused the key for this model config. Check it under Settings → Accounts & billing → Providers & models.';
  if (mode !== 'apiKey') return null;
  const p = providerFor(baseUrl, 'anthropic');
  return p.firstParty
    ? 'Anthropic rejected this API key. Check it and try again.'
    : `${p.label} rejected this API key. Check the key and its endpoint, then try again.`;
}

module.exports = { loginBilling, claudeBilling, rejectedCredential };
