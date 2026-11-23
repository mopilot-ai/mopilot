// Consent reconciliation stays available in the public app independently of optional reporting.
const { shareUsageDataEnabled } = require('../../shared/usageData.mjs');
/** Consent reconciliation is account behavior even without an observer. */
function mergeConsent(local, account) {
  const acct = typeof account === 'boolean' ? account : null;
  const loc = typeof local === 'boolean' ? local : null;
  const value = shareUsageDataEnabled(loc) && shareUsageDataEnabled(acct);
  return { value, put: value !== acct, write: value !== loc };
}

module.exports = { mergeConsent };
