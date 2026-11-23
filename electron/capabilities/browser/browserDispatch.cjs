// The final browser-command boundary: attachment, live action/document ownership, and dispatch receipts.
const { ToolError } = require('../contract/registry.cjs');
const { untilHung } = require('./pageHang.cjs');
const { unresponsiveNote } = require('../../../shared/browserNotice.mjs');
const { assertBrowserDispatch, waitForCredentialDocument } = require('./credentialDocument.cjs');

// A crashed page answers nothing but the way back to a page: a command that needs its renderer fails at once with
// "crashed, reload it" (for every harness: MoPilot's own browser_* tools and the Codex plugin's CDP calls alike),
// instead of waiting until the hang check calls the page busy and tells the agent not to retry (E-P5d, CM-L16a).
// Chromium's view-dependent emulation commands could also crash the app on a gone renderer.
// The way back to a page goes: navigation, targets, and a domain's enable/disable (a client's own reload sequence).
const RECOVERS = new Set(['Page.reload', 'Page.navigate', 'Page.navigateToHistoryEntry', 'Page.getNavigationHistory', 'Page.stopLoading']);
// a destroyed webContents (its tab closed) throws on every member but isDestroyed: it is gone, not crashed
const rendererGone = (wc) => !wc.isDestroyed?.() && typeof wc.isCrashed === 'function' && wc.isCrashed();
const CRASHED = 'This page crashed. Reload it (or open its address again) before continuing.';

/**
 * Throws "crashed, reload it" for a command a crashed page cannot answer. One guard for every way a page's CDP is
 * sent (Tab.send here, the legacy panel tools in cdp.cjs), since the hang check no longer looks at a crashed page.
 * @param {any} wc @param {unknown} method
 */
function refuseCrashed(wc, method) {
  const m = String(method);
  if (rendererGone(wc) && !RECOVERS.has(m) && !m.startsWith('Target.') && !/\.(?:enable|disable)$/.test(m))
    throw new ToolError(CRASHED, 'page_crashed');
}

/**
 * A `.catch` for a command sent to a page: when the renderer went while the command ran (a navigation still loading),
 * the debugger's bare "Target crashed" becomes the same way back as a page that had already crashed (#1617). An error
 * MoPilot already explained (a ToolError: the tab closed, the credential document changed) and any other failure
 * are passed on as they were.
 * @param {any} wc
 */
const crashedMidCommand = (wc) => (/** @type {unknown} */ error) => {
  if (!(error instanceof ToolError) && rendererGone(wc)) throw new ToolError(CRASHED, 'page_crashed');
  throw error;
};

/** A receipt runs only after dispatch, never while waiting for attachment or during world setup. */
function dispatch(wc, method, params, sessionId, onDispatch) {
  if (wc.debugger.sendGuardedCommand) return wc.debugger.sendGuardedCommand(method, params, sessionId, onDispatch);
  assertBrowserDispatch(wc);
  const sent = sessionId ? wc.debugger.sendCommand(method, params, sessionId) : wc.debugger.sendCommand(method, params);
  onDispatch?.();
  return sent;
}

/** Send on a Tab; callers outside a credential request retain the ordinary action and renderer checks. */
async function sendTabCommand(tab, method, params, sessionId, onDispatch) {
  assertBrowserDispatch(tab.backend);
  await tab.attach();
  tab.check();
  assertBrowserDispatch(tab.backend);
  refuseCrashed(tab.backend, method);
  return waitForCredentialDocument(tab.backend, () =>
    untilHung(
      tab.host.o.hang,
      tab.backend,
      () => dispatch(tab.backend, method, params, sessionId, onDispatch),
      () => new ToolError(unresponsiveNote(tab.id), 'page_unresponsive'),
    ),
  ).catch(crashedMidCommand(tab.backend));
}

module.exports = { sendTabCommand, rendererGone, refuseCrashed, crashedMidCommand };
