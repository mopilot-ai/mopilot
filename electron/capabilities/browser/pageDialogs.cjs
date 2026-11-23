// JavaScript dialogs (alert, confirm, prompt) of the built-in browser's pages, owned by MoPilot for every harness: the page preload (pagePreload.cjs) asks here, the pane shows the dialog to the user, the agent driving the tab sees it in its results and answers it (browser_handle_dialog, browser_script, the Codex Browser plugin's Page.handleJavaScriptDialog), and the first answer wins.
//
// Electron answers a page's prompt() by throwing (or with null in a frame), and shows alert and confirm as a native
// sheet that stays up after an agent answered over CDP, so every frame of a pane page gets its dialogs from the preload
// instead (pane pages run session preloads in their frames). An embedded page's dialog names that page by its origin
// (only the scheme for one with none of its own), and goes when its frame does. Frames the preload doesn't cover (an
// opaque-origin sandboxed frame) keep Chromium's own handling, which reaches an agent over CDP (tab.cjs).
//
// A page's beforeunload asks Chrome's "Leave site?" on the window showing it instead (leaveAsk).
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { noteIgnored } = require('../../ignored.cjs');
const { keyOf } = require('./pageKey.cjs');
const { originOf } = require('./origins.cjs');
const { schemeOf } = require('../../../shared/browserNotice.mjs');

const PAGE_DIALOG_CHANNEL = 'mopilot:page-dialog';
const PAGE_PRELOAD = path.join(__dirname, 'pagePreload.cjs');
const TYPES = new Set(['alert', 'confirm', 'prompt']);
const TEXT_MAX = 2000;

/** What a dialog nobody may answer returns at once: as if it were dismissed. */
const dismissed = (/** @type {string} */ type) => (type === 'confirm' ? false : null);

const clip = (/** @type {unknown} */ v) => String(v ?? '').slice(0, TEXT_MAX);

/**
 * @typedef {{ id: number, wcId: number, type: 'alert' | 'confirm' | 'prompt', message: string, defaultPrompt: string,
 *             url: string, frame: string, asker: any, reply: (value: boolean | string | null) => void, off: () => void }} PageDialog
 *   url: the address of the frame that asked; frame: that frame's origin when it is an embedded page (not the tab's
 *   own document), else ''; asker: that embedded page's frame (WebFrameMain), else null
 */

/**
 * The open dialog of each page, by its webContents. Events: 'open' (wc, dialog) and 'closed' (wc, dialog,
 * { accept, value, by }) where `by` is 'user', 'agent', 'navigated' (the tab went to another document: dismissed) or
 * 'gone' (the page went first; nothing answered it).
 */
class PageDialogs extends EventEmitter {
  /**
   * @param {{ isPage: (wc: any) => boolean }} o isPage: whether the sender is a pane page (BrowserWindows registered it)
   */
  constructor(o) {
    super();
    this.o = o;
    /** @type {Map<number, PageDialog>} */
    this.open = new Map();
    this.seq = 0;
  }

  /**
   * The preload's synchronous message: the page waits until `event.returnValue` is set, as it would on a browser's
   * own dialog. A sender that isn't a pane page, an unknown type or a second dialog of one page is dismissed at once.
   */
  request(/** @type {any} */ event, /** @type {unknown} */ type, /** @type {unknown} */ message, /** @type {unknown} */ defaultPrompt) {
    const wc = event.sender;
    const kind = /** @type {'alert' | 'confirm' | 'prompt'} */ (String(type));
    // the frame that asked (Electron's senderFrame): null when it went before main read it, and nobody waits on that dialog
    const asker = event.senderFrame;
    if (!TYPES.has(kind) || asker === null || !this.o.isPage(wc) || this.#busy(wc)) {
      event.returnValue = dismissed(kind);
      return;
    }
    // an embedded page's own dialog (its frame runs the preload too) says which page asks, as Chrome does
    const sub = !!asker && asker !== wc.mainFrame;
    /** @type {PageDialog} */
    const dialog = {
      id: ++this.seq,
      wcId: wc.id,
      type: kind,
      message: clip(message),
      defaultPrompt: kind === 'prompt' ? clip(defaultPrompt) : '',
      url: sub ? String(asker.url) : urlOf(wc),
      frame: sub ? embedded(String(asker.url)) : '',
      asker: sub ? asker : null,
      reply: (value) => {
        event.returnValue = value;
      },
      off: () => {
        wc.removeListener('destroyed', gone);
        wc.removeListener('render-process-gone', gone);
        wc.removeListener('did-start-navigation', leaving);
      },
    };
    // the page went (closed, crashed, or killed when it hung) before anyone answered: nothing waits any more
    const gone = () => this.#close(wc, dialog, { accept: false, value: null, by: 'gone' });
    // the tab goes to another document (the user's address bar, an agent's navigation, in a new renderer): as a
    // browser cancels a dialog then, it is dismissed, and its page is let go
    const leaving = (
      /** @type {any} */ e,
      /** @type {unknown} */ _url,
      /** @type {boolean} */ inPlace,
      /** @type {boolean} */ mainFrame,
    ) => {
      if (e?.isSameDocument ?? inPlace) return;
      // the tab's page, or the embedded page that asked, goes to another document
      if ((e?.isMainFrame ?? mainFrame) || (dialog.asker && e?.frame === dialog.asker))
        this.#close(wc, dialog, { accept: false, value: dismissed(kind), by: 'navigated' });
    };
    wc.once('destroyed', gone);
    wc.once('render-process-gone', gone);
    wc.on('did-start-navigation', leaving);
    this.open.set(wc.id, dialog);
    this.emit('open', wc, dialog);
  }

  /** The page's open dialog, or null. One whose embedded page went (its frame removed or crashed) is let go first. */
  of(/** @type {any} */ wc) {
    const dialog = (wc && this.open.get(wc.id)) ?? null;
    if (dialog?.asker && (dialog.asker.detached || dialog.asker.isDestroyed?.())) {
      this.#close(wc, dialog, { accept: false, value: null, by: 'gone' });
      return null;
    }
    return dialog;
  }

  /** Whether a dialog of the page still waits (a second one is dismissed at once, as one page has one at a time). */
  #busy(/** @type {any} */ wc) {
    return !!this.of(wc);
  }

  /**
   * Answers the page's dialog `id` (any open one when null): accept or dismiss, and a prompt's text (its default when
   * none is given). False when it is no longer open (someone answered first, or the page went).
   */
  answer(
    /** @type {any} */ contents,
    /** @type {number | null} */ id,
    /** @type {boolean} */ accept,
    /** @type {unknown} */ text,
    by = 'user',
  ) {
    const wc = keyOf(contents);
    const dialog = this.of(wc);
    if (!dialog || (id != null && dialog.id !== id)) return false;
    const value =
      dialog.type === 'confirm'
        ? !!accept
        : dialog.type === 'prompt' && accept
          ? text == null
            ? dialog.defaultPrompt
            : String(text)
          : null;
    this.#close(wc, dialog, { accept: dialog.type === 'alert' || !!accept, value, by });
    return true;
  }

  /** Only an open dialog gets here: answer() and gone() find it open, and closing it stops gone() listening. */
  #close(wc, /** @type {PageDialog} */ dialog, /** @type {{ accept: boolean, value: boolean | string | null, by: string }} */ result) {
    this.open.delete(dialog.wcId);
    dialog.off();
    if (result.by !== 'gone') dialog.reply(result.value);
    this.emit('closed', wc, dialog, result);
  }
}

/**
 * How an embedded page is named: its origin, or only its scheme when it has none of its own (data:, blob:,
 * about:srcdoc), as its address is the page's own text.
 */
function embedded(/** @type {string} */ url) {
  return originOf(url) || `${schemeOf(url) || 'an unknown'}: page`;
}

/** The page's address, or '' once it has none. */
function urlOf(wc) {
  try {
    return wc.getURL();
  } catch (error) {
    noteIgnored('read the address of a page asking a dialog', error);
    return '';
  }
}

/** Sessions the preload is registered in already. */
const installed = new WeakSet();

/** Every page of a pane session (the shared profile or a chat's own) gets the dialog preload, in every frame. */
function installPageDialogs(/** @type {any} */ ses) {
  if (!ses || installed.has(ses) || typeof ses.registerPreloadScript !== 'function') return;
  installed.add(ses);
  ses.registerPreloadScript({ type: 'frame', id: 'mopilot-page-dialogs', filePath: PAGE_PRELOAD });
}

/**
 * Chrome's "Leave site?" for a page that asks to confirm leaving it (beforeunload) while the user, not an agent, left
 * it, on the window showing it. Null when no window shows the page (nobody could answer).
 * @param {{ showMessageBoxSync: (win: any, options: object) => number }} dialog Electron's
 * @param {(wc: any) => any} windowOf the window showing a page, else null
 */
function leaveAsk(dialog, windowOf) {
  return (/** @type {any} */ wc) => {
    const win = windowOf(wc);
    // only a user at the window answers it: the question holds main until answered, so it never waits on nobody
    if (!win || win.isDestroyed() || !win.isFocused()) return null;
    const answer = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Leave', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Leave site?',
      detail: 'Changes you made may not be saved.',
    });
    return answer === 0;
  };
}

module.exports = { PageDialogs, installPageDialogs, leaveAsk, PAGE_DIALOG_CHANNEL, PAGE_PRELOAD };
