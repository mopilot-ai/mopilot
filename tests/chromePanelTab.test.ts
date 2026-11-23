// One side panel per Chrome tab (#2325): the panel's own tab from its address, the chat kept for that tab, opening a tab's panel, and the binding following the tab's life.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { tabPanel, reads } from './support/panel-tab-page.ts';
import { tick } from './support/extension-background/fixture.ts';

const { ownerOf, openPanel, perTabPanels, bindingKey, PanelTab, PANEL_PATH } = await import(
  '../electron/chrome-extension/src/panelTab.mjs'
);
const { PanelState } = await import('../electron/chrome-extension/src/panelState.mjs');
function panelChrome() {
  const chrome: any = fakeChromeApi();
  const state = new PanelState(chrome);
  chrome.reply = async (m: any) => {
    if (m.type === 'panelBind') await state.bind(m.tabId, m.chat, m.explicit !== false);
    if (m.type === 'panelDraft') await state.keep(m.tabId, m.text);
    return {};
  };
  return chrome;
}
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const logs = () => {
  const seen: [string, unknown][] = [];
  return { seen, log: (what: string, e: unknown) => seen.push([what, e]) };
};

test('a panel’s tab is the tab id in its address, else none', () => {
  assert.equal(ownerOf('?tabId=42'), 42);
  assert.equal(ownerOf('?tabId=0'), 0);
  for (const s of ['', '?tabId=', '?tabId=-1', '?tabId=1.5', '?tabId=x', '?other=3']) assert.equal(ownerOf(s), null, s);
});

test('opening a tab’s panel sets its own page and opens it in the same call; a bad tab or Chrome refusing is logged', async () => {
  const chrome: any = panelChrome();
  const { seen, log } = logs();
  openPanel(chrome, { id: 7 }, log);
  assert.deepEqual(
    chrome.log.filter((l: any) => l[0].startsWith('sidePanel.')),
    [
      ['sidePanel.setOptions', { tabId: 7, path: `${PANEL_PATH}?tabId=7`, enabled: true }],
      ['sidePanel.open', { tabId: 7 }],
    ],
  );
  openPanel(chrome, null, log);
  openPanel(chrome, { id: -1 }, log);
  assert.equal(chrome.log.filter((l: any) => l[0].startsWith('sidePanel.')).length, 2);
  chrome.fail['sidePanel.open'] = new Error('no gesture');
  openPanel(chrome, { id: 8 }, log);
  await tick();
  assert.deepEqual(
    seen.map(([w, e]: any) => [w, e.message]),
    [['open the side panel', 'no gesture']],
  );
  // a sidePanel API that throws synchronously
  chrome.sidePanel.setOptions = () => {
    throw new Error('sync');
  };
  openPanel(chrome, { id: 9 }, log);
  assert.equal((seen.at(-1) as any)[1].message, 'sync');
});

test('no extension-wide panel: the toolbar’s own opening is off and only a tab’s panel shows', async () => {
  const chrome: any = panelChrome();
  const { seen, log } = logs();
  perTabPanels(chrome, log);
  assert.deepEqual(
    chrome.log.filter((l: any) => l[0].startsWith('sidePanel.')),
    [
      ['sidePanel.setPanelBehavior', { openPanelOnActionClick: false }],
      ['sidePanel.setOptions', { enabled: false }],
    ],
  );
  chrome.fail['sidePanel.setOptions'] = new Error('refused');
  perTabPanels(chrome, log);
  await tick();
  assert.equal((seen[0] as any)[1].message, 'refused');
  chrome.sidePanel.setPanelBehavior = () => {
    throw new Error('sync');
  };
  perTabPanels(chrome, log);
  assert.equal((seen.at(-1) as any)[1].message, 'sync');
  // a Chrome without the side panel API
  perTabPanels({}, log);
});

test('a PanelTab reads its own tab (or the tab in front without one), follows only its updates, and keeps its chat', async () => {
  const chrome: any = panelChrome();
  const { seen, log } = logs();
  const mine = chrome.addTab({ title: 'Mine' });
  const front = chrome.addTab({ title: 'Front', active: true });
  const own = new PanelTab({ chrome, search: `?tabId=${mine.id}`, log });
  assert.equal(own.id, mine.id);
  assert.equal((await own.read()).title, 'Mine');
  assert.equal(own.follows(mine.id, { active: false }), true);
  assert.equal(own.follows(front.id, { active: true }), false);
  assert.equal(own.followsFront, false);
  assert.equal(await own.bound(), null);
  own.bind({ id: 'chat-1', title: 'Cancel booking' });
  await tick();
  assert.deepEqual(await own.bound(), { id: 'chat-1', title: 'Cancel booking' });
  own.bind(null);
  await tick();
  assert.deepEqual(await own.bound(), { id: null, title: 'New chat' });
  // corrupt storage is reported; an omitted title is valid
  await chrome.storage.session.set({ [bindingKey(mine.id)]: { id: '' } });
  await assert.rejects(own.bound(), /saved chat couldn't be read/);
  await chrome.storage.session.set({ [bindingKey(mine.id)]: { id: 'c' } });
  assert.deepEqual(await own.bound(), { id: 'c', title: 'New chat' });
  // the tab closed: nothing to read
  chrome.tabsById.delete(mine.id);
  assert.equal(await own.read(), null);
  // storage failing is said, and reads as no chat
  chrome.fail['storage.session.get'] = new Error('unreadable');
  await assert.rejects(own.bound(), /unreadable/);
  chrome.fail['storage.session.set'] = new Error('full');
  own.bind({ id: 'x', title: 'x' });
  await tick();
  assert.deepEqual(
    seen.map(([w]) => w),
    ['keep this tab’s chat'],
  );

  // a panel opened without its tab follows the tab in front, and keeps nothing
  const loose = new PanelTab({ chrome, search: '', log });
  assert.equal(loose.followsFront, true);
  assert.equal((await loose.read()).title, 'Front');
  assert.equal(loose.follows(99, { active: true }), true);
  assert.equal(loose.follows(99, {}), false);
  assert.equal(await loose.bound(), null);
  const writes = chrome.log.filter((l: any) => l[0] === 'storage.session.set').length;
  loose.bind({ id: 'y', title: 'y' });
  assert.equal(chrome.log.filter((l: any) => l[0] === 'storage.session.set').length, writes);
  chrome.tabsById.delete(front.id);
  assert.equal(await loose.read(), null);
});

test('a tab’s panel opens the chat kept for that tab', async () => {
  const p = tabPanel({ bound: { id: 'kept', title: 'Cancel booking' } });
  const panel = startSidePanel(p.g);
  await panel.ready;
  await tick();
  assert.deepEqual(reads(p), ['kept']);
  assert.equal(p.els.title.textContent, 'Cancel booking');
});

test('a tab in a chat’s tab group opens that chat; a tab of none opens a new chat', async () => {
  const p = tabPanel({ owner: { id: 'owner', title: 'MoPilot' } });
  const panel = startSidePanel(p.g);
  await panel.ready;
  await tick();
  assert.deepEqual(reads(p), ['owner']);
  // the chat is now this tab's
  assert.equal(p.chrome.store.session[bindingKey(p.tab.id)], undefined, 'an inherited owner is not an explicit choice');

  const q = tabPanel();
  const fresh = startSidePanel(q.g);
  await fresh.ready;
  await tick();
  assert.deepEqual(reads(q), []);
  assert.equal(q.els.chat.hidden, true);
});

test('the panel reads only its own tab: another tab coming to the front or changing is not its', async () => {
  const p = tabPanel();
  const panel = startSidePanel(p.g);
  await panel.ready;
  await tick();
  assert.equal(p.els['tab-title'].textContent, 'Hacker News');
  p.other.active = true;
  p.chrome.tabs.onActivated.fire({ tabId: p.other.id });
  p.chrome.tabs.onUpdated.fire(p.other.id, { title: 'Other' }, p.other);
  await tick();
  assert.equal(p.els['tab-title'].textContent, 'Hacker News');
  p.tab.title = 'Renamed';
  p.chrome.tabs.onUpdated.fire(p.tab.id, { title: 'Renamed' }, p.tab);
  await tick();
  assert.equal(p.els['tab-title'].textContent, 'Renamed');
});

test('a chat started or picked in a tab’s panel is kept for that tab; New chat forgets it', async () => {
  const p = tabPanel();
  const panel = startSidePanel(p.g);
  await panel.ready;
  await tick();
  p.els.text.value = 'Can I cancel for free?';
  p.els.text.listeners.input?.();
  await p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  assert.deepEqual(p.chrome.store.session[bindingKey(p.tab.id)], { id: 'chat-9', title: 'Can I cancel for free?' });
  p.els.new.listeners.click();
  await tick();
  assert.deepEqual(p.chrome.store.session[bindingKey(p.tab.id)], { id: null });
});

test('the background says whose tab group a tab is in, and a tab’s chat follows the tab closing or being replaced', async () => {
  const { background, ask } = await import('./support/extension-background/fixture.ts');
  const { chrome, bg, warn } = await background();
  try {
    bg.sessions.chats.set('chat-a', { title: 'Cancel booking', groupId: 1, tabs: new Set([12]), attached: new Set(), turn: 0 });
    bg.sessions.owner.set(12, 'chat-a');
    bg.sessions.chats.set('chat-b', { title: '', groupId: 2, tabs: new Set([13]), attached: new Set(), turn: 0 });
    bg.sessions.owner.set(13, 'chat-b');
    bg.sessions.owner.set(14, 'chat-gone');
    assert.deepEqual(await ask(chrome, { type: 'tabChat', tabId: 12 }), { chat: { id: 'chat-a', title: 'Cancel booking' } });
    assert.deepEqual(await ask(chrome, { type: 'tabChat', tabId: 13 }), { chat: { id: 'chat-b', title: '' } });
    assert.deepEqual(await ask(chrome, { type: 'tabChat', tabId: 14 }), { chat: { id: 'chat-gone', title: 'MoPilot' } });
    assert.deepEqual(await ask(chrome, { type: 'tabChat', tabId: 99 }), { chat: null });

    await chrome.storage.session.set({ [bindingKey(20)]: { id: 'c', title: 'T' }, [bindingKey(21)]: { id: 'd', title: 'U' } });
    chrome.tabs.onRemoved.fire(20);
    chrome.tabs.onReplaced.fire(22, 21);
    await tick();
    assert.equal(chrome.store.session[bindingKey(20)], undefined);
    assert.deepEqual(chrome.store.session[bindingKey(22)], { id: 'd', title: 'U' });
    assert.equal(chrome.store.session[bindingKey(21)], undefined);
  } finally {
    warn.mock.restore();
    bg.client?.close?.();
  }
});

test('an explicit New chat survives reopening on a tab owned by another chat', async () => {
  const p = tabPanel({ bound: { id: null }, owner: { id: 'old', title: 'Old' } });
  await startSidePanel(p.g).ready;
  await tick();
  assert.deepEqual(reads(p), []);
  assert.equal(p.els.title.textContent, 'New chat');
});

test('New chat retires a restore that is still reading storage', async () => {
  const p = tabPanel();
  let finish: any;
  const get = p.chrome.storage.session.get;
  p.chrome.storage.session.get = async (key: any) =>
    key === bindingKey(p.tab.id)
      ? new Promise((r) => {
          finish = r;
        })
      : get(key);
  await startSidePanel(p.g).ready;
  await tick();
  p.els.new.listeners.click();
  finish({ [bindingKey(p.tab.id)]: { id: 'old', title: 'Old' } });
  await tick();
  assert.deepEqual(reads(p), []);
  assert.equal(p.els.title.textContent, 'New chat');
});

test('a deleted chat returns to New chat; a transient read failure keeps its binding', async () => {
  for (const message of ["That chat isn't in MoPilot.", 'Connection lost']) {
    const p = tabPanel({ bound: { id: 'old', title: 'Old' } });
    const send = p.chrome.runtime.sendMessage;
    p.chrome.runtime.sendMessage = async (m: any) => (m.method === 'read' ? { status: 'connected', error: message } : send(m));
    await startSidePanel(p.g).ready;
    await tick();
    assert.deepEqual(
      p.chrome.store.session[bindingKey(p.tab.id)],
      message.startsWith('That chat') ? undefined : { id: 'old', title: 'Old' },
    );
    assert.equal(p.els.error.textContent, message);
  }
});

test('a replaced tab follows only its own live panel in place', async () => {
  const p = tabPanel();
  const paths: string[] = [];
  p.g.location.replace = (url: string) => paths.push(url);
  await startSidePanel(p.g).ready;
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'tabReplaced', added: 90, removed: p.other.id } });
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'tabReplaced', added: 91, removed: p.tab.id } });
  assert.deepEqual(paths, []);
  await tick();
  assert.equal(p.els['tab-title'].textContent, '');
});

test('the panel reports a failed binding read, and a group chat with no title has a default', async () => {
  const p = tabPanel();
  p.chrome.fail['storage.session.get'] = new Error('storage unavailable');
  await startSidePanel(p.g).ready;
  await tick();
  assert.equal(p.els.error.textContent, 'storage unavailable');
  const q = tabPanel({ owner: { id: 'blank', title: '' } });
  await startSidePanel(q.g).ready;
  await tick();
  assert.equal(q.els.title.textContent, 'New chat');
  assert.deepEqual(reads(q), ['blank']);
});

test('Chrome may return no tab without rejecting; a pending restore cannot replace a newly sent chat', async () => {
  const chrome: any = panelChrome();
  chrome.tabs.get = async () => null;
  const own = new PanelTab({ chrome, search: '?tabId=9', log: () => {} });
  assert.equal(await own.read(), null);
  const p = tabPanel();
  let finish: any;
  const get = p.chrome.storage.session.get;
  p.chrome.storage.session.get = async (key: any) =>
    key === bindingKey(p.tab.id)
      ? new Promise((r) => {
          finish = r;
        })
      : get(key);
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'New message';
  await p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  finish({ [bindingKey(p.tab.id)]: { id: 'old', title: 'Old' } });
  await tick();
  assert.equal(p.els.title.textContent, 'New message');
  assert.ok(!reads(p).includes('old'));
});

test('a non-Error storage rejection still produces a readable restore error', async () => {
  for (const reason of ['storage denied', null]) {
    const p = tabPanel();
    p.chrome.storage.session.get = async () => {
      throw reason;
    };
    await startSidePanel(p.g).ready;
    await tick();
    assert.equal(
      p.els.error.textContent,
      "This tab's chat could not be saved or restored. Keep this panel open; choose the chat again to retry.",
    );
  }
});

test('deleted and late old-chat errors keep input and cannot reset a replacement chat', async () => {
  const p = tabPanel({ bound: { id: 'old', title: 'Old' } });
  const send = p.chrome.runtime.sendMessage;
  let finish: any;
  p.chrome.runtime.sendMessage = async (m: any) =>
    m.method === 'read'
      ? new Promise((r) => {
          finish = r;
        })
      : send(m);
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'Unsent draft';
  finish({ status: 'connected', code: 'panel_chat_gone', error: 'Updated wording' });
  await tick();
  assert.equal(p.els.text.value, 'Unsent draft');
  assert.equal(p.els.title.textContent, 'New chat');
  assert.equal(p.chrome.store.session[bindingKey(p.tab.id)], undefined);
});

test('the stable deleted-chat code crosses main, the panel link and the background unchanged', async () => {
  const { ChromePanel } = await import('../electron/capabilities/browser/chromePanel.cjs');
  const replies: any[] = [];
  const main = new (ChromePanel as any)({
    read: async () => {
      throw new Error("That chat isn't in MoPilot.");
    },
  });
  await main.handle({ id: 1, method: 'read', params: { chatId: 'gone' } }, (r: any) => replies.push(r));
  assert.equal(replies[0].code, 'panel_chat_gone');
  const { background, ask, FakeWs, handshake } = await import('./support/extension-background/fixture.ts');
  const { chrome, bg, warn } = await background({ pairing: `mopilot-chrome:1:47615:${'S'.repeat(43)}` });
  try {
    const ws = FakeWs.all.at(-1)!;
    await handshake(ws, { secret: 'S'.repeat(43) });
    const pending = ask(chrome, { type: 'panel', method: 'read', params: { chatId: 'gone' } });
    await tick();
    await ws.from({ type: 'panel', id: ws.sent.at(-1).id, error: 'Updated wording', code: 'panel_chat_gone' });
    assert.deepEqual(await pending, { status: 'connected', error: 'Updated wording', code: 'panel_chat_gone' });
  } finally {
    warn.mock.restore();
    bg.client.dispose();
  }
});

test('restore does nothing for a live chat, a retired tab, or a panel without a tab', async () => {
  const chrome: any = panelChrome();
  for (const search of ['', '?tabId=1']) {
    const own = new PanelTab({ chrome, search, log: () => {} });
    const fail = () => assert.fail('must not read or open');
    await own.restore(fail, () => true, fail);
    own.retire(1);
    await own.restore(fail, () => false, fail);
  }
});

test('composer drafts restore without overwriting new typing, and replacement preserves the live input on failure', async () => {
  const { composerKey } = await import('../electron/chrome-extension/src/panelState.mjs');
  const p = tabPanel();
  await p.chrome.storage.session.set({ [composerKey(p.tab.id)]: 'Saved draft' });
  await startSidePanel(p.g).ready;
  await tick();
  assert.equal(p.els.text.value, 'Saved draft');
  p.els.text.value = 'New typing';
  p.els.text.listeners.input();
  p.timers.timeouts.findLast((t: any) => t.ms === 250)!.f();
  await tick();
  assert.equal(p.chrome.store.session[composerKey(p.tab.id)], 'New typing');
  p.chrome.tabs.onReplaced.fire(p.other.id, p.tab.id);
  p.chrome.runtime.onMessage.fire({
    type: 'panelEvent',
    event: { kind: 'tabReplaced', added: p.other.id, removed: p.tab.id, failed: true },
  });
  await tick();
  assert.equal(p.els.text.value, 'New typing');
  assert.equal(p.els['tab-title'].textContent, 'Other tab');
  assert.match(p.els.error.textContent, /Keep this panel open/);
});

test('the worker handles panel writes and retries a failed replacement before a restored panel reads', async () => {
  const { background, ask } = await import('./support/extension-background/fixture.ts');
  const w = await background();
  try {
    await ask(w.chrome, { type: 'panelBind', tabId: 1, chat: { id: 'chat', title: 'Chat' } });
    await ask(w.chrome, { type: 'panelDraft', tabId: 1, text: 'Draft' });
    w.chrome.fail['storage.session.set'] = new Error('quota');
    w.chrome.tabs.onReplaced.fire(2, 1);
    await tick();
    assert.ok(w.chrome.log.some((l: any[]) => l[0] === 'runtime.sendMessage' && l[1]?.event?.failed));
    delete w.chrome.fail['storage.session.set'];
    assert.deepEqual(await ask(w.chrome, { type: 'panelRepair', tabId: 2 }), {});
    assert.equal(w.chrome.store.session[bindingKey(2)].id, 'chat');
    assert.equal(w.chrome.store.session['panelDraft:2'], 'Draft');
  } finally {
    w.warn.mock.restore();
    w.bg.client.dispose();
  }
});

test('replacement updates every panel tab identity, takes subsequent selection text, and keeps unsent text', async () => {
  const p = tabPanel();
  const paths: string[] = [];
  p.g.history = { replaceState: (_state: any, _unused: any, path: string) => paths.push(path) };
  await startSidePanel(p.g).ready;
  p.els.text.value = 'Unsent';
  p.els.text.listeners.input();
  p.chrome.tabs.onReplaced.fire(p.other.id, p.tab.id);
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'tabReplaced', added: p.other.id, removed: p.tab.id } });
  await tick();
  assert.deepEqual(paths, [`sidepanel.html?tabId=${p.other.id}`]);
  const reply = p.chrome.reply;
  p.chrome.reply = (m: any) => (m.type === 'takeDraft' ? Promise.resolve({ text: 'Selection after replacement' }) : reply(m));
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'draft', tabId: p.other.id } });
  await tick();
  assert.equal(p.els.text.value, 'Unsent\n\nSelection after replacement');
});

test('pagehide flushes the latest coalesced composer and a successful Send clears the saved draft', async () => {
  const p = tabPanel();
  const events: Record<string, Function> = {};
  p.g.addEventListener = (name: string, f: Function) => {
    events[name] = f;
  };
  await startSidePanel(p.g).ready;
  p.els.text.value = 'Draft A';
  p.els.text.listeners.input();
  p.els.text.value = 'Draft AB';
  p.els.text.listeners.input();
  events.pagehide();
  await tick();
  assert.equal(p.chrome.store.session['panelDraft:' + p.tab.id], 'Draft AB');
  p.els.harness.value = 'claude';
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  events.pagehide();
  await tick();
  assert.equal(p.chrome.store.session['panelDraft:' + p.tab.id], '');
});

test('an oversized composer tells the user to shorten it and keeps the full input', async () => {
  const p = tabPanel();
  await startSidePanel(p.g).ready;
  const text = 'x'.repeat(100_001);
  p.els.text.value = text;
  p.els.text.listeners.input();
  p.timers.timeouts.findLast((t: any) => t.ms === 250)!.f();
  await tick();
  assert.match(p.els.error.textContent, /too long to save/);
  assert.equal(p.els.text.value, text);
});

test('a gone inherited chat resets once; subsequent connected renders never retry the stale owner in a loop', async () => {
  const p = tabPanel({ owner: { id: 'gone', title: 'Gone' } });
  const reply = p.chrome.reply;
  p.chrome.reply = (m: any) =>
    m.type === 'panel' && m.method === 'read'
      ? Promise.resolve({ status: 'connected', code: 'panel_chat_gone', error: "That chat isn't in MoPilot." })
      : reply(m);
  const panel = startSidePanel(p.g);
  await panel.ready;
  await tick();
  for (let i = 0; i < 3; i++) {
    await panel.refresh();
    await tick();
  }
  assert.deepEqual(reads(p), ['gone']);
  assert.equal(p.els.title.textContent, 'New chat');
});
