// Panel delivery uses the real controller's native receipts: a dispatch-time page loss stays queued once and is visible to the person.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup } from './support/controller/fixture.ts';
import { world } from './support/chrome-membership-kit.mjs';
const require = createRequire(import.meta.url);
const { createChromePanel, projectsFileOf } = require('../electron/app/chromePanel.cjs');
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');
const { installHandoffContinuationGuard } = require('../electron/capabilities/browser/handoffContinuation.cjs');

test('an ordinary send id keeps an exception after the production admission marker uncertain instead of dispatching twice', async (t) => {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('chat', { id: 'chat', segments: [{ kind: 'codex', nativeId: 'native' }], meta: {} });
  const live = { chats: h.chats, controller: h.c, peerRuntime: { readReference: async () => ({ turns: [] }) } };
  let sends = 0;
  const panel = createChromePanel({
    live,
    claude: {},
    sources: {},
    home: h.chats.dir,
    projectsFile: projectsFileOf(h.chats.dir),
    prefs: () => ({}),
    usable: async () => true,
    starter: {},
    open: () => {},
    send: async () => {
      sends++;
      throw new Error('acknowledgment lost');
    },
  });
  const params = { chatId: 'chat', text: 'hello', sendId: 'send-0001' };
  for (let n = 0; n < 4; n++) await assert.rejects(panel.service.call({ kind: 'panel' }, 'chat.send', params), { code: 'send_uncertain' });
  assert.equal(sends, 1);
});

for (const kind of ['codex', 'claude', 'acp:gemini'])
  test(`${kind}: a failed native page dispatch returns one retained-input warning`, async (t) => {
    const h = setup();
    const w = world();
    t.after(() => {
      w.tabs.dispose();
      fs.rmSync(h.chats.dir, { recursive: true, force: true });
    });
    h.chats.records.set('chat', { id: 'chat', segments: [{ kind, nativeId: 'native' }], meta: {} });
    const live: any = {
      chats: h.chats,
      controller: h.c,
      sessions: h.state,
      controllerPlans: { snapshot: () => ({ key: h.c.ref('chat').key, plan: { bu: 'mopilot-chrome' } }) },
      chromeRelay: { kind: 'extension', relay: w.relay, tabs: w.tabs },
      peerRuntime: { readReference: async () => ({ turns: [], earlierContentOmitted: false }) },
    };
    installHandoffContinuationGuard(live, () => 'extension');
    const tab = w.chrome.addTab({ url: 'https://example.org/draft' });
    h.c.beforeDispatch = async () => w.move(tab.id, -1);
    const panel = createChromePanel({
      live,
      claude: {},
      sources: {},
      home: h.chats.dir,
      projectsFile: projectsFileOf(h.chats.dir),
      prefs: () => ({}),
      usable: async () => true,
      starter: {},
      send: (id: string, item: any) => h.c.send(id, item, null, true),
      open: () => {},
    });
    const grant = await w.sessions.admissions.offer(tab.id);
    const reply: any = await new Promise((resolve) => {
      void panel.handle({ id: 1, method: 'send', params: { chatId: 'chat', text: 'Read this', tab: grant } }, resolve);
    });
    assert.equal(reply.error, undefined);
    assert.match(reply.result.warning, /Your message is queued/);
    assert.match(reply.result.warning, /no longer available/);
    assert.equal(h.state.get('chat').queue.length, 1);
    assert.equal(h.execs.length, 0);
    assert.equal(h.state.get('chat').queue[0].opts.chromePanelTab.tabId, tab.id);
  });

test('a Stop from the real app controller retires a pending panel send before delivery', async (t) => {
  const h = setup();
  t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
  h.chats.records.set('chat', { id: 'chat', segments: [{ kind: 'codex', nativeId: 'native' }] });
  let release: any;
  let sent = false;
  const panel = new ChromePanel({
    sendCheck: (id: string) => h.c.stopCheck(id),
    send: async (_p: any, check: () => void) => {
      await new Promise((resolve) => {
        release = resolve;
      });
      check();
      sent = true;
    },
  });
  const pending = new Promise<any>((resolve) => {
    void panel.handle({ id: 1, method: 'send', params: { chatId: 'chat', text: 'Later' } }, resolve);
  });
  await new Promise((resolve) => setImmediate(resolve));
  h.c.noteStop('chat');
  release();
  assert.match((await pending).error, /stopped/i);
  assert.equal(sent, false);
});

for (const outcome of ['held', 'discarded'])
  test(`a real ${outcome} receipt is reported without restoring a second draft`, async (t) => {
    const h = setup({ auto: false });
    t.after(() => fs.rmSync(h.chats.dir, { recursive: true, force: true }));
    h.chats.records.set('chat', { id: 'chat', segments: [{ kind: 'codex', nativeId: 'native' }], meta: {} });
    const live = { chats: h.chats, controller: h.c, peerRuntime: { readReference: async () => ({ turns: [] }) } };
    const panel = createChromePanel({
      live,
      claude: {},
      sources: {},
      home: h.chats.dir,
      projectsFile: projectsFileOf(h.chats.dir),
      prefs: () => ({}),
      usable: async () => true,
      starter: {},
      send: (id: string, item: any) => h.c.send(id, item, null, true),
      open: () => {},
    });
    const pending = new Promise<any>((resolve) => {
      void panel.handle({ id: 1, method: 'send', params: { chatId: 'chat', text: 'Hello' } }, resolve);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.execs.length, 1);
    h.execs[0].done({ [outcome]: true });
    const response = await pending;
    assert.equal(response.error, undefined);
    assert.match(response.result.warning, outcome === 'held' ? /waiting to be sent/ : /discarded/);
    if (outcome === 'discarded') assert.match(response.result.warning, /Message: Hello/);
    assert.equal(h.state.get('chat').queue.length, 0);
  });

test('the actual shared session store refuses an existing page owned by a running or waiting chat', async (t) => {
  const { preparePanelTab } = require('../electron/capabilities/browser/chromePanelTab.cjs');
  const h = setup();
  const w = world();
  t.after(() => {
    w.tabs.dispose();
    fs.rmSync(h.chats.dir, { recursive: true, force: true });
  });
  const tab = w.chrome.addTab({ url: 'https://example.org/working' });
  const owner = await w.relay.connect('other');
  await owner.send('session.adopt', [await w.sessions.admissions.offer(tab.id)]);
  for (const turn of ['running', 'awaitingUser']) {
    h.state.patch('other', { turn });
    const reply = await preparePanelTab(
      {
        sessions: h.state,
        chromeRelay: { kind: 'extension', relay: w.relay, tabs: w.tabs },
        controllerPlans: { snapshot: () => ({ key: 'key', plan: { bu: 'mopilot-chrome' } }) },
      },
      'chat',
      'Read',
      await w.sessions.admissions.offer(tab.id),
    );
    assert.match(reply.warning, /Another chat is working/);
    assert.equal(w.sessions.owner.get(tab.id), 'other');
  }
});
