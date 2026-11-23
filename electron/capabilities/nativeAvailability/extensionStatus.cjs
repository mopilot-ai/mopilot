// The settings row for MoPilot's own Chrome extension (#1632): its state, install link and Pair, from the capability health record.

/** Opens MoPilot's own extension's pairing page in the user's Chrome now (#1632). */
const PAIR = { kind: 'chromePair', label: 'Connect' };
/** What MoPilot's own extension's row shows for each state of its health (capabilityHealth.cjs chromeRelayHealth). */
const EXTENSION_ROWS = Object.assign(Object.create(null), {
  'chrome.install': { state: 'permissions', label: 'Not installed', pair: false },
  'chrome.extensionOff': { state: 'permissions', label: 'Off in Chrome', pair: false },
  'chrome.pair': { state: 'permissions', label: 'Not connected', pair: true },
  'chrome.allow': { state: 'permissions', label: 'Waiting for your OK', pair: false },
  'chrome.connect': { state: 'unknown', label: 'Not connected', pair: true },
});

/**
 * MoPilot's own Chrome extension: one row for every harness that reaches the user's Chrome through it, with its
 * install link and Pair (#1632). Null where main doesn't serve the extension (the relay, or no channel at all).
 * @param {(import('../capabilityHealth.cjs').SurfaceHealth & { channel?: string, name?: string }) | undefined} h the health record's chromeRelay
 */
function extensionStatus(h) {
  if (!h || h.channel !== 'extension') return null;
  // connected: as the Chrome the user named (Name this Chrome), when they named it
  if (h.state === 'ready')
    return { state: 'mopilot', label: h.name ? `Connected as ${h.name}` : 'Connected', detail: null, reasonCode: undefined, actions: [] };
  const row = EXTENSION_ROWS[String(h.reasonCode)];
  if (!row) return { state: 'unavailable', label: 'Unavailable', detail: h.reason, actions: [], reasonCode: h.reasonCode };
  return {
    state: row.state,
    label: row.label,
    detail: h.reason,
    reasonCode: h.reasonCode,
    actions: [...(h.fix ? [h.fix] : []), ...(row.pair ? [PAIR] : [])],
  };
}

module.exports = { extensionStatus };
