// The Chrome side panel's @ menu (electron/chrome-extension/src/panelMention.mjs and its use in sidePanel.mjs): @ after a space lists the window's web tabs and recent chats, filtered as you type; keys move and pick; a pick puts the app's token where the @ was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { PanelMention, MAX_EACH, tabToken, chatToken, named } = await import('../electron/chrome-extension/src/panelMention.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const TABS = [
  { id: 1, title: 'Hacker News', url: 'https://news.ycombinator.com/' },
  { id: 2, title: 'Settings', url: 'chrome://settings/' },
  { id: 3, title: '', url: 'https://kyoto.travel/ryokan' },
];
const CHATS = [
  { id: 'c1', title: 'Kyoto trip' },
  { id: 'c2', title: null },
  { id: 'c3', title: 'Fix the build' },
];

/** The menu on a fake document and Chrome; MoPilot's recent chats answer at once unless `fail`. */
function mentionMenu(o: { fail?: boolean; tabs?: any } = {}) {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) };
  els['mention-menu'] = Object.assign(el(), { hidden: true });
  els.text = el('textarea');
  const asks: any[] = [];
  const errors: string[] = [];
  let changes = 0;
  const m = new PanelMention({
    document,
    chrome: { tabs: { query: async () => ('tabs' in o ? o.tabs : TABS) } },
    request: async (method: string, params: any) => {
      asks.push([method, params]);
      if (o.fail) throw new Error("MoPilot isn't connected.");
      return { chats: CHATS };
    },
    onError: (x: string) => errors.push(x),
    onChange: () => changes++,
  });
  const type = (v: string, caret = v.length) => {
    els.text.value = v;
    els.text.selectionStart = caret;
    return m.update();
  };
  const rows = () =>
    els['mention-menu'].children.map((c: any) =>
      c.children.length ? `${c.children[0].textContent} · ${c.children[1].textContent}` : c.textContent,
    );
  const key = (k: string, extra: any = {}) => {
    let prevented = false;
    return { took: m.key({ key: k, preventDefault: () => (prevented = true), ...extra }), prevented: () => prevented };
  };
  return { m, els, asks, errors, type, rows, key, changes: () => changes };
}

test('@ lists the web tabs then the named recent chats, filtered by title or address; read once while it is open', async () => {
  const p = mentionMenu();
  await p.type('Compare @');
  assert.deepEqual(p.asks, [['recent', { limit: 50 }]]);
  assert.deepEqual(p.rows(), [
    'Hacker News · https://news.ycombinator.com/',
    'https://kyoto.travel/ryokan · https://kyoto.travel/ryokan',
    'Kyoto trip · Chat',
    'Fix the build · Chat',
  ]);
  await p.type('Compare @kyo');
  assert.deepEqual(p.rows(), ['https://kyoto.travel/ryokan · https://kyoto.travel/ryokan', 'Kyoto trip · Chat']);
  assert.equal(p.asks.length, 1);
  await p.type('Compare @nothing');
  assert.deepEqual(p.rows(), ['No tabs or chats match.']);
  // an @ inside a word, or none, closes it; reopened, it reads again
  await p.type('mail me@example');
  assert.equal(p.els['mention-menu'].hidden, true);
  await p.type('@');
  assert.equal(p.asks.length, 2);
  // more than fit: the first few of each
  const many = mentionMenu({ tabs: Array.from({ length: 9 }, (_, i) => ({ id: i, title: `T${i}`, url: `https://t${i}.example/` })) });
  await many.type('@');
  assert.equal(many.rows().filter((r: string) => r.startsWith('T')).length, MAX_EACH);
});

test('a pick puts the token where the @ was, keeps what follows, and leaves the caret after it', async () => {
  const p = mentionMenu();
  await p.type('Compare @hack with this', 'Compare @hack'.length);
  assert.deepEqual(p.key('Enter').took, true);
  const token = tabToken(TABS[0]);
  assert.equal(p.els.text.value, `Compare ${token}  with this`);
  assert.equal(p.els.text.selectionStart, `Compare ${token} `.length);
  assert.equal(p.els['mention-menu'].hidden, true);
  assert.equal(p.els.text.focused, 1);
  // a chat, by a click
  await p.type('@kyo');
  p.els['mention-menu'].children[1].listeners.click();
  assert.equal(p.els.text.value, `${chatToken('c1', 'Kyoto trip')} `);
  assert.ok(p.changes() > 0);
});

test('keys: ↓/↑ wrap, Tab picks, Esc closes; an input method’s keys and keys with no rows pass through', async () => {
  const p = mentionMenu();
  assert.equal(p.key('Enter').took, false);
  await p.type('@');
  p.key('ArrowUp');
  assert.equal(p.els['mention-menu'].children[3].attrs['aria-selected'], 'true');
  p.key('ArrowDown');
  p.key('ArrowDown');
  assert.equal(p.els['mention-menu'].children[1].attrs['aria-selected'], 'true');
  assert.equal(p.key('Enter', { isComposing: true }).took, false);
  assert.equal(p.key('Escape', { keyCode: 229 }).took, false);
  assert.equal(p.key('x').took, false);
  const tab = p.key('Tab');
  assert.equal(tab.took, true);
  assert.equal(tab.prevented(), true);
  await p.type('@');
  assert.equal(p.key('Escape').took, true);
  assert.equal(p.els['mention-menu'].hidden, true);
  await p.type('@zzz');
  assert.equal(p.key('ArrowDown').took, false);
  assert.equal(p.key('Enter').took, false);
});

test('chats MoPilot can’t list say why and the tabs still show; Chrome failing to list tabs leaves the chats', async () => {
  const p = mentionMenu({ fail: true });
  await p.type('@');
  assert.deepEqual(p.errors, ["MoPilot isn't connected."]);
  assert.deepEqual(p.rows().length, 2);
  const q = mentionMenu();
  (q.m as any).o.chrome.tabs.query = async () => {
    throw new Error('No current window');
  };
  await q.type('@');
  assert.deepEqual(q.rows(), ['Kyoto trip · Chat', 'Fix the build · Chat']);
  assert.deepEqual(q.errors, ['No current window']);
  // an answer with no list: no chats
  (q.m as any).o.request = async () => ({});
  (q.m as any).o.chrome.tabs.query = async () => TABS;
  await q.type('x');
  await q.type('@');
  assert.equal(q.rows().length, 2);
  // an older read that lands after a newer keystroke doesn't show over it
  const r = mentionMenu();
  const first = r.type('@');
  const second = r.type('@fix');
  await first;
  await second;
  assert.deepEqual(r.rows(), ['Fix the build · Chat']);
  // a text box with no caret position reads to its end
  const s = mentionMenu();
  s.els.text.value = '@hack';
  s.els.text.selectionStart = undefined;
  await s.m.update();
  assert.deepEqual(s.rows(), ['Hacker News · https://news.ycombinator.com/']);
});

test('the page: Enter in the @ menu picks rather than sends; the message goes with the token', async () => {
  const p = panelPage({
    reply: (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'recent') return { status: 'connected', result: { chats: CHATS } };
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'claude:9' } };
      return { status: 'connected', result: {} };
    },
    tab: null,
  });
  p.els['mention-menu'] = Object.assign(el(), { hidden: true });
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'Summarize @kyo';
  p.els.text.listeners.input();
  await tick();
  await tick();
  p.els.text.listeners.keydown({ key: 'Enter', preventDefault: () => undefined });
  assert.equal(p.sent().filter((m: any) => m.method === 'start').length, 0);
  assert.equal(p.els.text.value, `Summarize ${chatToken('c1', 'Kyoto trip')} `);
  p.els.text.listeners.keydown({ key: 'Enter', preventDefault: () => undefined });
  await tick();
  await tick();
  assert.equal(p.sent().find((m: any) => m.method === 'start').params.text, `Summarize ${chatToken('c1', 'Kyoto trip')}`);
});

test('an @ inside a picked title is part of it, not a new mention; a mention shows as its name', async () => {
  const p = mentionMenu();
  const token = chatToken('c9', 'Ask @bob about it');
  await p.type(`${token} and more`);
  assert.equal(p.els['mention-menu'].hidden, true);
  await p.type(`${token} @kyo`);
  assert.equal(p.els['mention-menu'].hidden, false);
  assert.equal(named(`See ${token} and ${tabToken(TABS[0])}`), 'See @Ask @bob about it and @Hacker News');
  assert.equal(named(chatToken('c1', 'a [b] c')), '@a [b] c');
});
