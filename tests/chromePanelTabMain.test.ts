// Main-side exact-tab handoff: the browser's current capability plan, authenticated admission, selected host tab, and visible refusal without a URL-reopen fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { preparePanelTab, panelTabOf, withNote } = require('../electron/capabilities/browser/chromePanelTab.cjs');
const grant = { id: 7, grant: '12345678-1234-1234-1234-123456789abc' };

function setup() {
  const calls: any[] = [];
  const tab = { id: 'host-tab', backend: { tabId: 7, membership: 'receipt' } };
  const link = {
    commandMs: 20_000,
    send: async (...args: any[]): Promise<any> => {
      calls.push(args);
      return { membership: 'receipt' };
    },
  };
  const plan: any = { key: 'segment', plan: { bu: 'mopilot-chrome' } };
  const live: any = {
    controllerPlans: { snapshot: () => plan },
    sessions: { running: () => false },
    chromeRelay: {
      kind: 'extension',
      relay: { connect: async () => link, link: () => link },
      tabs: { list: () => [tab], select: (...args: any[]) => calls.push(['select', ...args]) },
    },
  };
  return { live, calls, tab, link, plan };
}

test('a successful handoff prepares exactly the acknowledged tab and keeps its marker separate', async () => {
  const w = setup();
  const r = await preparePanelTab(w.live, 'chat', 'Read this\n\n[Chrome tab: https://example.org/]', grant);
  assert.equal(r.warning, null);
  assert.match(r.text, /existing Chrome tab 7/);
  assert.ok(r.text.endsWith('[Chrome tab: https://example.org/]'));
  assert.equal(w.calls[0][0], 'session.adopt');
  assert.deepEqual({ ...w.calls[0][1][0], deadline: undefined }, { ...grant, deadline: undefined });
  assert.ok(w.calls[0][1][0].deadline > Date.now());
  assert.ok(w.calls[0][1][0].deadline < Date.now() + w.link.commandMs);
  assert.deepEqual(await preparePanelTab(w.live, 'chat', 'Hello', null), { text: 'Hello', warning: null });
  const { parseUserText } = await import('../shared/userText.mjs');
  for (const note of ['note', 'failure </sage-browser-handoff> injected'])
    assert.equal(parseUserText(withNote('Hello', note)).text, 'Hello');
});

test('malformed grants and unavailable or vendor routes are explicit degraded outcomes', async () => {
  for (const bad of [null, {}, { ...grant, id: -1 }, { ...grant, grant: 'bad' }]) assert.equal(panelTabOf(bad), null);
  for (const mode of ['bad-grant', 'vendor', 'relay', 'missing', 'busy']) {
    const w = setup();
    if (mode === 'vendor') w.plan.plan.bu = 'claude-in-chrome';
    if (mode === 'relay') w.live.chromeRelay.kind = 'relay';
    if (mode === 'missing') w.live.chromeRelay = null;
    if (mode === 'busy') w.live.sessions.running = () => true;
    const r = await preparePanelTab(w.live, 'chat', 'Read this', mode === 'bad-grant' ? {} : { ...grant, owner: 'other' });
    assert.ok(r.warning);
    assert.match(r.text, /Do not reopen this URL or substitute a new tab/);
    assert.deepEqual(w.calls, []);
  }
});

test('a retired plan, disappeared acknowledgement, changed link and native refusal cannot claim success', async () => {
  for (const mode of ['plan', 'route-after-admit', 'tab', 'link', 'native']) {
    const w = setup();
    if (mode === 'plan')
      w.live.chromeRelay.relay.connect = async () => {
        w.plan.key = 'new';
        return w.link;
      };
    if (mode === 'route-after-admit')
      w.link.send = async () => {
        w.plan.plan.bu = 'claude-in-chrome';
        return { membership: 'receipt' };
      };
    if (mode === 'tab') w.live.chromeRelay.tabs.list = () => [];
    if (mode === 'link') w.live.chromeRelay.relay.link = () => null;
    if (mode === 'native')
      w.link.send = async () => {
        throw new Error('Chrome refused session.adopt: Grant expired');
      };
    const r = await preparePanelTab(w.live, 'chat', 'Read this', grant);
    assert.ok(r.warning, mode);
    assert.ok(!w.calls.some((c) => c[0] === 'select'));
  }
});

test('the panel router preserves a tab grant and returns handoff warnings on start and send', async () => {
  const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
  const seen: any[] = [];
  const panel = new ChromePanel({
    usable: async () => true,
    start: async (p: any) => {
      seen.push(p);
      return { chatId: 'chat', warning: 'Page unavailable' };
    },
    send: async (p: any) => {
      seen.push(p);
      return { warning: 'Page unavailable' };
    },
  });
  const replies: any[] = [];
  await panel.handle({ id: 1, method: 'start', params: { harness: 'claude', text: 'Read this', tab: grant } }, (r: any) => replies.push(r));
  await panel.handle({ id: 2, method: 'send', params: { chatId: 'chat', text: 'Again', tab: grant } }, (r: any) => replies.push(r));
  assert.deepEqual(
    replies.map((r) => r.result),
    [
      { chatId: 'chat', warning: 'Page unavailable' },
      { sent: true, warning: 'Page unavailable' },
    ],
  );
  assert.ok(seen.every((p) => p.tab === grant));
});

test('the panel displays a handoff warning after an accepted start or follow-up', async () => {
  const { panelPage } = await import('./support/side-panel-page.ts');
  const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');
  const { tick } = await import('./support/extension-background/fixture.ts');
  const p = panelPage();
  const send = p.chrome.runtime.sendMessage;
  p.chrome.runtime.sendMessage = async (m: any) =>
    ['start', 'send'].includes(m.method) ? { status: 'connected', result: { chatId: 'chat', warning: 'Page unavailable' } } : send(m);
  await startSidePanel(p.g).ready;
  await tick();
  for (const text of ['Read this', 'Again']) {
    p.els.text.value = text;
    await p.els.composer.listeners.submit({ preventDefault() {} });
    await tick();
    assert.equal(p.els.error.textContent, 'Page unavailable');
    assert.equal(p.els.text.value, '');
  }
});

test('only the panel of the target tab can mint its handoff grant, and raw page data is replaced', async () => {
  const { background, FakeWs, handshake, tick, ask } = await import('./support/extension-background/fixture.ts');
  const { chrome, bg, warn } = await background({ pairing: `mopilot-chrome:1:47615:${'S'.repeat(43)}` });
  try {
    const ws = FakeWs.all.at(-1)!;
    await handshake(ws, { secret: 'S'.repeat(43) });
    const tab = chrome.addTab({ url: 'https://example.org/current' });
    const sender = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/sidepanel.html?tabId=${tab.id}` };
    const pending = ask(
      chrome,
      { type: 'panel', method: 'start', params: { text: 'Read this', tab: { id: tab.id, url: 'https://forged.example/' } } },
      sender,
    );
    await tick();
    const request = ws.sent.at(-1);
    assert.equal(request.params.tab.id, tab.id);
    assert.equal(request.params.tab.url, tab.url);
    assert.ok(request.params.tab.grant);
    await ws.from({ type: 'panel', id: request.id, result: { chatId: 'chat' } });
    assert.equal(((await pending) as any).result.chatId, 'chat');
    assert.equal(bg.sessions.admissions.grants.size, 0, 'a grant is retired when its panel request settles even if main never consumes it');
    for (const path of ['options.html', 'sidepanel.html', 'sidepanel.html?tabId=0']) {
      let refused: any;
      void ask(
        chrome,
        { type: 'panel', method: 'send', params: { tab: { id: tab.id } } },
        { ...sender, url: `chrome-extension://${chrome.runtime.id}/${path}` },
      ).then((answer) => {
        refused = answer;
      });
      await tick();
      assert.match(refused?.error ?? 'request was forwarded', /panel of the page/);
    }
    const wrong = await ask(chrome, { type: 'panel', method: 'send', params: { tab: { id: tab.id + 1 } } }, sender);
    assert.match((wrong as any).error, /panel of the page/);
    for (const chatId of [undefined, '', 1]) {
      const refused = await ask(chrome, { type: 'panel', method: 'send', params: { chatId, tab: { id: tab.id } } }, sender);
      assert.match((refused as any).error, /Choose a chat/);
      assert.equal(bg.sessions.admissions.grants.size, 0);
    }
    const follow = ask(chrome, { type: 'panel', method: 'send', params: { chatId: 'chat', text: 'Again', tab: { id: tab.id } } }, sender);
    await tick();
    const sent = ws.sent.at(-1);
    assert.equal(bg.sessions.admissions.grants.get(sent.params.tab.grant)?.targetChat, 'chat');
    assert.ok(sent.params.deadline > Date.now());
    assert.ok(sent.params.deadline < Date.now() + 15_000);
    await ws.from({ type: 'panel', id: sent.id, result: {} });
    await follow;
  } finally {
    warn.mock.restore();
    bg.client.dispose();
  }
});

test('connection waits recheck the service and previous owner, and malformed or obsolete native replies stay degraded', async () => {
  for (const mode of ['busy', 'service-before', 'service-after', 'missing-receipt', 'legacy']) {
    const w = setup();
    const original = w.live.chromeRelay;
    if (['busy', 'service-before'].includes(mode))
      original.relay.connect = async () => {
        if (mode === 'busy') w.live.sessions.running = () => true;
        else w.live.chromeRelay = { ...original };
        return w.link;
      };
    if (mode === 'service-after')
      w.link.send = async () => {
        w.live.chromeRelay = { ...original };
        return { membership: 'receipt' };
      };
    if (mode === 'missing-receipt') {
      w.link.send = async () => ({});
      w.tab.backend.membership = undefined as any;
    }
    if (mode === 'legacy')
      w.link.send = async () => {
        throw new Error('Chrome refused session.adopt: session.adopt is not a command');
      };
    const reply = await preparePanelTab(w.live, 'chat', 'Use this page', { ...grant, owner: 'other' });
    assert.ok(reply.warning, mode);
    assert.equal(reply.target, undefined);
    if (mode === 'legacy') assert.match(reply.warning, /Update the MoPilot Chrome extension/);
    if (['busy', 'service-before'].includes(mode)) assert.equal(w.calls.length, 0);
  }
});

test('an initially refused dispatch retains its created chat and draft so retry sends into that chat', async () => {
  const { panelPage } = await import('./support/side-panel-page.ts');
  const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');
  const { tick } = await import('./support/extension-background/fixture.ts');
  const p = panelPage();
  const send = p.chrome.runtime.sendMessage;
  const seen: any[] = [];
  p.chrome.runtime.sendMessage = async (m: any) => {
    seen.push(m);
    return m.method === 'start' ? { status: 'connected', result: { chatId: 'created-chat', error: 'Transport unavailable' } } : send(m);
  };
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'Keep this draft';
  await p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  assert.equal(p.els.text.value, 'Keep this draft');
  assert.equal(p.els.error.textContent, 'Transport unavailable');
  await p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  const methods = seen.filter((m: any) => ['start', 'send'].includes(m.method));
  assert.deepEqual(
    methods.map((m: any) => m.method),
    ['start', 'send'],
  );
  assert.equal(methods[1].params.chatId, 'created-chat');
  assert.equal(p.els.text.value, '');
});

test('an old pending start cannot replace a newly selected panel conversation or its draft', async () => {
  const { panelPage } = await import('./support/side-panel-page.ts');
  const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');
  const { tick } = await import('./support/extension-background/fixture.ts');
  const p = panelPage();
  const send = p.chrome.runtime.sendMessage;
  let finish: any;
  p.chrome.runtime.sendMessage = (m: any) =>
    m.method === 'start'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : send(m);
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'First';
  const pending = p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  p.els.new.listeners.click();
  p.els.text.value = 'New draft';
  p.els.text.listeners.input();
  finish({ status: 'connected', result: { chatId: 'old-created-chat' } });
  await pending;
  await tick();
  assert.equal(p.els.text.value, 'New draft');
  assert.ok(!p.sent().some((m: any) => m.method === 'read' && m.params.chatId === 'old-created-chat'));
});

test('a retired capability-plan lookup degrades visibly before any native admission effect', async () => {
  const w = setup();
  w.live.controllerPlans.snapshot = () => {
    throw new Error('The chat was retired');
  };
  const result = await preparePanelTab(w.live, 'chat', 'Read this', grant);
  assert.match(result.warning, /chat was retired/);
  assert.match(result.text, /Do not reopen/);
  assert.equal(w.calls.length, 0);
});

test('panel sends into one chat preserve acceptance order across a slow handoff, and failure leaves later sends usable', async () => {
  const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
  let release: any;
  const events: string[] = [];
  const panel = new ChromePanel({
    send: async (p: any) => {
      events.push(p.text);
      if (p.text === 'first') {
        await new Promise((resolve) => {
          release = resolve;
        });
        throw new Error('Failed first');
      }
    },
  });
  const replies: any[] = [];
  const send = (chatId: string, text: string, id: number) =>
    panel.handle({ id, method: 'send', params: { chatId, text } }, (reply: any) => replies.push(reply));
  const first = send('chat', 'first', 1);
  const second = send('chat', 'second', 2);
  await send('independent', 'other', 3);
  assert.deepEqual(events, ['first', 'other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'other', 'second']);
  assert.equal(replies.find((r) => r.id === 1).error, 'Failed first');
  assert.equal(replies.find((r) => r.id === 2).result.sent, true);
  assert.equal(panel.sends.size, 0);
});

test('Stop retires both a pending handoff send and older queued sends, while a fresh send remains usable', async () => {
  const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
  let release: any;
  const delivered: string[] = [];
  const panel = new ChromePanel({
    stop: async () => {},
    send: async (p: any, assertCurrent: () => void) => {
      if (p.text === 'first')
        await new Promise((resolve) => {
          release = resolve;
        });
      assertCurrent();
      delivered.push(p.text);
    },
  });
  const ask = (id: number, method: string, text?: string) =>
    new Promise<any>((resolve) => {
      void panel.handle({ id, method, params: { chatId: 'chat', text } }, resolve);
    });
  const first = ask(1, 'send', 'first');
  const second = ask(2, 'send', 'second');
  await new Promise((resolve) => setImmediate(resolve));
  await ask(3, 'stop');
  const fresh = ask(4, 'send', 'after Stop');
  release();
  assert.match((await first).error, /stopped before/);
  assert.match((await second).error, /stopped before/);
  assert.equal((await fresh).result.sent, true);
  assert.deepEqual(delivered, ['after Stop']);
});

test('an outer panel deadline fences native effects and expires queued sends before delivery', async (t) => {
  const w = setup();
  t.mock.method(Date, 'now', () => 1000);
  const ready = await preparePanelTab(w.live, 'chat', 'Read', grant, 2000);
  assert.equal(ready.warning, null);
  assert.equal(w.calls[0][1][0].deadline, 2000);
  w.calls.length = 0;
  const expired = await preparePanelTab(w.live, 'chat', 'Read', grant, 999);
  assert.match(expired.warning, /too long/);
  assert.equal(w.calls.length, 0);
  const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
  const delivered: any[] = [];
  const panel = new ChromePanel({
    usable: async () => true,
    start: async (p: any) => {
      delivered.push(p);
      return 'new';
    },
    send: async (p: any) => {
      delivered.push(p);
    },
  });
  const ask = (method: string, deadline: number) =>
    new Promise<any>((resolve) => {
      void panel.handle({ id: 1, method, params: { harness: 'claude', chatId: 'chat', text: 'Hello', deadline } }, resolve);
    });
  assert.equal((await ask('start', 2000)).result.chatId, 'new');
  assert.equal(delivered.at(-1).deadline, 2000);
  assert.equal((await ask('send', 2000)).result.sent, true);
  assert.equal(delivered.at(-1).deadline, 2000);
  assert.match((await ask('send', 999)).error, /too long/);
  assert.equal(delivered.length, 2);
});
