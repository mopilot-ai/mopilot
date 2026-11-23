// The side panel's + menu (sidePanel.mjs), as Claude in Chrome's: a screenshot of the tab in front, or files the user picks, or an image pasted into the message box, each kept by MoPilot for the next message (electron/app/chromePanelFiles.cjs) and shown as a chip until it is sent or removed.

/** How many files one message carries. */
export const MAX_FILES = 10;

/** The images every harness reads as images (electron/app/chromePanelFiles.cjs IMAGE): the ones a paste attaches. */
const PASTED = /^image\/(png|jpeg|gif|webp)$/;

export class PanelAttach {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {any} o.chrome
   * @param {(method: string, params?: object) => Promise<any>} o.request one request to MoPilot
   * @param {(file: any) => Promise<string>} o.read a picked file as a data: URL
   * @param {() => { id: number } | null} o.tab the web page in front (the panel offers it), whether or not its chip is on
   * @param {(text: string) => void} o.onError the panel's error line
   * @param {() => void} o.onChange the attachments or their upload changed (Send follows)
   */
  constructor(o) {
    this.o = o;
    /** @type {{ id: string, name: string, kind: string }[]} */
    this.list = [];
    /** uploads under way */
    this.busy = 0;
    const $ = (/** @type {string} */ id) => o.document.getElementById(id);
    this.$ = $;
    $('plus').addEventListener('click', () => {
      const open = $('plus-menu').hidden;
      // one menu open at a time
      $('model-menu').hidden = true;
      $('perm-menu').hidden = true;
      $('plus-menu').hidden = !open;
    });
    $('shot').addEventListener('click', () => void this.shot());
    $('pick').addEventListener('click', () => {
      $('plus-menu').hidden = true;
      $('files').click();
    });
    // A copied image (a screenshot, "Copy image" on a page) pastes as a chip, as in Claude's and ChatGPT's boxes. Text
    // that comes with it (cells copied from a sheet carry a picture of them too) is pasted as the text it is.
    $('text').addEventListener('paste', (/** @type {any} */ e) => {
      const data = e.clipboardData;
      const images = [...(data?.files ?? [])].filter((f) => PASTED.test(String(f.type)));
      if (!images.length || data.getData('text/plain')) return;
      e.preventDefault();
      // named by what it is, never by the page's or the clipboard's own name
      void Promise.all(images.map((f) => this.add(() => this.o.read(f), `Pasted image.${String(f.type).slice(6).replace('jpeg', 'jpg')}`)));
    });
    $('files').addEventListener('change', () => {
      const picked = [...($('files').files ?? [])];
      $('files').value = '';
      void Promise.all(picked.map((f) => this.add(() => this.o.read(f), String(f.name))));
    });
  }

  /** The ids the next message carries. */
  get ids() {
    return this.list.map((f) => f.id);
  }

  /**
   * A screenshot of the tab in front, taken by the extension's background through its debugger (debuggers.mjs capture),
   * as Claude in Chrome takes one: no permission to ask for. Named plainly: the page's title is the page's own text, and
   * the name can reach the message.
   */
  async shot() {
    const { chrome } = this.o;
    this.$('plus-menu').hidden = true;
    const tab = this.o.tab();
    if (!tab) return this.o.onError('Open a web page to add a screenshot of it.');
    await this.add(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id });
      if (!r?.dataUrl) throw new Error(r?.error ?? "MoPilot can't take a screenshot of this page.");
      return r.dataUrl;
    }, 'Screenshot.png');
  }

  /** One file read and kept by MoPilot; its chip shows once it is there. */
  async add(/** @type {() => Promise<string>} */ read, /** @type {string} */ name) {
    if (this.list.length + this.busy >= MAX_FILES) return this.o.onError(`Add up to ${MAX_FILES} files.`);
    this.busy++;
    this.o.onChange();
    try {
      const dataUrl = await read();
      const f = await this.o.request('attach', { dataUrl, name });
      this.list.push({ id: String(f.id), name: String(f.name), kind: String(f.kind) });
    } catch (e) {
      this.o.onError(String(/** @type {Error} */ (e).message));
    } finally {
      this.busy--;
      this.render();
      this.o.onChange();
    }
  }

  /** Sent: those chips go; one added while the message was on its way stays for the next. */
  clear(/** @type {string[]} */ sent) {
    this.list = this.list.filter((f) => !sent.includes(f.id));
    this.render();
  }

  render() {
    const { document } = this.o;
    this.$('attached').hidden = !this.list.length && !this.busy;
    this.$('attached').replaceChildren(
      ...this.list.map((f) => {
        const chip = document.createElement('span');
        chip.className = `chip file ${f.kind}`;
        const name = document.createElement('span');
        name.textContent = f.name;
        const off = document.createElement('button');
        off.type = 'button';
        off.textContent = '×';
        off.setAttribute('aria-label', `Remove ${f.name}`);
        off.addEventListener('click', () => {
          this.list = this.list.filter((x) => x !== f);
          this.render();
          this.o.onChange();
        });
        chip.append(name, off);
        return chip;
      }),
      ...(this.busy ? [Object.assign(document.createElement('span'), { className: 'chip file busy', textContent: 'Adding…' })] : []),
    );
  }
}
