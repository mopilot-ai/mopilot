// A script that runs before a built-in browser page's own, in every frame of every document: a CDP
// new-document script on the page and on each frame in another process (auto-attached), kept on the page's
// debugger across agent turns. A tab's turn (tab.cjs) shares that debugger, and its detach is followed by
// arming it again. Only the Page domain and auto-attach are used, plus whatever `onRoot` sets up on the page's own
// session each time (the passkey bridge's binding); the page still has no preload and no Node.
const { noteIgnored } = require('../../ignored.cjs');
const { keyOf } = require('./pageKey.cjs');

/** Auto-attach as every client of a browser page's debugger runs it: flat sessions, new frames never paused. */
const AUTO_ATTACH = Object.freeze({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

/**
 * Per page: its frame sessions by id (with the URL each last showed), and the identifiers of its early scripts by
 * "sessionId:identifier".
 * @typedef {{ sessionId: string, parent: string, targetId: string, url: string }} FrameSession
 * @type {WeakMap<any, { frames: Map<string, FrameSession>, scripts: Set<string> }>}
 */
const pages = new WeakMap();

/**
 * Runs `source` in each new document of the page (all its frames, before their scripts) and in the documents
 * it has now. Once per page: a later call for the same contents is ignored.
 * @param {any} wc the page's webContents
 * @param {string} source
 * @param {(send: (method: string, params?: object) => Promise<any>) => void} [onRoot] runs on the page's own session
 *   at every arm (a turn's detach takes what it set up), after the script is in
 */
function runBeforePage(wc, source, onRoot) {
  if (pages.has(keyOf(wc))) return;
  const dbg = wc.debugger;
  /** @type {Map<string, FrameSession>} */
  const frames = new Map();
  const scripts = new Set();
  pages.set(keyOf(wc), { frames, scripts });
  const send = (method, params, sessionId) =>
    (sessionId ? dbg.sendCommand(method, params, sessionId) : dbg.sendCommand(method, params)).catch((error) => {
      // the frame or page went before it was set up
      noteIgnored(`set up ${method} for a browser page's early script`, error);
    });
  const setup = (sessionId) => {
    // new-document scripts run only while the Page domain is on
    void send('Page.enable', {}, sessionId);
    void send('Page.addScriptToEvaluateOnNewDocument', { source, runImmediately: true }, sessionId).then(
      (r) => r?.identifier && scripts.add(`${sessionId}:${r.identifier}`),
    );
    void send('Target.setAutoAttach', AUTO_ATTACH, sessionId);
  };
  const arm = () => {
    if (wc.isDestroyed()) return;
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (error) {
      // another client holds the page: frames are still covered after they load (passkeys.cjs)
      noteIgnored("attach to a browser page's debugger for its early script", error);
      return;
    }
    setup('');
    onRoot?.((method, params = {}) => send(method, params, ''));
  };
  dbg.on('message', (_e, method, p, sessionId) => {
    if (method === 'Target.attachedToTarget' && p?.targetInfo?.type === 'iframe') {
      const { targetId, url = '' } = p.targetInfo;
      frames.set(p.sessionId, { sessionId: p.sessionId, parent: sessionId || '', targetId, url });
      setup(p.sessionId);
    } else if (method === 'Target.detachedFromTarget') frames.delete(p?.sessionId);
    else if (method === 'Page.frameNavigated' && frames.has(sessionId) && p?.frame && !p.frame.parentId)
      // a frame session's own document (not a frame inside it)
      /** @type {FrameSession} */ (frames.get(sessionId)).url = p.frame.url;
  });
  // a turn let go of the debugger (tab.cjs detach) or it was lost: its sessions and scripts went with it. Whoever
  // attaches next (this, or a tab in the same tick) is told of the frames again.
  dbg.on('detach', () => {
    frames.clear();
    scripts.clear();
    setImmediate(arm);
  });
  arm();
}

/**
 * The frame sessions the page's debugger already has: a client joining later is not told of them again.
 * @param {any} wc
 */
const framesOf = (wc) => [...(pages.get(keyOf(wc))?.frames.values() ?? [])];

/**
 * Whether a new-document script is one of the page's early scripts (another client must not take it off).
 * @param {any} wc
 * @param {string} sessionId '' for the page's own session
 * @param {unknown} identifier
 */
const isEarlyScript = (wc, sessionId, identifier) => !!pages.get(keyOf(wc))?.scripts.has(`${sessionId}:${identifier}`);

module.exports = { runBeforePage, framesOf, isEarlyScript, AUTO_ATTACH };
