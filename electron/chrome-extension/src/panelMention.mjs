// The side panel's @ menu (sidePanel.mjs), as the app's: typing @ after a space lists the window's open tabs and MoPilot's recent chats, filtered as you type; a pick puts the app's own token in the text, which each harness reads its way (a tab: shared/tabMentions.mjs; a chat: its snapshot, electron/app/chromePanelMentions.cjs).
import { menuKey } from './panelMenuKey.mjs';

/** The query an @ before the caret opens the menu for: at the start or after a space, up to a line's end. */
const QUERY = /(^|\s)@([^\n@]*)$/;
/** A token this menu or the app's composer put in the text; its title is the first group. */
const TOKEN = /\[((?:\\.|[^\]\\\n])*)\]\((?:session|mopilot-tab):\/\/[^\s)]*\)/g;
/** The text with each token as its name, as the app shows a mention: "@Kyoto trip". */
export const named = (/** @type {string} */ text) => text.replace(TOKEN, (_m, t) => `@${t.replace(/\\(.)/g, '$1')}`);
/** How many of each the menu shows. */
export const MAX_EACH = 5;

/** A query value: encodeURIComponent, with the parentheses that would end a markdown link encoded too. */
const enc = (/** @type {string} */ s) => encodeURIComponent(s).replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** A title as markdown link text: brackets and backslashes escaped, whitespace on one line. */
const linkText = (/** @type {string} */ t) => t.replace(/[\\[\]]/g, '\\$&').replace(/\s+/g, ' ');

/** A tab in the user's Chrome, as the app's composer writes it (shared/tabMentions.mjs tabToken). */
export const tabToken = (/** @type {{ id: number, title: string, url: string }} */ t) =>
  `[${linkText(t.title || t.url)}](mopilot-tab://chrome?tabId=${enc(String(t.id))}&url=${enc(t.url)})`;
/** A chat, as the app's composer writes it (shared/sessionMentions.mjs sessionToken). */
export const chatToken = (/** @type {string} */ id, /** @type {string} */ title) => `[${linkText(title)}](session://${enc(id)})`;

export class PanelMention {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {any} o.chrome
   * @param {(method: string, params?: object) => Promise<any>} o.request one request to MoPilot
   * @param {(text: string) => void} o.onError the panel's error line
   * @param {() => void} o.onChange the text changed (Send follows)
   */
  constructor(o) {
    this.o = o;
    const $ = (/** @type {string} */ id) => o.document.getElementById(id);
    this.$ = $;
    /** @type {{ tabs: any[], chats: any[] } | null} what the menu lists while it is open */
    this.lists = null;
    /** @type {{ kind: 'tab' | 'chat', title: string, detail: string, token: string }[]} */
    this.rows = [];
    this.at = 0;
    /** where the @ the menu answers starts */
    this.start = -1;
    this.seq = 0;
  }

  get open() {
    return !this.$('mention-menu').hidden;
  }

  /** The text or caret changed: open, filter or close the menu. */
  async update() {
    const text = this.$('text');
    const caret = text.selectionStart ?? text.value.length;
    // an @ inside a token already in the box (a title like "Ask @bob") isn't a new one
    const m = QUERY.exec(
      String(text.value)
        .slice(0, caret)
        .replace(TOKEN, (t) => '_'.repeat(t.length)),
    );
    if (!m) return this.close();
    const seq = ++this.seq;
    this.start = caret - m[2].length - 1;
    if (!this.lists) {
      // either list failing says why; the other still shows
      const failed = (/** @type {unknown} */ e) => (this.o.onError(String(/** @type {Error} */ (e).message)), []);
      const [tabs, chats] = await Promise.all([
        Promise.resolve(this.o.chrome.tabs.query({ currentWindow: true })).catch(failed),
        this.o.request('recent', { limit: 50 }).then((r) => r?.chats ?? [], failed),
      ]);
      if (seq !== this.seq) return;
      this.lists = {
        tabs: tabs.filter((/** @type {any} */ t) => /^https?:\/\//.test(String(t.url))),
        chats: chats.filter((/** @type {any} */ c) => c.title),
      };
    }
    const q = m[2].trim().toLowerCase();
    const hit = (/** @type {unknown[]} */ ...s) => !q || s.some((x) => String(x).toLowerCase().includes(q));
    const { tabs, chats } = this.lists;
    this.rows = [
      ...tabs
        .filter((t) => hit(t.title, t.url))
        .slice(0, MAX_EACH)
        .map((t) => ({ kind: /** @type {const} */ ('tab'), title: String(t.title || t.url), detail: String(t.url), token: tabToken(t) })),
      ...chats
        .filter((c) => hit(c.title))
        .slice(0, MAX_EACH)
        .map((c) => ({
          kind: /** @type {const} */ ('chat'),
          title: String(c.title),
          detail: 'Chat',
          token: chatToken(String(c.id), String(c.title)),
        })),
    ];
    this.at = 0;
    this.render();
  }

  close() {
    this.$('mention-menu').hidden = true;
    this.rows = [];
    this.lists = null;
  }

  render() {
    const { document } = this.o;
    const menu = this.$('mention-menu');
    menu.hidden = false;
    if (!this.rows.length) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = 'No tabs or chats match.';
      return menu.replaceChildren(none);
    }
    menu.replaceChildren(
      ...this.rows.map((r, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `menu-item${i === this.at ? ' on' : ''}`;
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(i === this.at));
        const name = document.createElement('span');
        name.textContent = r.title;
        const small = document.createElement('small');
        small.textContent = r.detail;
        b.append(name, small);
        b.addEventListener('click', () => this.pick(r));
        return b;
      }),
    );
  }

  /** A key in the message box while the menu is open; true when the menu took it. */
  key(/** @type {any} */ e) {
    return menuKey(this, e);
  }

  /** A row picked: its token in place of the @ typed, and a space after it. */
  pick(/** @type {{ token: string }} */ r) {
    const text = this.$('text');
    const caret = text.selectionStart ?? text.value.length;
    const value = String(text.value);
    const before = `${value.slice(0, this.start)}${r.token} `;
    text.value = before + value.slice(caret);
    text.selectionStart = text.selectionEnd = before.length;
    this.close();
    text.focus();
    this.o.onChange();
  }
}
