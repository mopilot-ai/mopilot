// Whether a built-in browser page asks for a credential (a password or one-time-code field), read in the page, its same-origin frames and
// every frame with its own CDP session (another site's sign-in widget, as stores embed one). The hand-off's copy and the GIF recorder's
// skip both decide by it, so a sign-in form in a cross-origin frame counts everywhere.
const { withTimeout } = require('./hostUtil.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How long a probe may take: a hung page must never hold a hand-off (which returns at once) or a recording. */
const PROBE_MS = 1500;

/** A document with a credential field in it or in a same-origin frame of it (bounded depth); a frame of another site is read by its own session. */
const CREDENTIAL_FIELD = `((d) => {
  const q = 'input[type=password],input[autocomplete~=one-time-code],input[autocomplete~=current-password],input[autocomplete~=new-password]';
  const seek = (doc, depth) => {
    if (doc.querySelector(q)) return true;
    if (depth > 4) return false;
    for (const f of doc.querySelectorAll('iframe,frame')) {
      let inner = null;
      try { inner = f.contentDocument; } catch { inner = null; }
      if (inner && seek(inner, depth + 1)) return true;
    }
    return false;
  };
  return seek(d, 0);
})(document)`;

/** True as soon as one of `checks` is, false once all are not (they never reject). */
const firstTrue = (/** @type {Promise<boolean>[]} */ checks) =>
  new Promise((resolve) => {
    let left = checks.length;
    for (const c of checks) void c.then((yes) => (yes ? resolve(true) : --left === 0 && resolve(false)));
  });

/**
 * Whether `tab`'s page or any of its frames has a credential field. A session that fails, or a probe past `ms`, counts as `unreadable`:
 * false where the plainer answer is never wrong (the hand-off's "Your turn"), true where it must fail closed (a recording's skip).
 * @param {{ send: (method: string, params: object, sessionId?: string) => Promise<any>, frames?: Map<string, unknown> }} tab
 * @param {{ ms: number, unreadable: boolean }} o
 * @returns {Promise<boolean>}
 */
function credentialFieldIn(tab, { ms, unreadable }) {
  const sessions = ['', ...(tab.frames?.keys() ?? [])];
  const probe = (/** @type {string} */ sessionId) =>
    // a send that throws at once (no debugger attached) is a failed read like any other
    Promise.resolve()
      .then(() => tab.send('Runtime.evaluate', { expression: CREDENTIAL_FIELD, returnByValue: true }, sessionId))
      .then(
        (/** @type {any} */ r) => (typeof r?.result?.value === 'boolean' ? r.result.value : unreadable),
        (/** @type {unknown} */ error) => {
          // a page or frame that is loading or gone
          noteIgnored('read whether a browser page asks for a credential', error);
          return unreadable;
        },
      );
  return withTimeout(firstTrue(sessions.map(probe)), ms, () => unreadable);
}

module.exports = { PROBE_MS, CREDENTIAL_FIELD, credentialFieldIn };
