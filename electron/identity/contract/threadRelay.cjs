// The account relay's addresses on a Codex thread request: the one piece of the relay (accounts/relayConfig.cjs) the
// harness's connection applies to each thread/start, resume and fork.
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');

/**
 * A thread/start, resume or fork request's params with the relay's addresses in its config (`config`, from
 * startRelay): they reach the app-server over stdin, never on its command line. Keys the request sets itself win.
 * @param {any} params @param {Record<string, string> | null | undefined} config
 */
function withRelay(params, config) {
  const p = params || {};
  if (!config) return p;
  return { ...p, config: { ...config, ...(isJsonRecord(p.config) ? p.config : {}) } };
}

module.exports = { withRelay };
