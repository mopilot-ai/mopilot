// The extension settings page's name and Site permissions (#1986): this Chrome's name on its pairing, and the sites Chrome's site table saved, with Revoke, at main's own owners.
const { chromeName } = require('./chromeRelay.cjs');

/**
 * Reads, and with `p.name` or `p.revoke` first changes, this Chrome's settings. Revoke only lowers access: a site the
 * extension names that isn't saved is refused, and nothing here can allow one.
 * @param {{ setup: any, grants: any }} live setup: the Chrome relay's (setupChromeRelay); grants: Chrome's site table
 * @param {{ name?: unknown, revoke?: unknown }} p
 */
function browserSettings({ setup, grants }, p) {
  if (setup?.kind !== 'extension' || !setup.pairing || !grants) throw new Error("MoPilot isn't serving this Chrome.");
  if (p.name !== undefined) setup.pairing.rename(p.name);
  if (p.revoke !== undefined) {
    if (typeof p.revoke !== 'string' || !grants.list().some((/** @type {any} */ r) => r.origin === p.revoke))
      throw new Error('That site is no longer saved.');
    grants.set(p.revoke, null);
  }
  return { name: chromeName(setup.pairing), sites: grants.list() };
}

module.exports = { browserSettings };
