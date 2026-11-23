// The side panel's / menu (sidePanel.mjs), as the app's: typing / at the start of a message lists the chat's harness's commands and skills (electron/app/chromePanelCommands.cjs), filtered as you type; ↑/↓ move, Enter or a click picks, Esc closes. A command goes in the text as /name; a Codex skill rides beside it as a chip.
import { menuKey } from './panelMenuKey.mjs';

/** The query a message's text opens the menu for: a / at its start, then the name typed so far. */
const QUERY = /^\/([\w:.-]*)$/;
/** How many rows the menu shows at once. */
export const MAX_ROWS = 8;

export class PanelSlash {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {(method: string, params?: object) => Promise<any>} o.request one request to MoPilot
   * @param {() => { harness?: string, chatId?: string, projectId?: string }} o.target the chat open, or the next new chat
   * @param {(text: string) => void} o.onError the panel's error line
   * @param {() => void} o.onChange the text or the skills changed (Send follows)
   */
  constructor(o) {
    this.o = o;
    const $ = (/** @type {string} */ id) => o.document.getElementById(id);
    this.$ = $;
    /** @type {{ key: string, list: any[] } | null} the last list read, for the target it was read for */
    this.read = null;
    /** @type {any[]} the rows shown */
    this.rows = [];
    this.at = 0;
    /** @type {string[]} the skills the next message carries */
    this.skills = [];
    this.seq = 0;
    /** @type {{ key: string, list: Promise<any[]> } | null} the read on its way */
    this.pending = null;
  }

  get open() {
    return !this.$('slash-menu').hidden;
  }

  /** The text changed: open, filter or close the menu. */
  async update() {
    const m = QUERY.exec(this.$('text').value);
    if (!m) return this.close();
    const target = this.o.target();
    const key = JSON.stringify(target);
    const seq = ++this.seq;
    if (this.read?.key !== key) {
      // keystrokes while the list is on its way share its one read
      if (this.pending?.key !== key)
        this.pending = { key, list: this.o.request('commands', target).then((r) => /** @type {any[]} */ (r?.commands ?? [])) };
      const pending = this.pending;
      try {
        const list = await pending.list;
        if (this.pending === pending) this.pending = null;
        // a newer keystroke or another chat replaced this read
        if (seq !== this.seq) return;
        this.read = { key, list };
      } catch (e) {
        if (this.pending === pending) this.pending = null;
        if (seq === this.seq) this.o.onError(String(/** @type {Error} */ (e).message));
        return this.close();
      }
    }
    const q = m[1].toLowerCase();
    // read just now, or earlier for the same target
    const list = /** @type {{ list: any[] }} */ (this.read).list;
    // the names that start with what is typed, then the rest that hold it
    const starts = list.filter((c) => c.name.toLowerCase().startsWith(q));
    const holds = list.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
    this.rows = [...starts, ...holds].slice(0, MAX_ROWS);
    this.at = 0;
    this.render();
  }

  close() {
    this.$('slash-menu').hidden = true;
    this.rows = [];
  }

  render() {
    const { document } = this.o;
    const menu = this.$('slash-menu');
    menu.hidden = false;
    if (!this.rows.length) {
      const none = document.createElement('p');
      none.className = 'none';
      none.textContent = 'No commands here.';
      return menu.replaceChildren(none);
    }
    menu.replaceChildren(
      ...this.rows.map((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `menu-item${i === this.at ? ' on' : ''}`;
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', String(i === this.at));
        const name = document.createElement('span');
        name.textContent = `/${c.name}${c.hint ? ` ${c.hint}` : ''}`;
        b.append(name);
        if (c.description) {
          const small = document.createElement('small');
          small.textContent = c.description;
          b.append(small);
        }
        b.addEventListener('click', () => this.pick(c));
        return b;
      }),
    );
  }

  /** A key in the message box while the menu is open; true when the menu took it. */
  key(/** @type {any} */ e) {
    return menuKey(this, e);
  }

  /** A row picked: a command's /name in the text, or a Codex skill as a chip beside it. */
  pick(/** @type {any} */ c) {
    const text = this.$('text');
    if (c.as === 'skill') {
      if (!this.skills.includes(c.name)) this.skills.push(c.name);
      text.value = '';
    } else text.value = `/${c.name} `;
    this.close();
    this.renderSkills();
    text.focus();
    this.o.onChange();
  }

  /** The skills' chips. */
  renderSkills() {
    const { document } = this.o;
    this.$('skills').hidden = !this.skills.length;
    this.$('skills').replaceChildren(
      ...this.skills.map((name) => {
        const chip = document.createElement('span');
        chip.className = 'chip file skill';
        const label = document.createElement('span');
        label.textContent = `/${name}`;
        const off = document.createElement('button');
        off.type = 'button';
        off.textContent = '×';
        off.setAttribute('aria-label', `Remove ${name}`);
        off.addEventListener('click', () => {
          this.skills = this.skills.filter((x) => x !== name);
          this.renderSkills();
          this.o.onChange();
        });
        chip.append(label, off);
        return chip;
      }),
    );
  }

  /** Sent: those skills go; the chat or harness changed: the list is read again. */
  clear(/** @type {string[]} */ sent = this.skills) {
    this.skills = this.skills.filter((x) => !sent.includes(x));
    this.renderSkills();
  }

  /** Another chat, harness or project: its own list, and no skill of the last one's. */
  reset() {
    this.read = null;
    this.pending = null;
    this.skills = [];
    this.close();
    this.renderSkills();
  }
}
