// What Codex's config.toml, its top level and its active profile, says about the account relay: whether it points Codex at an endpoint or provider of its own (the relay then stays out) and whether it sets its own realtime endpoints; and the relay's addresses added to a thread's config.
const os = require('node:os');
const { HARNESS_ROUTES } = require('../../../shared/harnessRoutes.mjs');
const { resolve, withOverlays } = require('../../../shared/route.mjs');
const { readRouteDocs } = require('../../harness/routeReader.cjs');
const { withRelay } = require('../contract/threadRelay.cjs');

/** @returns {Promise<{ own: boolean, customRealtime: boolean, customSideband: boolean }>} */
async function relayConfig({ env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const info = HARNESS_ROUTES.codex;
  const { docs } = await readRouteDocs(info, { env, home, platform });
  // a config.toml Codex can't parse leaves the relay as it was: nothing custom is configured
  const d = withOverlays(info.files, docs);
  const has = (key) => !!resolve(`config:${key}`, d);
  const provider = resolve('config:model_provider', d)?.value;
  return {
    own: has('openai_base_url') || (!!provider && provider !== 'openai'),
    customRealtime: has('experimental_realtime_webrtc_call_base_url'),
    customSideband: has('experimental_realtime_ws_base_url'),
  };
}

/**
 * Starts the account relay for `accounts` and returns the config that routes a thread's model traffic through it (the
 * app-server's threadConfig, sent with every thread/start, resume and fork), or null. Skipped when config.toml (or its
 * active profile) points Codex at its own endpoint or provider, or SAGE_NO_RELAY is set.
 * @param {any} accounts the account manager (electron/identity/codexAccounts.cjs): relay, relaySkipped
 * @param {typeof import('./relay.cjs').Relay} Relay
 * @returns {Promise<Record<string, string> | null>}
 */
async function startRelay(accounts, Relay) {
  if (process.env.SAGE_NO_RELAY) return null;
  const { own, customRealtime, customSideband } = await relayConfig();
  // the harness route says pooling is off while Codex goes to an endpoint of its own (electron/harness/routeProcesses.cjs)
  accounts.relaySkipped = own;
  if (own) return null;
  try {
    const relay = new Relay(accounts);
    accounts.relay = relay;
    const base = await relay.start();
    return {
      openai_base_url: base,
      // Keep voice in the same account pool without changing model/API-key traffic.
      ...(!customRealtime ? { experimental_realtime_webrtc_call_base_url: /** @type {string} */ (relay.realtimeBase) } : {}),
      // The sideband must use the same account as call creation. A custom call endpoint keeps its own sideband configuration, too.
      ...(!customRealtime && !customSideband
        ? { experimental_realtime_ws_base_url: /** @type {string} */ (relay.realtimeSidebandBase) }
        : {}),
    };
  } catch {
    accounts.relay = null;
    return null;
  }
}

module.exports = { relayConfig, startRelay, withRelay };
