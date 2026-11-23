// The app's call for file search in a chat's folder on a machine (the Host's `fs.search`, host/src/hostSearch.mjs), for the @ popup of a Host chat: the request is checked here before it is sent, a Host from before the method is told to update, and what comes back is read strictly (strings only, bounded) so a Host cannot make the window draw more than it asked for.
const { HostError } = require('./interface.cjs');
const { parseParams } = require('../../shared/host/schema.mjs');
const { MAX_SEARCH } = require('../../shared/host/readSchema.mjs');

/** A search is one listing on the machine, which gives up on its own after 10 seconds. */
const SEARCH_MS = 20_000;
/** The longest path a result may have. */
const MAX_PATH = 1000;

/** The files the Host found, or null when it sent something else. @param {any} v */
function readFound(v) {
  if (!Array.isArray(v?.files) || v.files.length > MAX_SEARCH) return null;
  if (!v.files.every((/** @type {unknown} */ f) => typeof f === 'string' && f.length > 0 && f.length <= MAX_PATH)) return null;
  return { files: /** @type {string[]} */ ([...v.files]), truncated: v.truncated === true };
}

/** @param {{ withSession: (hostId: string, fn: (s: { call: (method: string, params: object, opts?: { timeoutMs?: number }) => Promise<any> }) => Promise<any>) => Promise<any> }} o */
function createFolderSearch({ withSession }) {
  /**
   * The files in `path` on the machine whose names match `query`, best first, paths relative to that folder. A Host from before this method answers `host_outdated`; refusals carry the Host's `code` (`outside_roots`, `directory_missing`, …).
   * @param {string} hostId @param {{ path: string, query: string, limit?: number }} q
   * @returns {Promise<{ files: string[], truncated: boolean }>}
   */
  return async function search(hostId, q) {
    const params = parseParams('fs.search', q);
    return withSession(hostId, async (s) => {
      let reply;
      try {
        reply = await s.call('fs.search', params, { timeoutMs: SEARCH_MS });
      } catch (e) {
        if (/^Unknown method/.test(String(/** @type {any} */ (e)?.message)))
          throw new HostError('host_outdated', 'Update the Host on that machine to search its files.');
        throw e;
      }
      const out = readFound(reply);
      if (!out) throw new HostError('invalid', 'The Host sent a file list this app cannot read.');
      return out;
    });
  };
}

module.exports = { createFolderSearch, readFound };
