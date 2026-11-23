// The site risk check MoMo's always-allowed sites use (#3655, electron/momo/sentinelSites.cjs): whether a URL's site is one MoMo never opens without asking after a private read. Kept here, where the app composes MoMo with the browser's site risk, since electron/momo doesn't import electron/capabilities.
const { classify, isLoopbackHost } = require('../capabilities/browser/siteRisk.cjs');

/** Not a normal site (siteRisk.cjs: blocked, high risk, private network), no host, or loopback (normal for local development, but a local service is no site to always allow). */
function riskyUnasked(/** @type {unknown} */ url) {
  const r = classify(url);
  return r.level !== 'normal' || !r.host || isLoopbackHost(r.host);
}

module.exports = { riskyUnasked };
