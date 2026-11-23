// Chrome's side panel, the extension's end: the request link (src/panelLink.mjs) and the panel page (src/sidePanel.mjs) on a fake DOM.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { panelPage } from './support/side-panel-page.ts';
import { fakeTimers, tick } from './support/extension-background/fixture.ts';

const { PanelLink, REQUEST_MS, START_MS, TRANSCRIBE_MS } = await import('../electron/chrome-extension/src/panelLink.mjs');
const { startSidePanel, stateOf, tabOf, pickHarness, STATES, HARNESS_AGAIN_MS } = await import(
  '../electron/chrome-extension/src/sidePanel.mjs'
);

test('the link sends a request only while connected, matches each answer by id, and every wait ends', async () => {
  const sent: any[] = [];
  const timers: any = fakeTimers();
  let up = false;
  const events: any[] = [];
  const link = new PanelLink({ send: (m) => sent.push(m), connected: () => up, event: (e) => events.push(e), timers });
  await assert.rejects(link.request('recent'), /MoPilot isn't connected\./);
  assert.equal(sent.length, 0);
  up = true;
  const a = link.request('recent', { limit: 3 });
  const b = link.request('start', { text: 'x' });
  const c = link.request('harnesses');
  const clip = link.request('transcribe');
  assert.deepEqual(sent, [
    { type: 'panel', id: 1, method: 'recent', params: { limit: 3 } },
    { type: 'panel', id: 2, method: 'start', params: { text: 'x' } },
    { type: 'panel', id: 3, method: 'harnesses', params: {} },
    { type: 'panel', id: 4, method: 'transcribe', params: {} },
  ]);
  // a new chat may start its harness first, and a clip may be tried on several dictation services: they wait longer
  assert.deepEqual(
    timers.timeouts.slice(-4).map((t: any) => t.ms),
    [REQUEST_MS, START_MS, REQUEST_MS, TRANSCRIBE_MS],
  );
  link.receive({ type: 'panel', id: 4, result: { text: 'hi' } });
  assert.deepEqual(await clip, { text: 'hi' });
  link.receive({ type: 'panel', id: 2, error: 'Pick a harness for the new chat.' });
  link.receive({ type: 'panel', id: 1, result: { chats: [] } });
  link.receive({ type: 'panel', id: 1, result: 'late' });
  link.receive({ type: 'panel', id: 99, result: {} });
  link.receive(null);
  link.receive({ type: 'panel', event: { kind: 'turn', chatId: 'c', state: 'idle' } });
  assert.deepEqual(await a, { chats: [] });
  await assert.rejects(b, /Pick a harness/);
  assert.deepEqual(events, [{ kind: 'turn', chatId: 'c', state: 'idle' }]);
  // no answer in time
  timers.timeouts.find((t: any) => t.ms === REQUEST_MS)?.f();
  await assert.rejects(c, /didn't answer/);
  // the connection goes: what still waits ends at once
  const d = link.request('open');
  link.drop();
  await assert.rejects(d, /went away/);
  link.receive({ type: 'panel', id: 5, result: {} });
  // an answer with neither result nor error is an empty result; updates with no listener are dropped
  const quiet = new PanelLink({ send: () => undefined, connected: () => true, timers });
  const e = quiet.request('open');
  quiet.receive({ id: 1 });
  assert.deepEqual(await e, {});
  quiet.receive({ event: { kind: 'status' } });
});

test('until it is connected the panel shows one state and the button that moves it on', async () => {
  for (const [status, extra, title, act] of [
    ['offline', {}, "MoPilot isn't running", 'Open MoPilot'],
    ['offline', { starting: true }, 'Starting MoPilot…', ''],
    ['unpaired', {}, 'Connect to MoPilot', 'Connect'],
    ['unauthorized', {}, 'Connect to MoPilot', 'Connect'],
    ['unpaired', { asking: true }, 'Allow this Chrome in MoPilot', ''],
    ['connecting', {}, 'Connecting…', ''],
    ['weird', {}, 'Connecting…', ''],
  ] as const) {
    const p = panelPage({ reply: () => ({ status, ...extra }) });
    await startSidePanel(p.g).ready;
    assert.equal(p.els.state.hidden, false, status);
    assert.equal(p.els.composer.hidden, true);
    assert.equal(p.els['state-title'].textContent, title);
    assert.equal(p.els['state-act'].hidden, !act);
    assert.equal(p.els['state-act'].textContent, act);
    assert.equal(p.els.title.textContent, 'MoPilot');
    // it is asked again while the state may change by itself
    assert.ok(p.timers.timeouts.length > 0, status);
  }
  assert.equal(stateOf({ status: 'connected', asking: true }), null);
  assert.equal(stateOf(undefined), STATES.connecting);
  // Open MoPilot starts it; the panel then follows it starting
  const p = panelPage({
    reply: (m: any) =>
      m.type === 'launch' ? { status: 'offline', starting: true } : { status: 'offline', error: 'Open MoPilot from Applications.' },
  });
  await startSidePanel(p.g).ready;
  assert.equal(p.els['state-text'].textContent, 'Open MoPilot from Applications.');
  p.els['state-act'].listeners.click({ currentTarget: p.els['state-act'] });
  await tick();
  assert.deepEqual(p.sent().at(-1), { type: 'launch' });
  assert.equal(p.els['state-title'].textContent, 'Starting MoPilot…');
  assert.equal(p.els['state-text'].textContent, 'This takes a few seconds.');
  // a state with no button does nothing on a stray click
  const before = p.sent().length;
  p.els['state-act'].listeners.click({ currentTarget: { dataset: {} } });
  assert.equal(p.sent().length, before);
  // the follow-up asks again; the connection changing asks at once
  p.timers.timeouts.at(-1)!.f();
  await tick();
  assert.deepEqual(p.sent().at(-1), { type: 'status' });
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'status', status: 'connected' } });
  await tick();
  assert.equal(p.els.state.hidden, false);
  p.chrome.runtime.onMessage.fire({ type: 'other' });
});

test('connected: a new chat with the current tab, the harness picked last, sent with Enter; its turn shows under it', async () => {
  const p = panelPage();
  await p.chrome.storage.local.set({ panelHarness: 'codex' });
  await startSidePanel(p.g).ready;
  await tick();
  assert.equal(p.els.state.hidden, true);
  assert.equal(p.els.composer.hidden, false);
  assert.equal(p.els.empty.hidden, false);
  assert.equal(p.els.chat.hidden, true);
  assert.equal(p.els.title.textContent, 'New chat');
  assert.deepEqual(
    p.els.harness.children.map((o: any) => [o.value, o.textContent]),
    [
      ['claude', 'Claude Code'],
      ['codex', 'Codex'],
    ],
  );
  assert.equal(p.els.harness.value, 'codex');
  assert.equal(p.els.tab.hidden, false);
  assert.equal(p.els['tab-title'].textContent, 'Hacker News');
  assert.equal(p.els['tab-icon'].src, 'https://news.ycombinator.com/favicon.ico');
  assert.equal(p.els.send.disabled, true, 'nothing typed');
  // Typing enables Send without sending anything automatically.
  p.els.text.value = 'Summarize this page.';
  p.els.text.listeners.input();
  assert.equal(p.els.text.value, 'Summarize this page.');
  assert.equal(p.els.send.disabled, false);
  // Shift+Enter is a new line; Enter sends
  const shift = { key: 'Enter', shiftKey: true, preventDefault: mock.fn() };
  p.els.text.listeners.keydown(shift);
  assert.equal(shift.preventDefault.mock.callCount(), 0);
  p.els.text.listeners.keydown({ key: 'a', preventDefault: () => undefined });
  p.els.text.listeners.keydown({ key: 'Enter', preventDefault: () => undefined });
  await tick();
  const start = p.sent().find((m: any) => m.method === 'start');
  assert.deepEqual(start, {
    type: 'panel',
    method: 'start',
    params: {
      retainOnError: true,
      harness: 'codex',
      text: 'Summarize this page.',
      tab: { id: 500, url: 'https://news.ycombinator.com/', title: 'Hacker News' },
    },
  });
  assert.equal(p.chrome.store.local.panelHarness, 'codex');
  assert.equal(p.els.text.value, '');
  assert.equal(p.els.chat.hidden, false);
  assert.equal(p.els.empty.hidden, true);
  // shown at once, and kept while MoPilot's history doesn't have it yet
  assert.deepEqual(
    p.els.rows.children.map((r: any) => [r.className, r.textContent]),
    [['you', 'Summarize this page.']],
  );
  assert.deepEqual(
    p.sent().find((m: any) => m.method === 'read'),
    { type: 'panel', method: 'read', params: { chatId: 'chat-9' } },
  );
  assert.equal(p.els.title.textContent, 'Summarize this page.');
  assert.equal(p.els['progress-text'].textContent, 'Working…');
  // its turn as MoPilot reports it; another chat's is not this one's
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'turn', chatId: 'chat-9', state: 'waiting' } });
  assert.equal(p.els['progress-text'].textContent, 'Waiting for you');
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'turn', chatId: 'other', state: 'idle' } });
  assert.equal(p.els['progress-text'].textContent, 'Waiting for you');
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'turn', chatId: 'chat-9', state: 'idle' } });
  assert.equal(p.els['progress-dot'].className, 'dot ok');
  p.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'turn', chatId: 'chat-9', state: '?' } });
  assert.equal(p.els['progress-text'].textContent, 'Working…');
  // ↗ opens this chat in MoPilot; + starts over
  p.els.app.listeners.click();
  await tick();
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => m.method === 'open')
      .at(-1),
    { type: 'panel', method: 'open', params: { chatId: 'chat-9' } },
  );
  p.els.new.listeners.click();
  assert.equal(p.els.chat.hidden, true);
  assert.equal(p.els.empty.hidden, false);
  assert.equal(p.els.title.textContent, 'New chat');
  // the form's own submit sends too, and an empty box sends nothing
  const submit = { preventDefault: mock.fn() };
  const count = p.sent().length;
  p.els.composer.listeners.submit(submit);
  await tick();
  assert.equal(submit.preventDefault.mock.callCount(), 1);
  assert.equal(p.sent().length, count);
  p.els.harness.listeners.change();
  p.els.app.listeners.click();
  await tick();
  assert.deepEqual(p.sent().at(-1), { type: 'panel', method: 'open', params: {} });
});

test('the tab chip follows the tab in front, can be left out, and comes back on another tab', async () => {
  const p = panelPage();
  await startSidePanel(p.g).ready;
  await tick();
  p.els['tab-off'].listeners.click();
  assert.equal(p.els['tab-off'].textContent, 'Include this tab');
  p.els.text.value = 'hi';
  p.els.text.listeners.input();
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  assert.deepEqual(p.sent().find((m: any) => m.method === 'start').params, { retainOnError: true, harness: 'claude', text: 'hi' });
  // the same tab changing its title keeps it left out; another tab brings the chip back
  const t = [...p.chrome.tabsById.values()][0];
  t.title = 'HN';
  p.chrome.tabs.onUpdated.fire(t.id, { title: 'HN' }, t);
  await tick();
  assert.equal(p.els['tab-off'].textContent, 'Include this tab');
  t.active = false;
  const settings = p.chrome.addTab({ active: true, title: 'Settings', url: 'chrome://settings' });
  p.chrome.tabs.onActivated.fire({ tabId: settings.id });
  await tick();
  assert.equal(p.els.tab.hidden, true, 'not a web page');
  settings.url = 'https://example.com/';
  settings.title = '';
  settings.favIconUrl = 'data:image/png;base64,x';
  p.chrome.tabs.onUpdated.fire(settings.id, { url: settings.url }, settings);
  await tick();
  assert.equal(p.els.tab.hidden, false);
  assert.equal(p.els['tab-title'].textContent, 'https://example.com/');
  assert.equal(p.els['tab-icon'].hidden, true, 'only a web icon');
  // a change in a tab that isn't in front, or one that changes nothing shown, is not read
  const reads = p.chrome.log.filter((l: any) => l[0] === 'tabs.query').length;
  p.chrome.tabs.onUpdated.fire(t.id, { title: 'x' }, { active: false });
  p.chrome.tabs.onUpdated.fire(settings.id, { status: 'complete' }, settings);
  await tick();
  assert.equal(p.chrome.log.filter((l: any) => l[0] === 'tabs.query').length, reads);
  assert.equal(tabOf(undefined), null);
});

test('a failed request is said where it happened; a refused send keeps its text; no sidebar while not connected', async () => {
  // no chats yet; then MoPilot refusing: the line says so
  const empty = panelPage({
    reply: (m: any) => ({ status: 'connected', result: m.method === 'harnesses' ? { harnesses: [] } : { chats: [] } }),
  });
  await startSidePanel(empty.g).ready;
  await tick();
  assert.equal(empty.els.error.textContent, 'No harness can start a chat now. Check Settings in MoPilot.');
  assert.equal(empty.els.error.hidden, false);
  const failing = panelPage({
    reply: (m: any) => (m.type === 'panel' ? { status: 'connected', error: 'MoPilot went away. Try again.' } : { status: 'connected' }),
  });
  await startSidePanel(failing.g).ready;
  await tick();
  assert.equal(failing.els.error.textContent, 'MoPilot went away. Try again.');
  failing.els.app.listeners.click();
  await tick();
  // a send MoPilot refuses keeps the text to send again
  failing.els.text.value = 'keep me';
  failing.els.harness.value = 'claude';
  failing.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  assert.equal(failing.els.text.value, 'keep me');
  assert.equal(failing.els.chat.hidden, true);
  // the harness list is read again once it failed (HARNESS_AGAIN_MS)
  const reads = failing.sent().filter((m: any) => m.method === 'harnesses').length;
  failing.timers.timeouts.find((t: any) => t.ms === HARNESS_AGAIN_MS)!.f();
  await tick();
  assert.ok(failing.sent().filter((m: any) => m.method === 'harnesses').length > reads);
  // the sidebar doesn't open while not connected
  const off = panelPage({ reply: () => ({ status: 'offline' }) });
  await startSidePanel(off.g).ready;
  off.els.title.listeners.click();
  await tick();
  assert.equal(off.els.sidebar.hidden, true);
  assert.equal(off.els.side.hidden, true);
});

test('the harness picked last stays picked while offered; a page with no tab in front offers none', async () => {
  assert.equal(pickHarness([{ id: 'claude' }, { id: 'codex' }], 'codex'), 'codex');
  assert.equal(pickHarness([{ id: 'claude' }], 'codex'), 'claude');
  assert.equal(pickHarness([], 'codex'), '');
  const p = panelPage({ tab: null });
  await startSidePanel(p.g).ready;
  assert.equal(p.els.tab.hidden, true);
  // a second send while one is on its way is not sent twice
  p.els.text.value = 'once';
  p.els.harness.value = 'claude';
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  p.els.composer.listeners.submit({ preventDefault: () => undefined });
  await tick();
  assert.equal(p.sent().filter((m: any) => m.method === 'start').length, 1);
});

test('the side panel entry starts the panel in its window', async () => {
  const p = panelPage();
  const g = globalThis as any;
  const saved = { chrome: g.chrome, document: g.document, addEventListener: g.addEventListener };
  const closes: (() => void)[] = [];
  let initialized = false;
  const ui = mock.module('../electron/chrome-extension/src/panelChrome.mjs', {
    namedExports: {
      PanelChrome: class {
        constructor(surface: any) {
          assert.equal(surface, g);
          initialized = true;
        }
        close() {
          initialized = false;
        }
      },
    },
  });
  Object.assign(g, {
    chrome: p.chrome,
    document: p.g.document,
    addEventListener: (event: string, fn: () => void) => {
      if (event === 'pagehide') closes.push(fn);
    },
  });
  try {
    await import('../electron/chrome-extension/sidepanel.mjs');
    await tick();
    assert.ok(p.els.composer.listeners.submit);
    assert.equal(initialized, true);
    closes.forEach((close) => close());
    assert.equal(initialized, false);
  } finally {
    ui.restore();
    Object.assign(g, saved);
  }
});

test('a harness list that failed is asked for again while connected, and on the next connection otherwise', async () => {
  let fail = true;
  let status = 'connected';
  const p = panelPage({
    reply: (m: any) =>
      m.type !== 'panel'
        ? { status }
        : fail
          ? { status, error: "MoPilot didn't answer. Try again." }
          : { status, result: { harnesses: [{ id: 'codex', label: 'Codex' }] } },
  });
  await startSidePanel(p.g).ready;
  await tick();
  const again = (x: any) => x.timers.timeouts.find((t: any) => t.ms === HARNESS_AGAIN_MS);
  fail = false;
  again(p).f();
  await tick();
  await tick();
  assert.deepEqual(
    p.els.harness.children.map((o: any) => o.value),
    ['codex'],
  );
  // failing while the connection then goes down: asked once it is back
  fail = true;
  const q = panelPage({ reply: p.chrome.reply });
  await startSidePanel(q.g).ready;
  await tick();
  status = 'offline';
  q.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'status' } });
  await tick();
  const n = q.sent().filter((m: any) => m.method === 'harnesses').length;
  again(q).f();
  await tick();
  assert.equal(q.sent().filter((m: any) => m.method === 'harnesses').length, n, 'not while offline');
  status = 'connected';
  fail = false;
  q.chrome.runtime.onMessage.fire({ type: 'panelEvent', event: { kind: 'status' } });
  await tick();
  await tick();
  assert.ok(q.sent().filter((m: any) => m.method === 'harnesses').length > n);
});

test("the Harness rows in the model menu pick the next new chat's harness, and its menus follow", async () => {
  const p = panelPage({
    reply: (m: any) =>
      m.type !== 'panel'
        ? { status: 'connected' }
        : m.method === 'harnesses'
          ? {
              status: 'connected',
              result: {
                harnesses: [
                  { id: 'claude', label: 'Claude Code' },
                  { id: 'codex', label: 'Codex' },
                ],
              },
            }
          : m.method === 'options'
            ? { status: 'connected', result: { models: [], model: null, effort: null, harness: m.params.harness, permission: null } }
            : { status: 'connected', result: {} },
  });
  await startSidePanel(p.g).ready;
  await tick();
  await tick();
  // the menu opens on the effort; its title row leads to the harnesses
  p.els.model.listeners.click();
  p.els['model-rows'].children[0].listeners.click();
  const row = p.els['model-rows'].children.find((c: any) => c.children[0]?.textContent === 'Codex');
  row.listeners.click();
  await tick();
  assert.equal(p.els.harness.value, 'codex');
  assert.deepEqual(
    p
      .sent()
      .filter((m: any) => m.method === 'options')
      .at(-1).params,
    { harness: 'codex' },
  );
});
