// The built-in browser's page preload (sandboxed, in every frame of a pane page): alert, confirm and prompt go to MoPilot (pageDialogs.cjs), which shows them in the pane and to the agent driving the tab, instead of Electron's native sheet (alert, confirm) or its prompt() that throws or answers null.
//
// It runs in a sandboxed preload, so it may require only 'electron'. The page's own dialogs block it until they are
// answered, as a browser's do: the answer comes back over a synchronous message. A frame that never navigated (an
// about:blank or srcdoc iframe a script made) gets no preload of its own: its parent gives it the same dialogs when
// the page reaches its window.
const { contextBridge, ipcRenderer } = require('electron');

/** pageDialogs.cjs PAGE_DIALOG_CHANNEL: a preload can't require it. */
const CHANNEL = 'mopilot:page-dialog';

/** Asks main; the answer is null for an alert, a boolean for a confirm, a string or null for a prompt. */
const ask = (/** @type {string} */ type, /** @type {string} */ message, /** @type {string} */ defaultValue) =>
  ipcRenderer.sendSync(CHANNEL, type, message, defaultValue);

/**
 * Puts the three dialogs on the frame's window, and on the windows of same-origin child frames that have no preload of
 * their own. It runs in the page's world, from its source: it uses nothing outside it.
 */
function install(/** @type {typeof ask} */ send) {
  // a sandboxed frame (an opaque origin: sandbox without allow-same-origin) keeps Chromium's own dialogs, which honour
  // its sandbox (no allow-modals: none at all); MoPilot never gives such a frame more than the sandbox allows
  if (window.origin === 'null') return;
  const text = (/** @type {unknown} */ v) => (v === undefined ? '' : String(v));
  // a page that is being left gets no dialog, as in Chrome: it could hold the navigation until someone answered
  let leaving = false;
  window.addEventListener(
    'beforeunload',
    () => {
      leaving = true;
      window.setTimeout(() => {
        leaving = false;
      }, 0);
    },
    true,
  );
  window.addEventListener('pagehide', () => (leaving = true), true);
  window.addEventListener('pageshow', () => (leaving = false), true);
  const ask = (/** @type {string} */ type, /** @type {string} */ message, /** @type {string} */ value) =>
    leaving ? null : send(type, message, value);
  const dialogs = {
    alert: function alert(/** @type {unknown} */ message) {
      ask('alert', text(message), '');
    },
    confirm: function confirm(/** @type {unknown} */ message) {
      return ask('confirm', text(message), '') === true;
    },
    prompt: function prompt(/** @type {unknown} */ message, /** @type {unknown} */ defaultValue) {
      const answer = ask('prompt', text(message), text(defaultValue));
      return typeof answer === 'string' ? answer : null;
    },
  };
  /** Gives a window the dialogs, unless it has them: each new document of a frame is a new global behind one window. */
  const give = (/** @type {any} */ win) => {
    if (!win || win.alert === dialogs.alert) return;
    try {
      for (const [name, fn] of Object.entries(dialogs))
        Object.defineProperty(win, name, { value: fn, writable: true, configurable: true, enumerable: true });
    } catch (error) {
      // the page fixed a dialog of that window for good: it keeps its own, and the page still gets its window
      window.console.debug('mopilot: a frame kept its own dialogs', error);
    }
  };
  give(window);
  // A same-origin child frame with no preload of its own (it never navigated, or was written into) takes them when the
  // page reaches it, through its element's window or document. Its document is read with the element's own getter:
  // null for a cross-origin frame (that one has its own preload), and it never throws.
  const reached = (/** @type {any} */ doc) => {
    if (doc && /^about:(blank|srcdoc)$/.test(doc.URL)) give(doc.defaultView);
  };
  for (const Element of [window.HTMLIFrameElement, window.HTMLFrameElement, window.HTMLObjectElement]) {
    const proto = Element?.prototype;
    const doc = proto && Object.getOwnPropertyDescriptor(proto, 'contentDocument')?.get;
    if (!doc) continue;
    for (const name of ['contentWindow', 'contentDocument']) {
      const own = Object.getOwnPropertyDescriptor(proto, name);
      const read = own?.get;
      if (!read) continue;
      Object.defineProperty(proto, name, {
        ...own,
        get() {
          const value = read.call(this);
          reached(doc.call(this));
          return value;
        },
      });
    }
  }
}

contextBridge.executeInMainWorld({ func: install, args: [ask] });
