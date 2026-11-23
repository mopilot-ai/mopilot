// The tab in front's notices and the blocked page (#1986 PR 5): src/tabNotices.mjs, src/panelNotice.mjs, src/blockedPage.mjs, and "Ask MoPilot" in the context menu (src/contextMenu.mjs), with their background answers and side-panel wiring.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { background, tick } from './support/extension-background/fixture.ts';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { TabNotices, NOTICES, blockedPage } = await import('../electron/chrome-extension/src/tabNotices.mjs');
const { PanelNotice } = await import('../electron/chrome-extension/src/panelNotice.mjs');
const { blockedUrl, showBlocked } = await import('../electron/chrome-extension/src/blockedPage.mjs');
const { ContextMenu, ASK_MENU, MAX_DRAFT, draftKey } = await import('../electron/chrome-extension/src/contextMenu.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const POLICY = { blockedUrlPatterns: ['blocked.example'] };

function notices(o: { policy?: any } = {}) {
  const chrome: any = fakeChromeApi();
  chrome.storage.managed = { get: async () => o.policy ?? POLICY };
  const held = new Set<number>();
  let told = 0;
  const logged: string[] = [];
  const n = new TabNotices({ chrome, held: (id: number) => held.has(id), notify: () => told++, log: (w: string) => logged.push(w) });
  return { chrome, n, held, told: () => told, logged };
}

test('TabNotices: an admin-blocked site reads as such; a tab another extension blocks reads Retry until its next page, close or Retry', async () => {
  const t = notices();
  assert.equal(await t.n.of(1, 'https://www.blocked.example/a'), NOTICES.admin);
  assert.equal(await t.n.of(1, 'https://ok.example/'), null);
  t.n.extensionBlocked(1);
  t.n.extensionBlocked(1);
  assert.equal(t.told(), 1, 'told once per tab');
  assert.equal(await t.n.of(1, 'https://ok.example/'), NOTICES.extension);
  // a frame's commit isn't a new page; the main frame's is
  t.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 3 });
  assert.equal(await t.n.of(1, 'https://ok.example/'), NOTICES.extension);
  t.chrome.webNavigation.onCommitted.fire({ tabId: 1, frameId: 0 });
  assert.equal(await t.n.of(1, 'https://ok.example/'), null);
  assert.equal(t.told(), 2);
  // closed: gone; a tab with nothing to clear tells nobody
  t.n.extensionBlocked(2);
  t.chrome.tabs.onRemoved.fire(2);
  t.chrome.tabs.onRemoved.fire(2);
  assert.equal(t.told(), 4);
  // Retry reloads only a blocked tab
  assert.equal(await t.n.retry(3), false);
  t.n.extensionBlocked(3);
  assert.equal(await t.n.retry(3), true);
  assert.deepEqual(
    t.chrome.log.filter((l: any) => l[0] === 'tabs.reload'),
    [['tabs.reload', 3]],
  );
  assert.equal(await t.n.of(3, 'https://ok.example/'), null);
});

test('TabNotices: a tab an agent holds that starts loading a blocked site shows the blocked page; the user’s tabs, frames and allowed sites never', async () => {
  const t = notices();
  t.held.add(5);
  assert.equal(await t.n.navigating({ tabId: 6, frameId: 0, url: 'https://blocked.example/' }), false, 'the user’s own tab');
  assert.equal(await t.n.navigating({ tabId: 5, frameId: 2, url: 'https://blocked.example/' }), false, 'a frame');
  assert.equal(await t.n.navigating({ tabId: 5, frameId: 0, url: 'https://fine.example/' }), false);
  assert.equal(await t.n.navigating({ tabId: 5, frameId: 0, url: 'https://blocked.example/x?y=1' }), true);
  const url = blockedPage(t.chrome, 'https://blocked.example/x?y=1');
  assert.deepEqual(
    t.chrome.log.filter((l: any) => l[0] === 'tabs.update'),
    [['tabs.update', 5, { url }]],
  );
  assert.match(url, /^chrome-extension:\/\/[a-z]+\/blocked\.html#url=https%3A%2F%2Fblocked\.example%2Fx%3Fy%3D1$/);
  // through Chrome's event: a failure is logged, not thrown
  t.chrome.tabs.update = async () => {
    throw new Error('No tab with id: 5.');
  };
  t.chrome.webNavigation.onBeforeNavigate.fire({ tabId: 5, frameId: 0, url: 'https://blocked.example/' });
  await tick();
  assert.deepEqual(t.logged, ['show the blocked page']);
  // no policy (an unmanaged browser): nothing is blocked
  const free = notices({ policy: {} });
  free.held.add(5);
  assert.equal(await free.n.navigating({ tabId: 5, frameId: 0, url: 'https://blocked.example/' }), false);
});

test('the blocked page shows the address as text, only a web address, with Go back', () => {
  assert.equal(blockedUrl('#url=https%3A%2F%2Fblocked.example%2F'), 'https://blocked.example/');
  assert.equal(blockedUrl('url=javascript%3Aalert(1)'), '');
  assert.equal(blockedUrl(''), '');
  assert.equal(blockedUrl(`#url=https://a.example/${'x'.repeat(3000)}`).length, 2000);
  const els: Record<string, any> = {};
  const history = { back: mock.fn() };
  showBlocked({
    document: { getElementById: (id: string) => (els[id] ??= el()) },
    location: { hash: '#url=https%3A%2F%2Fblocked.example%2F%3Cb%3E' },
    history,
  });
  assert.equal(els['blocked-url'].textContent, 'https://blocked.example/<b>');
  els.back.listeners.click();
  assert.equal(history.back.mock.callCount(), 1);
});

test('PanelNotice: reads the tab in front, drops a late answer, Retry reloads then reads again, and a failure says so', async () => {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()) };
  const answers: Record<number, any> = { 1: { notice: NOTICES.extension }, 2: { notice: NOTICES.admin } };
  const asked: any[] = [];
  let gate: Promise<void> | null = null;
  const errors: string[] = [];
  const ask = async (m: any) => {
    asked.push(m);
    if (m.type === 'retryTab') {
      if (m.tabId === 9) throw new Error('No tab with id: 9.');
      answers[1] = { notice: null };
      return { retried: true };
    }
    if (gate) await gate;
    if (m.tabId === 4) throw new Error('worker gone');
    return answers[m.tabId];
  };
  const n = new PanelNotice({ document, ask, onError: (t: string) => errors.push(t) });
  await n.retry();
  assert.equal(asked.length, 0, 'no tab: nothing to retry');
  await n.read(1);
  assert.equal(els.notice.hidden, false);
  assert.equal(els['notice-text'].textContent, NOTICES.extension.text);
  assert.equal(els['notice-act'].hidden, false);
  assert.equal(els['notice-act'].textContent, 'Retry');
  // tab 2's answer comes after tab 3's: dropped
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  const slow = n.read(2);
  gate = null;
  await n.read(null);
  open();
  await slow;
  assert.equal(els.notice.hidden, true);
  await n.read(2);
  assert.equal(els['notice-act'].hidden, true, 'the admin line has no button');
  // Retry
  await n.read(1);
  els['notice-act'].listeners.click();
  await tick();
  assert.deepEqual(
    asked.filter((m) => m.type === 'retryTab'),
    [{ type: 'retryTab', tabId: 1 }],
  );
  assert.equal(els.notice.hidden, true);
  // the background failing: the line stays away, Retry's failure is said
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    await n.read(4);
    assert.equal(els.notice.hidden, true);
    n.tabId = 9;
    await n.retry();
    assert.deepEqual(errors, ['No tab with id: 9.']);
  } finally {
    warn.mock.restore();
  }
});

function menu() {
  const chrome: any = fakeChromeApi();
  const told: number[] = [];
  const logged: string[] = [];
  const m = new ContextMenu({ chrome, notify: (w: number) => told.push(w), log: (w: string) => logged.push(w) });
  return { chrome, m, told, logged };
}

test('ContextMenu: added on install, on pages and selections; a click opens that tab’s panel at once and keeps its selection for its window', async () => {
  const t = menu();
  t.chrome.runtime.onInstalled.fire({ reason: 'update' });
  await tick();
  assert.deepEqual(
    t.chrome.log.filter((l: any) => /^contextMenus/.test(l[0])),
    [['contextMenus.removeAll'], ['contextMenus.create', { id: ASK_MENU, title: 'Ask MoPilot', contexts: ['page', 'selection'] }]],
  );
  // a selection: the panel opens in the click's own call (before any await), the text waits for that window
  t.chrome.contextMenus.onClicked.fire({ menuItemId: ASK_MENU, selectionText: `  pick ${'x'.repeat(MAX_DRAFT)}` }, { id: 70, windowId: 7 });
  assert.deepEqual(t.chrome.log.filter((l: any) => l[0].startsWith('sidePanel.')).slice(-2), [
    ['sidePanel.setOptions', { tabId: 70, path: 'sidepanel.html?tabId=70', enabled: true }],
    ['sidePanel.open', { tabId: 70 }],
  ]);
  await tick();
  assert.equal(t.chrome.store.session[draftKey(70)].length, MAX_DRAFT);
  assert.deepEqual(t.told, [70]);
  assert.equal((await t.m.take(8)).length, 0, 'another window’s panel gets nothing');
  assert.equal((await t.m.take(70)).length, MAX_DRAFT);
  assert.equal(await t.m.take(70), '', 'taken once');
  // a page: the panel opens, nothing waits; another item or no window does nothing
  t.chrome.contextMenus.onClicked.fire({ menuItemId: ASK_MENU, selectionText: '   ' }, { id: 70, windowId: 7 });
  t.chrome.contextMenus.onClicked.fire({ menuItemId: 'other' }, { id: 70, windowId: 7 });
  t.chrome.contextMenus.onClicked.fire({ menuItemId: ASK_MENU }, undefined);
  await tick();
  assert.equal(t.chrome.log.filter((l: any) => l[0] === 'sidePanel.open').length, 2);
  assert.deepEqual(t.told, [70]);
  // two takes at once: one gets the text
  await t.chrome.storage.session.set({ [draftKey(1)]: 'once' });
  assert.deepEqual(await Promise.all([t.m.take(1), t.m.take(1)]), ['once', '']);
});

test('ContextMenu: failures to add the item, open the panel or keep the text are logged, not thrown', async () => {
  const t = menu();
  t.chrome.contextMenus.create = (_o: any, done: () => void) => {
    t.chrome.runtime.lastError = { message: 'duplicate id' };
    done();
    t.chrome.runtime.lastError = undefined;
  };
  await t.m.create();
  t.chrome.contextMenus.removeAll = async () => {
    throw new Error('gone');
  };
  await t.m.create();
  t.chrome.sidePanel.open = () => {
    throw new Error('may only be called in response to a user gesture');
  };
  t.chrome.storage.session.set = async () => {
    throw new Error('quota');
  };
  t.chrome.contextMenus.onClicked.fire({ menuItemId: ASK_MENU, selectionText: 'x' }, { id: 20, windowId: 2 });
  t.chrome.sidePanel.open = async () => {
    throw new Error('no window');
  };
  t.chrome.contextMenus.onClicked.fire({ menuItemId: ASK_MENU }, { id: 20, windowId: 2 });
  await tick();
  assert.deepEqual(
    [...t.logged].sort(),
    [
      'add Ask MoPilot to the context menu',
      'add Ask MoPilot to the context menu',
      'open the side panel',
      'keep the selected text for the side panel',
      'open the side panel',
    ].sort(),
  );
  // a take after a failed one still runs
  t.chrome.storage.session.get = async () => {
    throw new Error('worker gone');
  };
  await assert.rejects(t.m.take(2), /worker gone/);
  t.chrome.storage.session.get = async () => ({});
  assert.equal(await t.m.take(2), '');
});

test('the background answers the panel’s tab notice, Retry and waiting text, and tells the panel when they change', async () => {
  const { chrome, bg, warn } = await background({
    before: (c: any) => {
      c.storage.managed = { get: async () => POLICY };
    },
  });
  try {
    const own = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html` };
    const ask = (m: any) => new Promise<any>((resolve) => chrome.runtime.onMessage.fire(m, own, resolve));
    const blocked = chrome.addTab({ url: 'https://blocked.example/' });
    const fine = chrome.addTab({ url: 'https://fine.example/' });
    assert.deepEqual(await ask({ type: 'tabNotice', tabId: blocked.id }), { notice: NOTICES.admin });
    assert.deepEqual(await ask({ type: 'tabNotice', tabId: 999 }), { notice: null }, 'a tab that is gone');
    const sends: any[] = [];
    chrome.runtime.sendMessage = async (m: any) => sends.push(m);
    bg.sessions.debuggers.onBlocked(fine.id);
    assert.deepEqual(sends.at(-1), { type: 'panelEvent', event: { kind: 'tabNotice' } });
    assert.deepEqual(await ask({ type: 'tabNotice', tabId: fine.id }), { notice: NOTICES.extension });
    assert.deepEqual(await ask({ type: 'retryTab', tabId: fine.id }), { retried: true });
    assert.deepEqual(await ask({ type: 'tabNotice', tabId: fine.id }), { notice: null });
    // the context menu's text, for the window that asks
    chrome.contextMenus.onClicked.fire({ menuItemId: ASK_MENU, selectionText: 'quote' }, { windowId: 3, id: 3 });
    await tick();
    assert.deepEqual(sends.at(-1), { type: 'panelEvent', event: { kind: 'draft', tabId: 3 } });
    assert.deepEqual(await ask({ type: 'takeDraft', tabId: 3 }), { text: 'quote' });
    // an agent's tab loading a blocked site gets the blocked page
    bg.sessions.owner.set(fine.id, 'chat');
    chrome.webNavigation.onBeforeNavigate.fire({ tabId: fine.id, frameId: 0, url: 'https://blocked.example/' });
    await tick();
    assert.equal(chrome.log.filter((l: any) => l[0] === 'tabs.update').at(-1)[1], fine.id);
  } finally {
    warn.mock.restore();
  }
});

test('the side panel: the notice follows the tab in front and the background’s word; the context menu’s text lands in the box for its window only', async () => {
  const p = panelPage({
    reply: (m: any) => {
      if (m.type === 'tabNotice') return { notice: m.tabId === 500 ? NOTICES.extension : null };
      if (m.type === 'takeDraft') return { text: m.tabId === 500 ? 'selected words' : '' };
      if (m.type === 'retryTab') return { retried: true };
      if (m.type !== 'panel') return { status: 'connected' };
      return { status: 'connected', result: m.method === 'harnesses' ? { harnesses: [{ id: 'claude', label: 'Claude Code' }] } : {} };
    },
  });
  p.g.document.getElementById('text').value = 'already typed';
  const { ready } = startSidePanel(p.g);
  await ready;
  assert.equal(p.els.notice.hidden, false);
  assert.equal(p.els['notice-text'].textContent, NOTICES.extension.text);
  assert.equal(p.els.text.value, 'already typed\n\nselected words');
  assert.ok(p.els.text.focused > 0);
  // the background says a notice changed, or more text waits (only this window's is taken)
  const sent = () => p.sent().filter((m: any) => m.type === 'tabNotice' || m.type === 'takeDraft').length;
  const before = sent();
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'tabNotice' } });
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'draft', tabId: 2 } });
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'draft', tabId: 500 } });
  await tick();
  assert.equal(sent(), before + 2);
  assert.equal(p.els.text.value, 'already typed\n\nselected words\n\nselected words');
  // an empty box takes the text as it is
  p.els.text.value = '';
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'draft', tabId: 500 } });
  await tick();
  assert.equal(p.els.text.value, 'selected words');
  // a failed draft read is reported without taking away the typed message
  const q = panelPage();
  const send = q.chrome.runtime.sendMessage;
  q.chrome.runtime.sendMessage = async (m: any) => {
    if (m.type === 'takeDraft') throw new Error('no draft');
    return send(m);
  };
  await startSidePanel(q.g).ready;
  assert.equal(q.els.error.textContent, 'no draft');
});

test('the side panel: a state button that fails says why in the state, as a reply would', async () => {
  const p = panelPage({ reply: (m: any) => (m.type === 'status' ? { status: 'offline', missing: true } : { status: 'offline' }) });
  await startSidePanel(p.g).ready;
  assert.equal(p.els['state-act'].textContent, 'Download MoPilot');
  p.chrome.runtime.sendMessage = async () => {
    throw new Error('Extension context invalidated.');
  };
  p.els['state-act'].dataset.send = 'download';
  p.els['state-act'].listeners.click({ currentTarget: p.els['state-act'] });
  await tick();
  assert.equal(p.els['state-text'].textContent, 'Extension context invalidated.');
});

test('the blocked page entry starts the page on its window; a panel with no web page in front reads no notice', async () => {
  const els: Record<string, any> = {};
  const g = globalThis as any;
  const saved = { document: g.document, location: g.location, history: g.history };
  Object.assign(g, {
    document: { getElementById: (id: string) => (els[id] ??= el()) },
    location: { hash: '#url=https%3A%2F%2Fblocked.example%2F' },
    history: { back: () => undefined },
  });
  try {
    await import('../electron/chrome-extension/blocked.mjs');
    assert.equal(els['blocked-url'].textContent, 'https://blocked.example/');
  } finally {
    Object.assign(g, saved);
  }
  const p = panelPage({ tab: null });
  await startSidePanel(p.g).ready;
  const before = p.sent().filter((m: any) => m.type === 'tabNotice').length;
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'tabNotice' } });
  await tick();
  assert.equal(p.sent().filter((m: any) => m.type === 'tabNotice').length, before);
  assert.equal(p.els.notice.hidden, true);
});
