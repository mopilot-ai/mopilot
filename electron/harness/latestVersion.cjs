// The newest version of a harness CLI where its install would update from: npm's registry for a package, Homebrew
// for a formula or cask (as Homebrew last updated itself, without updating it now). Each answer is kept 6 hours (a
// failure 15 minutes, the last good answer kept meanwhile), and callers asking at once share one request.
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');

const OK_MS = 6 * 3600_000;
const FAIL_MS = 15 * 60_000;
const NPM_TIMEOUT_MS = 8_000;
const BREW_TIMEOUT_MS = 15_000;

/** The first version in a text ("2.1.302", "v0.21.0", "1.2.3,build" -> "1.2.3"), or null. */
function parseVersion(text) {
  const m = /(?:^|[^\w.])v?(\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)/.exec(` ${String(text ?? '')}`);
  return m ? m[1].replace(/\.$/, '') : null;
}

/**
 * @param {{
 *   fetchJson: (url: string, timeoutMs: number) => Promise<unknown>,
 *   brewInfo: (brew: string, name: string, cask: boolean, timeoutMs: number) => Promise<unknown>,
 *   now?: () => number,
 *   registry?: string,
 * }} o
 */
function createLatest(o) {
  const now = o.now ?? (() => clock.now());
  const registry = o.registry ?? 'https://registry.npmjs.org/';
  /** @type {Map<string, { value: string | null, until: number, pending: Promise<string | null> | null }>} */
  const memo = new Map();

  /** The answer for `key`: kept while fresh, else asked once however many wait for it. */
  function get(key, ask) {
    const e = memo.get(key) ?? { value: null, until: 0, pending: null };
    memo.set(key, e);
    if (e.pending) return e.pending;
    if (now() < e.until) return Promise.resolve(e.value);
    e.pending = ask()
      .then((v) => {
        if (!v) throw new Error('no version in the answer');
        e.value = v;
        e.until = now() + OK_MS;
        return v;
      })
      .catch((error) => {
        noteIgnored(`read the newest version (${key})`, error);
        e.until = now() + FAIL_MS;
        return e.value;
      })
      .finally(() => {
        e.pending = null;
      });
    return e.pending;
  }

  /** npm's `latest` for a package. */
  const npm = (pkg) =>
    get(`npm:${pkg}`, async () => {
      const r = /** @type {{ version?: unknown }} */ (await o.fetchJson(`${registry}${pkg}/latest`, NPM_TIMEOUT_MS));
      return typeof r?.version === 'string' ? parseVersion(r.version) : null;
    });

  /** What `brew upgrade` would install for a formula or cask. */
  const brew = (brewBin, name, cask) =>
    get(`brew:${cask ? 'cask:' : ''}${name}`, async () => {
      const r = /** @type {{ formulae?: { versions?: { stable?: unknown } }[], casks?: { version?: unknown }[] }} */ (
        await o.brewInfo(brewBin, name, cask, BREW_TIMEOUT_MS)
      );
      const v = cask ? r?.casks?.[0]?.version : r?.formulae?.[0]?.versions?.stable;
      return typeof v === 'string' ? parseVersion(v.split(',')[0]) : null;
    });

  /** Ask again next time (after an update, which may have updated Homebrew first). */
  const forget = (key) => {
    const e = memo.get(key);
    if (e && !e.pending) memo.delete(key);
  };
  return { npm, brew, forget, keyOf: (via, pkg, cask) => (via === 'brew' ? `brew:${cask ? 'cask:' : ''}${pkg}` : `npm:${pkg}`) };
}

module.exports = { createLatest, parseVersion, OK_MS, FAIL_MS };
