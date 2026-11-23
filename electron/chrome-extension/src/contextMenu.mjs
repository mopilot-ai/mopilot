// "Ask MoPilot" in a page's context menu (#1986), as ChatGPT's "Ask ChatGPT": it opens the side panel of that tab (panelTab.mjs), with the selected text in its message box to edit (never sent).
//
// The text waits in session storage (memory only, gone when Chrome quits) under the tab's id, so the panel of
// another tab never takes it; the panel takes it as it opens, or when told (`notify`) if it was open already.

import { openPanel } from './panelTab.mjs';
import { PanelState } from './panelState.mjs';

export const ASK_MENU = 'mopilot-ask';
/** At most this much of a selection goes into the box. */
export const MAX_DRAFT = 20_000;
export { draftKey } from './panelState.mjs';

export class ContextMenu {
  /**
   * @param {{ chrome: any, notify: (tabId: number) => void, log: (what: string, error: unknown) => void, state?: PanelState }} o
   *   notify: tells the side panels a tab's text is waiting
   */
  constructor(o) {
    this.o = o;
    /** takes one at a time: two panels' reads of one text would both get it */
    this.state = o.state ?? new PanelState(o.chrome);
    // Chrome keeps the item across restarts of the service worker, and drops it on an update
    o.chrome.runtime.onInstalled.addListener(() => void this.create());
    o.chrome.contextMenus.onClicked.addListener((/** @type {any} */ info, /** @type {any} */ tab) => this.clicked(info, tab));
  }

  async create() {
    const { chrome, log } = this.o;
    try {
      await chrome.contextMenus.removeAll();
      chrome.contextMenus.create({ id: ASK_MENU, title: 'Ask MoPilot', contexts: ['page', 'selection'] }, () => {
        if (chrome.runtime.lastError) log('add Ask MoPilot to the context menu', chrome.runtime.lastError);
      });
    } catch (error) {
      log('add Ask MoPilot to the context menu', error);
    }
  }

  clicked(/** @type {any} */ info, /** @type {any} */ tab) {
    const { chrome, log, notify } = this.o;
    const tabId = tab?.id;
    if (info?.menuItemId !== ASK_MENU || !Number.isSafeInteger(tabId)) return;
    // the clicked tab's own panel, opened in the click's own call: Chrome opens a side panel only in answer to the user's gesture
    openPanel(chrome, tab, log);
    const text = String(info.selectionText ?? '').slice(0, MAX_DRAFT);
    if (!text.trim()) return;
    Promise.resolve()
      .then(() => this.state.keep(tabId, text, true))
      .then(
        () => notify(tabId),
        (/** @type {unknown} */ error) => log('keep the selected text for the side panel', error),
      );
  }

  /** The text waiting for a tab's panel, taken (empty when none). */
  take(/** @type {number} */ tabId) {
    return this.state.take(tabId);
  }
}
