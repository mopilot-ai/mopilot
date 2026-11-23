// The side panel page (electron/chrome-extension/src/sidePanel.mjs) on a fake DOM and a fake Chrome, for its unit tests.
import { PanelState } from '../../electron/chrome-extension/src/panelState.mjs';
import { fakeChromeApi } from './chrome-extension-kit.ts';
import { fakeTimers } from './extension-background/fixture.ts';

export function el(tag = 'div'): any {
  const e: any = {
    tagName: tag.toUpperCase(),
    hidden: false,
    text: '',
    // as the DOM's: set, it replaces the children; read, it joins theirs
    get textContent(): string {
      return this.text + this.children.map((c: any) => c.textContent).join('');
    },
    set textContent(t: string) {
      this.text = t;
      this.children = [];
    },
    className: '',
    value: '',
    disabled: false,
    src: '',
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    attrs: {} as Record<string, string>,
    children: [] as any[],
    listeners: {} as Record<string, Function>,
    focused: 0,
    addEventListener(type: string, f: Function) {
      this.listeners[type] = f;
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    replaceChildren(...c: any[]) {
      this.children = c;
    },
    get lastChild() {
      return this.children.at(-1);
    },
    insertBefore(child: any, before: any) {
      this.children = this.children.filter((c: any) => c !== child);
      const index = before == null ? this.children.length : this.children.indexOf(before);
      this.children.splice(index, 0, child);
    },
    removeChild(child: any) {
      this.children = this.children.filter((c: any) => c !== child);
    },
    append(...c: any[]) {
      this.children.push(...c);
    },
    focus() {
      this.focused++;
    },
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  return e;
}

export function panelPage(o: { reply?: (m: any) => any; tab?: any; firstRun?: boolean } = {}) {
  const chrome: any = fakeChromeApi();
  // someone who has used the panel before: the first run's consent and intro are behind them
  if (!o.firstRun) void chrome.storage.local.set({ panelConsent: true, panelIntro: true });
  if (o.tab !== null)
    chrome.addTab({
      active: true,
      title: 'Hacker News',
      url: 'https://news.ycombinator.com/',
      favIconUrl: 'https://news.ycombinator.com/favicon.ico',
      ...o.tab,
    });
  const harnesses = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
  ];
  chrome.reply =
    o.reply ??
    ((m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses } };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'chat-9' } };
      if (m.method === 'recent')
        return {
          status: 'connected',
          result: {
            chats: [
              { id: 'a', title: 'Fill the expense form', state: 'waiting' },
              { id: 'b', title: null, state: 'idle' },
              { id: 'c', title: 'Old', state: 'archived?' },
            ],
          },
        };
      // an answer with no result reads as an empty one
      return { status: 'connected' };
    });
  const owner = new PanelState(chrome);
  const reply = chrome.reply;
  chrome.reply = async (m: any) => {
    if (m.type === 'panelBind') {
      await owner.bind(m.tabId, m.chat, m.explicit !== false);
      return {};
    }
    if (m.type === 'panelDraft') {
      await owner.keep(m.tabId, m.text);
      return {};
    }
    return reply(m);
  };
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
    querySelectorAll: () => [],
    // the panel's document-level listeners (a press outside a menu, Escape), kept by type so a test can fire them
    listeners: {} as Record<string, Function>,
    addEventListener(type: string, f: Function) {
      this.listeners[type] = f;
    },
  };
  // hidden until opened, as in sidepanel.html
  els.sidebar = el();
  els.sidebar.hidden = true;
  const timers = fakeTimers();
  const g: any = { chrome, document, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout };
  const sent = () => chrome.log.filter((l: any) => l[0] === 'runtime.sendMessage').map((l: any) => l[1]);
  return { chrome, els, g, timers, sent };
}
