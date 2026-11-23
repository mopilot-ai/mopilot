// The extension's downloads report (#1632): a download a chat's agent starts in one of its tabs is reported to MoPilot, from start to its saved file or failure.
//
// chrome.downloads names no tab, so a download is matched to the chat's tab by the CDP event its page sends when the
// download begins (Page.downloadWillBegin, which reaches only a tab the agent's debugger holds): the same URL within
// MATCH_MS. A download nobody matched (the user's own, in any tab) is never reported. Chrome saves the file where the
// user's own download settings say; MoPilot learns the path once Chrome settled it.
//   extension -> app  { chat, method: 'chrome.downloads.onChanged', params: [{ tabId, id, url, filename, state, error,
//                       bytesReceived, totalBytes, mime }] }    state: 'in_progress' | 'complete' | 'interrupted'

export const MATCH_MS = 30_000;
/** Downloads begun in a chat's tab that Chrome has not created yet: no more are kept. */
const MAX_PENDING = 20;

export class Downloads {
  /**
   * @param {{ chrome: any, owner: (tabId: number) => string | undefined, send: (message: any) => void,
   *           log: (what: string, error: unknown) => void, now?: () => number }} o
   *   owner: the chat a tab belongs to now
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    /** @type {{ chat: string, tabId: number, url: string, at: number }[]} begun in a chat's tab, not yet created */
    this.pending = [];
    /** @type {Map<number, { chat: string, tabId: number }>} download id -> whose it is, until it ends */
    this.tracked = new Map();
  }

  /** A CDP event of a chat's tab: a download begins there. */
  cdp(source, method, params) {
    if (method !== 'Page.downloadWillBegin' || typeof params?.url !== 'string') return;
    const tabId = source?.tabId;
    const chat = this.o.owner(tabId);
    if (!chat) return;
    const now = this.now();
    this.pending = this.pending.filter((p) => now - p.at < MATCH_MS).slice(-(MAX_PENDING - 1));
    this.pending.push({ chat, tabId, url: params.url, at: now });
  }

  /** chrome.downloads.onCreated: the download's chat, when one of its tabs began it. */
  created(item) {
    if (!item || !Number.isInteger(item.id)) return;
    const now = this.now();
    const i = this.pending.findIndex((p) => now - p.at < MATCH_MS && (p.url === item.url || p.url === item.finalUrl));
    if (i < 0) return;
    const [p] = this.pending.splice(i, 1);
    this.tracked.set(item.id, { chat: p.chat, tabId: p.tabId });
    this.#report(item);
  }

  /** chrome.downloads.onChanged: a tracked download got its file name, or ended. */
  async changed(delta) {
    const id = delta?.id;
    if (!this.tracked.has(id) || !(delta.state || delta.filename)) return;
    let item;
    try {
      [item] = await this.o.chrome.downloads.search({ id });
    } catch (error) {
      this.o.log('read a download', error);
      return;
    }
    if (item) this.#report(item);
  }

  #report(item) {
    const t = this.tracked.get(item.id);
    if (!t) return;
    const state = item.state === 'complete' || item.state === 'interrupted' ? item.state : 'in_progress';
    if (state !== 'in_progress') this.tracked.delete(item.id);
    this.o.send({
      chat: t.chat,
      method: 'chrome.downloads.onChanged',
      params: [
        {
          tabId: t.tabId,
          id: item.id,
          url: String(item.finalUrl || item.url || ''),
          filename: String(item.filename || ''),
          state,
          error: item.error ? String(item.error) : null,
          bytesReceived: Number(item.bytesReceived) || 0,
          totalBytes: Number(item.totalBytes) || 0,
          mime: String(item.mime || ''),
        },
      ],
    });
  }
}
