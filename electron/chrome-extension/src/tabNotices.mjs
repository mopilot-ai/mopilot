// What the side panel says about the tab in front (#1986): the administrator keeps agents off its site, or another extension's frame keeps them out of it (Retry reloads it); and the blocked page an agent's tab shows instead of a site the administrator blocks, as Claude in Chrome's blocked.html.
//
// MoPilot refuses an agent's own navigation to a blocked site (adminBlocks.mjs, in main's site table); a link the
// agent follows or a redirect still lands in the tab, so a tab an agent holds that starts loading one is sent to
// blocked.html instead. The user's own tabs are never redirected: their browsing is the user's.
import { adminBlock, adminPatterns } from './adminBlocks.mjs';
import { readPolicy } from './policy.mjs';

/** The notices, by kind: the line, and the one button that moves it on. */
export const NOTICES = Object.freeze({
  admin: { notice: 'admin', text: "Your browser's administrator doesn't allow agents on this site." },
  extension: {
    notice: 'extension',
    text: 'Another extension is blocking this page, such as a password manager or a recorder. Close its menu or turn it off for this site, then retry.',
    act: 'Retry',
  },
});

/** The blocked page for `url`, which it shows as text. */
export const blockedPage = (/** @type {any} */ chrome, /** @type {string} */ url) =>
  chrome.runtime.getURL(`blocked.html#${new URLSearchParams({ url })}`);

export class TabNotices {
  /**
   * @param {{ chrome: any, held: (tabId: number) => boolean, notify: () => void, log: (what: string, error: unknown) => void }} o
   *   held: an agent holds the tab; notify: tells the side panel a notice changed
   */
  constructor(o) {
    this.o = o;
    /** @type {Set<number>} tabs another extension's frame kept an agent out of, until their next page */
    this.blocked = new Set();
    const { chrome } = o;
    chrome.tabs.onRemoved.addListener((/** @type {number} */ tabId) => this.#clear(tabId));
    // a new page has new frames: the notice is for the page that had one
    chrome.webNavigation.onCommitted.addListener((/** @type {any} */ d) => {
      if (d.frameId === 0) this.#clear(d.tabId);
    });
    chrome.webNavigation.onBeforeNavigate.addListener((/** @type {any} */ d) => {
      this.navigating(d).catch((error) => o.log('show the blocked page', error));
    });
  }

  #clear(/** @type {number} */ tabId) {
    if (this.blocked.delete(tabId)) this.o.notify();
  }

  /** Another extension's frame kept an agent out of the tab (debuggers.mjs gave up). */
  extensionBlocked(/** @type {number} */ tabId) {
    if (this.blocked.has(tabId)) return;
    this.blocked.add(tabId);
    this.o.notify();
  }

  /**
   * The notice for a tab at `url`, or null.
   * @returns {Promise<typeof NOTICES[keyof typeof NOTICES] | null>}
   */
  async of(/** @type {number} */ tabId, /** @type {string} */ url) {
    if (adminBlock(adminPatterns(await readPolicy(this.o.chrome)), url)) return NOTICES.admin;
    return this.blocked.has(tabId) ? NOTICES.extension : null;
  }

  /** Retry: the tab's page loads again, without the frame that blocked it; false when it has no such notice. */
  async retry(/** @type {number} */ tabId) {
    if (!this.blocked.has(tabId)) return false;
    await this.o.chrome.tabs.reload(tabId);
    this.#clear(tabId);
    return true;
  }

  /** A tab an agent holds starts loading a page: a site the administrator blocks shows the blocked page instead. */
  async navigating(/** @type {{ tabId: number, frameId: number, url: string }} */ d) {
    if (d.frameId !== 0 || !this.o.held(d.tabId)) return false;
    if (!adminBlock(adminPatterns(await readPolicy(this.o.chrome)), d.url)) return false;
    await this.o.chrome.tabs.update(d.tabId, { url: blockedPage(this.o.chrome, d.url) });
    return true;
  }
}
