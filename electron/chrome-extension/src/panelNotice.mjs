// The side panel's line about the tab in front (#1986): the administrator keeps agents off its site, or another extension blocks the page, with Retry; read from the background (tabNotices.mjs).

export class PanelNotice {
  /**
   * @param {{ document: any, ask: (message: object) => Promise<any>, onError: (text: string) => void }} o
   */
  constructor(o) {
    this.o = o;
    /** @type {number | null} the tab the line is about */
    this.tabId = null;
    /** the latest read: an earlier tab's answer that comes back late is dropped */
    this.reads = 0;
    o.document.getElementById('notice-act').addEventListener('click', () => void this.retry());
  }

  /** Reads the notice for the tab in front (null: no web page in front, so none). */
  async read(/** @type {number | null} */ tabId) {
    const own = ++this.reads;
    this.tabId = tabId;
    let notice = null;
    if (tabId !== null) {
      try {
        notice = (await this.o.ask({ type: 'tabNotice', tabId }))?.notice ?? null;
      } catch (e) {
        // the line is a hint: without the background's answer it stays away
        console.warn("MoPilot: couldn't read the tab's notice:", e);
      }
    }
    if (own === this.reads) this.#show(notice);
  }

  /** Retry: the page loads again without the other extension's frame. */
  async retry() {
    const tabId = this.tabId;
    if (tabId === null) return;
    try {
      await this.o.ask({ type: 'retryTab', tabId });
    } catch (e) {
      this.o.onError(String(/** @type {Error} */ (e).message));
    }
    await this.read(tabId);
  }

  #show(/** @type {{ text: string, act?: string } | null} */ n) {
    const $ = (/** @type {string} */ id) => this.o.document.getElementById(id);
    $('notice').hidden = !n;
    $('notice-text').textContent = n?.text ?? '';
    $('notice-act').hidden = !n?.act;
    $('notice-act').textContent = n?.act ?? '';
  }
}
