// Loaded into the app's main process before it starts (Electron's -r) in every E2E launch: shell.openExternal records the
// URL instead of opening it, so no spec opens a browser or System Settings on the machine it runs on (an idle computer-use
// helper is quit before a privacy pane opens and main opens the pane itself, #2541). tests/e2e/fixtures/externalUrls.ts
// reads the URLs back.

/** @param {{ shell: { openExternal: (url: string) => Promise<void> } }} electron */
function recordExternal({ shell }) {
  /** @type {any} */ (globalThis).__opened = [];
  shell.openExternal = async (url) => {
    // fixtures/externalUrls.ts refuseExternal: a refusal is rejected as Electron rejects an URL the system will not open
    const refusal = /** @type {any} */ (globalThis).__openRefusal;
    if (refusal) throw new Error(refusal);
    /** @type {any} */ (globalThis).__opened.push(url);
  };
}

module.exports = { recordExternal };
// the app's main process (Electron's -r): child processes that load this file get nothing
if (process.type === 'browser') recordExternal(require('electron'));
